import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FieldValue } from 'firebase-admin/firestore';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const state = vi.hoisted(() => ({
  createdMessages: [] as Record<string, unknown>[],
  failSet: false,
  throwNotConfigured: false,
}));

vi.mock('./firebase/admin', async () => {
  const { ServerNotConfiguredError } = await import('./errors');

  async function verifyIdToken(
    token: string
  ): Promise<{ uid: string; email?: string }> {
    if (token === 'valid-customer') {
      return { uid: 'cust-1', email: 'customer@example.com' };
    }
    if (token === 'valid-customer-2') {
      return { uid: 'cust-2', email: 'customer2@example.com' };
    }
    throw new Error('invalid token');
  }

  return {
    firebaseReady: () => true,
    requireFirebase: () => {
      if (state.throwNotConfigured) {
        throw new ServerNotConfiguredError();
      }
      return {
        auth: { verifyIdToken },
        db: {
          doc: (docPath: string) => ({
            get: async () => {
              if (docPath.startsWith('users/')) {
                return {
                  exists: true,
                  data: () => ({ role: 'customer' }),
                };
              }
              return { exists: false, data: () => undefined };
            },
          }),
          collection: (name: string) => ({
            doc: (id?: string) => ({
              id: id ?? 'msg-1',
              set: async (payload: Record<string, unknown>) => {
                if (name !== 'contactMessages') {
                  return;
                }
                if (state.failSet) {
                  throw new Error('firestore write failed');
                }
                state.createdMessages.push(payload);
              },
            }),
          }),
        },
      };
    },
    resetFirebaseForTests: () => undefined,
  };
});

import { createApp } from './app';

function contactBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Juan dela Cruz',
    email: 'juan@example.com',
    subject: 'Order question',
    message: 'Hello, where is my order?',
    ...overrides,
  };
}

