import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const state = vi.hoisted(() => ({
  userRole: 'admin' as string | null,
  messages: new Map<string, Record<string, unknown>>(),
  updatedMessages: [] as { id: string; patch: Record<string, unknown> }[],
  throwNotConfigured: false,
  failUpdate: false,
  replyIdCounter: 0,
}));

vi.mock('./firebase/admin', async () => {
  const { ServerNotConfiguredError } = await import('./errors');

  async function verifyIdToken(
    token: string
  ): Promise<{ uid: string; email?: string }> {
    if (token === 'valid-admin') {
      return { uid: 'admin-1', email: 'admin@example.com' };
    }
    if (token === 'valid-customer') {
      return { uid: 'cust-1', email: 'customer@example.com' };
    }
    throw new Error('invalid token');
  }

  /**
   * Resolves the write-time sentinels the service sends so the mock store
   * behaves like Firestore: server timestamps become increasing clock
   * values, array unions append their elements.
   */
  function resolveWriteValue(value: unknown): unknown {
    const field = value as { methodName?: unknown; elements?: unknown[] } | null;
    if (
      field !== null &&
      typeof field === 'object' &&
      typeof field.methodName === 'string'
    ) {
      if (field.methodName === 'FieldValue.serverTimestamp') {
        return ts(10_000 + state.replyIdCounter++ * 1000);
      }
      if (field.methodName === 'FieldValue.arrayUnion') {
        return field.elements;
      }
    }
    return value;
  }

  function applyPatch(data: Record<string, unknown>, patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
      const resolved = resolveWriteValue(value);
      const existing = data[key];
      data[key] =
        Array.isArray(resolved) && Array.isArray(existing)
          ? [...existing, ...resolved]
          : resolved;
    }
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
                const role = state.userRole;
                return {
                  exists: role !== null,
                  data: () => (role !== null ? { role } : undefined),
                };
              }
              if (docPath.startsWith('contactMessages/')) {
                const id = docPath.slice('contactMessages/'.length);
                const data = state.messages.get(id);
                return { exists: data !== undefined, data: () => data };
              }
              return { exists: false, data: () => undefined };
            },
            update: async (patch: Record<string, unknown>) => {
              if (!docPath.startsWith('contactMessages/')) {
                return;
              }
              if (state.failUpdate) {
                throw new Error('firestore write failed');
              }
              const id = docPath.slice('contactMessages/'.length);
              state.updatedMessages.push({ id, patch });
              const data = state.messages.get(id);
              if (data) {
                applyPatch(data, patch);
              }
            },
          }),
          collection: (name: string) => ({
            // Reply ids are allocated with Firestore's document id generator
            // without writing anything.
            doc: () => ({ id: `reply-${++state.replyIdCounter}` }),
            get: async () => ({
              docs:
                name === 'contactMessages'
                  ? [...state.messages.entries()].map(([id, data]) => ({
                      id,
                      data: () => data,
                    }))
                  : [],
            }),
          }),
        },
      };
    },
    resetFirebaseForTests: () => undefined,
  };
});

import { createApp } from './app';

/** Minimal Firestore-timestamp stand-in understood by `toIso`/`timestampMs`. */
function ts(millis: number): { toMillis: () => number } {
  return { toMillis: () => millis };
}

function seedMessages(): Map<string, Record<string, unknown>> {
  return new Map<string, Record<string, unknown>>([
    [
      'msg-new',
      {
        id: 'msg-new',
        name: 'Juan dela Cruz',
        email: 'juan@example.com',
        subject: 'Order question',
        message: 'Where is my order?',
        userId: 'cust-1',
        status: 'NEW',
        createdAt: ts(4000),
        updatedAt: ts(4000),
      },
    ],
    [
      'msg-read',
      {
        id: 'msg-read',
        name: 'Maria Clara',
        email: 'maria@example.com',
        subject: 'Feedback',
        message: 'Great coffee!',
        userId: 'cust-1',
        status: 'READ',
        createdAt: ts(3000),
        updatedAt: ts(3500),
      },
    ],
    [
      'msg-resolved',
      {
        id: 'msg-resolved',
        name: 'Jose Rizal',
        email: 'jose@example.com',
        subject: 'Complaint',
        message: 'Cold drink.',
        userId: 'cust-2',
        status: 'RESOLVED',
        createdAt: ts(2000),
        updatedAt: ts(2500),
      },
    ],
  ]);
}