describe('POST /api/contact-messages (Contact Us form)', () => {
  let server: Server;
  let base: string;

  function post(body: unknown, token: string | null = 'valid-customer') {
    return fetch(`${base}/api/contact-messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    state.createdMessages = [];
    state.failSet = false;
    state.throwNotConfigured = false;

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('stores a valid submission and trims surrounding whitespace', async () => {
    const response = await post(
      contactBody({
        name: '  Juan dela Cruz  ',
        email: '  juan@example.com  ',
        subject: '  Order question  ',
        message: '  Hello, where is my order?  ',
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['id']).toBe('msg-1');
    expect(body['status']).toBe('NEW');

    expect(state.createdMessages).toHaveLength(1);
    const stored = state.createdMessages[0];
    expect(stored['id']).toBe('msg-1');
    expect(stored['name']).toBe('Juan dela Cruz');
    expect(stored['email']).toBe('juan@example.com');
    expect(stored['subject']).toBe('Order question');
    expect(stored['message']).toBe('Hello, where is my order?');
    expect(stored['userId']).toBe('cust-1');
    expect(stored['status']).toBe('NEW');
    expect(stored['createdAt']).toBeInstanceOf(FieldValue);
    expect(stored['updatedAt']).toBeInstanceOf(FieldValue);
  });

  it('ignores client-supplied userId, status, timestamps and id', async () => {
    const response = await post(
      contactBody({
        userId: 'admin-1',
        status: 'RESOLVED',
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z',
        id: 'forged-id',
      })
    );
    expect(response.status).toBe(201);

    expect(state.createdMessages).toHaveLength(1);
    const stored = state.createdMessages[0];
    // Identity comes from the verified token; the rest is server-generated.
    expect(stored['userId']).toBe('cust-1');
    expect(stored['status']).toBe('NEW');
    expect(stored['createdAt']).toBeInstanceOf(FieldValue);
    expect(stored['updatedAt']).toBeInstanceOf(FieldValue);
    expect(stored['id']).toBe('msg-1');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['id']).toBe('msg-1');
    expect(body['status']).toBe('NEW');
  });

  it('rejects missing required fields', async () => {
    const response = await post({});
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: Array<{ field: string }> };
    };
    expect(body.error.code).toBe('invalid_request');
    const fields = (body.error.details ?? []).map((issue) => issue.field);
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('subject');
    expect(fields).toContain('message');
    expect(state.createdMessages).toHaveLength(0);
  });

  it('rejects an invalid email format', async () => {
    const response = await post(contactBody({ email: 'not-an-email' }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: Array<{ field: string }> };
    };
    expect(body.error.code).toBe('invalid_request');
    expect((body.error.details ?? []).map((issue) => issue.field)).toContain(
      'email'
    );
    expect(state.createdMessages).toHaveLength(0);
  });

  it('rejects empty and whitespace-only values', async () => {
    const response = await post(
      contactBody({ name: '   ', subject: '', message: ' \n\t ' })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: Array<{ field: string }> };
    };
    expect(body.error.code).toBe('invalid_request');
    const fields = (body.error.details ?? []).map((issue) => issue.field);
    expect(fields).toContain('name');
    expect(fields).toContain('subject');
    expect(fields).toContain('message');
    expect(state.createdMessages).toHaveLength(0);
  });

  it('rejects excessively long input', async () => {
    const response = await post(
      contactBody({
        name: 'n'.repeat(121),
        email: `e${'m'.repeat(260)}@example.com`,
        subject: 's'.repeat(151),
        message: 'm'.repeat(2001),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: Array<{ field: string }> };
    };
    expect(body.error.code).toBe('invalid_request');
    const fields = (body.error.details ?? []).map((issue) => issue.field);
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('subject');
    expect(fields).toContain('message');
    expect(state.createdMessages).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const response = await post(contactBody(), null);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(state.createdMessages).toHaveLength(0);
  });

  it('rejects invalid tokens', async () => {
    const response = await post(contactBody(), 'forged-token');
    expect(response.status).toBe(401);
    expect(state.createdMessages).toHaveLength(0);
  });

  it('returns an error (not false success) when Firestore storage fails', async () => {
    state.failSet = true;
    const response = await post(contactBody());
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body).not.toHaveProperty('id');
    expect(state.createdMessages).toHaveLength(0);
  });

  it('returns 503 when server credentials are missing', async () => {
    state.throwNotConfigured = true;
    const response = await post(contactBody());
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('server_not_configured');
    expect(state.createdMessages).toHaveLength(0);
  });

  describe('no access to stored messages', () => {
    it('has no list endpoint for unauthenticated users', async () => {
      const response = await fetch(`${base}/api/contact-messages`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });

    it('has no list endpoint for authenticated customers', async () => {
      const response = await fetch(`${base}/api/contact-messages`, {
        headers: { Authorization: 'Bearer valid-customer' },
      });
      expect(response.status).toBe(404);
    });

    it('has no per-message read endpoint', async () => {
      const response = await fetch(`${base}/api/contact-messages/msg-1`, {
        headers: { Authorization: 'Bearer valid-customer' },
      });
      expect(response.status).toBe(404);
    });

    it('has no update or delete endpoints', async () => {
      const patchResponse = await fetch(`${base}/api/contact-messages/msg-1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify({ status: 'RESOLVED' }),
      });
      expect(patchResponse.status).toBe(404);

      const deleteResponse = await fetch(`${base}/api/contact-messages/msg-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-customer' },
      });
      expect(deleteResponse.status).toBe(404);
    });
  });

  // The rate limiter is per-route and in-memory for the whole test process,
  // so the POSTs made by the tests above already fill the 10/min bucket and
  // this test observes the limit kicking in. Keep new POST tests above this
  // one and at most 10 in total so they are not rate limited themselves.
  it('rate limits after 10 requests per minute', async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 15 && !sawRateLimit; i += 1) {
      const response = await post(contactBody());
      if (response.status === 429) {
        sawRateLimit = true;
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe('rate_limited');
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