describe('POST /api/admin/contact-messages/:id/replies (admin replies)', () => {
  let server: Server;
  let base: string;

  function reply(
    id: string,
    body: unknown,
    token: string | null = 'valid-admin'
  ) {
    return fetch(`${base}/api/admin/contact-messages/${id}/replies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    state.userRole = 'admin';
    state.messages = seedMessages();
    state.updatedMessages = [];
    state.throwNotConfigured = false;
    state.failUpdate = false;
    state.replyIdCounter = 0;

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

  it('lets an authorized admin reply to an existing NEW message', async () => {
    const response = await reply('msg-new', { reply: ' It ships tomorrow.  ' });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      id: string;
      status: string;
      reply: { id: string; senderRole: string; reply: string; createdAt: string };
    };
    expect(body.id).toBe('msg-new');
    expect(body.status).toBe('READ');
    expect(body.reply.senderRole).toBe('ADMIN');
    expect(body.reply.reply).toBe('It ships tomorrow.');
    // The response timestamp is generated by the server clock.
    expect(Number.isNaN(Date.parse(body.reply.createdAt))).toBe(false);
    expect(body.reply.id).toBe('reply-1');

    expect(state.messages.get('msg-new')?.['status']).toBe('READ');
    const storedReplies = state.messages.get('msg-new')?.['replies'] as Array<
      Record<string, unknown>
    >;
    expect(storedReplies).toHaveLength(1);
    expect(storedReplies[0].id).toBe('reply-1');
    expect(storedReplies[0].senderRole).toBe('ADMIN');
    expect(storedReplies[0].reply).toBe('It ships tomorrow.');
    expect(storedReplies[0].createdAt).toBeInstanceOf(Date);

    expect(state.updatedMessages).toHaveLength(1);
  });

  it('does not auto-resolve and keeps READ/RESOLVED untouched', async () => {
    const read = await reply('msg-read', { reply: 'Checking on this.' });
    expect(read.status).toBe(201);
    const readBody = (await read.json()) as { status: string };
    expect(readBody.status).toBe('READ');
    expect(state.messages.get('msg-read')?.['status']).toBe('READ');

    const resolved = await reply('msg-resolved', { reply: 'Thank you!' });
    expect(resolved.status).toBe(201);
    const resolvedBody = (await resolved.json()) as { status: string };
    expect(resolvedBody.status).toBe('RESOLVED');
    expect(state.messages.get('msg-resolved')?.['status']).toBe('RESOLVED');
  });

  it('never stores client-supplied sender role, id or timestamps', async () => {
    const response = await reply('msg-new', {
      reply: 'A reply.',
      senderRole: 'CUSTOMER',
      id: 'forged-id',
      userId: 'cust-1',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    expect(response.status).toBe(201);

    const storedReplies = state.messages.get('msg-new')?.['replies'] as Array<
      Record<string, unknown>
    >;
    expect(storedReplies).toHaveLength(1);
    expect(storedReplies[0]).not.toHaveProperty('userId');
    // Id, role and timestamp are all decided by the server.
    expect(storedReplies[0].id).toBe('reply-1');
    expect(storedReplies[0].senderRole).toBe('ADMIN');
    expect(storedReplies[0].createdAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('only writes the reply, status and updatedAt fields', async () => {
    await reply('msg-new', { reply: 'A reply.' });
    const patch = state.updatedMessages[0].patch;
    expect(Object.keys(patch).sort()).toEqual(['replies', 'status', 'updatedAt']);
    expect(patch['status']).toBe('READ');
  });

  it('rejects empty and whitespace-only replies without writing', async () => {
    for (const text of ['', '   ', '\n\t ']) {
      const response = await reply('msg-new', { reply: text });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('invalid_request');
      expect((body.error.details ?? []).map((i) => i.field)).toContain('reply');
    }
    expect(state.updatedMessages).toHaveLength(0);
    expect(state.messages.get('msg-new')?.['replies']).toBeUndefined();
  });

  it('rejects replies longer than 5000 characters without writing', async () => {
    const response = await reply('msg-new', { reply: 'r'.repeat(5001) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(state.updatedMessages).toHaveLength(0);
    expect(state.messages.get('msg-new')?.['replies']).toBeUndefined();
  });

  it('accepts a reply of exactly 5000 characters', async () => {
    const response = await reply('msg-read', { reply: 'r'.repeat(5000) });
    expect(response.status).toBe(201);
  });

  it('rejects a body without a reply field', async () => {
    const response = await reply('msg-new', {});
    expect(response.status).toBe(400);
    const bodyJson = (await response.json()) as { error: { code: string } };
    expect(bodyJson.error.code).toBe('invalid_request');
    expect(state.updatedMessages).toHaveLength(0);
  });

  it('rejects a non-object JSON body', async () => {
    // express.json (strict mode) refuses non-object top-level JSON before
    // validation runs; the validator would reject it too.
    const response = await reply('msg-new', '"text"');
    expect(response.status).toBe(400);
    const bodyJson = (await response.json()) as { error: { code: string } };
    expect(bodyJson.error.code).toBe('invalid_json');
    expect(state.updatedMessages).toHaveLength(0);
  });

  it('rejects a non-string reply value', async () => {
    const response = await reply('msg-new', { reply: 42 });
    expect(response.status).toBe(400);
    const bodyJson = (await response.json()) as { error: { code: string } };
    expect(bodyJson.error.code).toBe('invalid_request');
    expect(state.updatedMessages).toHaveLength(0);
  });

  it('returns 404 for a nonexistent message without writing', async () => {
    const response = await reply('does-not-exist', { reply: 'Hi.' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('contact_message_not_found');
    expect(state.updatedMessages).toHaveLength(0);
  });

  it('rejects customers even when the body claims admin flags', async () => {
    state.userRole = 'customer';
    const response = await reply('msg-new', {
      reply: 'Hi.',
      senderRole: 'ADMIN',
      isAdmin: true,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    expect(state.messages.get('msg-new')?.['replies']).toBeUndefined();
  });

  it('rejects missing authentication', async () => {
    const response = await reply('msg-new', { reply: 'Hi.' }, null);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(state.updatedMessages).toHaveLength(0);
  });

  it('rejects invalid tokens', async () => {
    const response = await reply('msg-new', { reply: 'Hi.' }, 'forged-token');
    expect(response.status).toBe(401);
    expect(state.updatedMessages).toHaveLength(0);
    expect(state.messages.get('msg-new')?.['replies']).toBeUndefined();
  });

  it('returns 503 when server credentials are missing', async () => {
    state.throwNotConfigured = true;
    const response = await reply('msg-new', { reply: 'Hi.' });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('server_not_configured');
    expect(state.updatedMessages).toHaveLength(0);
  });

  it('never reports success when the Firestore write fails', async () => {
    state.failUpdate = true;
    const response = await reply('msg-new', { reply: 'Hi.' });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body).not.toHaveProperty('reply');
    // The failed reply left the stored message untouched.
    const updated = state.updatedMessages.filter((row) => row.id === 'msg-new');
    expect(updated).toHaveLength(0);
    expect(state.messages.get('msg-new')?.['status']).toBe('NEW');
    expect(state.messages.get('msg-new')?.['replies']).toBeUndefined();
  });
});
