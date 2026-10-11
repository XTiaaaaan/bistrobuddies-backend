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
              const id = docPath.slice('contactMessages/'.length);
              state.updatedMessages.push({ id, patch });
              const data = state.messages.get(id);
              if (data && typeof patch['status'] === 'string') {
                data['status'] = patch['status'];
              }
            },
          }),
          collection: (name: string) => ({
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
      'msg-a',
      {
        id: 'msg-a',
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
      'msg-b',
      {
        id: 'msg-b',
        name: 'Maria Clara',
        email: 'maria@example.com',
        subject: 'Feedback',
        message: 'Great coffee!',
        userId: 'cust-2',
        status: 'READ',
        createdAt: ts(3000),
        updatedAt: ts(3500),
      },
    ],
    [
      'msg-c',
      {
        id: 'msg-c',
        name: 'Jose Rizal',
        email: 'jose@example.com',
        subject: 'Complaint',
        message: 'Cold drink.',
        userId: 'cust-3',
        status: 'RESOLVED',
        createdAt: ts(2000),
        updatedAt: ts(2500),
      },
    ],
    [
      'msg-d',
      {
        id: 'msg-d',
        name: 'Ana Bonifacio',
        email: 'ana@example.com',
        subject: 'Question',
        message: 'Do you deliver?',
        userId: 'cust-4',
        status: 'NEW',
        createdAt: ts(1000),
        updatedAt: ts(1000),
      },
    ],
  ]);
}

describe('admin contact messages API', () => {
  let server: Server;
  let base: string;

  function list(query = '', token: string | null = 'valid-admin') {
    return fetch(`${base}/api/admin/contact-messages${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  function patchStatus(
    id: string,
    body: unknown,
    token: string | null = 'valid-admin'
  ) {
    return fetch(`${base}/api/admin/contact-messages/${id}/status`, {
      method: 'PATCH',
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

  describe('GET /api/admin/contact-messages (list)', () => {
    it('lets an authorized admin list messages newest first', async () => {
      const response = await list();
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<Record<string, unknown>>;
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };

      expect(body.page).toBe(1);
      expect(body.total).toBe(4);
      expect(body.totalPages).toBe(1);
      expect(body.messages.map((message) => message['id'])).toEqual([
        'msg-a',
        'msg-b',
        'msg-c',
        'msg-d',
      ]);

      const first = body.messages[0];
      expect(first['name']).toBe('Juan dela Cruz');
      expect(first['email']).toBe('juan@example.com');
      expect(first['subject']).toBe('Order question');
      expect(first['message']).toBe('Where is my order?');
      expect(first['status']).toBe('NEW');
      expect(first['createdAt']).toBe(new Date(4000).toISOString());
      expect(first['updatedAt']).toBe(new Date(4000).toISOString());
    });

    it('never returns userId or other stored fields to the admin client', async () => {
      const response = await list();
      const text = await response.text();
      expect(text).not.toContain('userId');
      expect(text).not.toContain('cust-1');
      const body = JSON.parse(text) as { messages: Array<object> };
      for (const message of body.messages) {
        expect(Object.keys(message).sort()).toEqual([
          'createdAt',
          'email',
          'id',
          'message',
          'name',
          'status',
          'subject',
          'updatedAt',
        ]);
      }
    });

    it('filters messages by status', async () => {
      const response = await list('?status=NEW');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<Record<string, unknown>>;
        total: number;
        totalPages: number;
      };
      expect(body.messages.map((message) => message['id'])).toEqual([
        'msg-a',
        'msg-d',
      ]);
      expect(body.total).toBe(2);
      expect(body.totalPages).toBe(1);

      const read = await list('?status=READ');
      const readBody = (await read.json()) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(readBody.messages.map((message) => message['id'])).toEqual([
        'msg-b',
      ]);

      const resolved = await list('?status=RESOLVED');
      const resolvedBody = (await resolved.json()) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(resolvedBody.messages.map((message) => message['id'])).toEqual([
        'msg-c',
      ]);
    });

    it('paginates with validated page and pageSize', async () => {
      const page1 = await list('?page=1&pageSize=3');
      const page1Body = (await page1.json()) as {
        messages: Array<Record<string, unknown>>;
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
      expect(page1Body.messages.map((message) => message['id'])).toEqual([
        'msg-a',
        'msg-b',
        'msg-c',
      ]);
      expect(page1Body.total).toBe(4);
      expect(page1Body.totalPages).toBe(2);

      const page2 = await list('?page=2&pageSize=3');
      const page2Body = (await page2.json()) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(page2Body.messages.map((message) => message['id'])).toEqual([
        'msg-d',
      ]);

      const beyond = await list('?page=99&pageSize=3');
      const beyondBody = (await beyond.json()) as {
        messages: unknown[];
        total: number;
      };
      expect(beyondBody.messages).toEqual([]);
      expect(beyondBody.total).toBe(4);
    });

    it('rejects invalid pagination parameters', async () => {
      for (const query of [
        '?page=0',
        '?page=-1',
        '?page=abc',
        '?page=1.5',
        '?pageSize=0',
        '?pageSize=101',
        '?pageSize=many',
      ]) {
        const response = await list(query);
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe('invalid_request');
      }
    });

    it('rejects an unknown status filter', async () => {
      const response = await list('?status=BOGUS');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('rejects customers (server-side admin authorization)', async () => {
      state.userRole = 'customer';
      const response = await list('?status=NEW', 'valid-customer');
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    });

    it('rejects missing authentication', async () => {
      const response = await list('', null);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('rejects invalid tokens', async () => {
      const response = await list('', 'forged-token');
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('returns 503 when server credentials are missing', async () => {
      state.throwNotConfigured = true;
      const response = await list();
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('server_not_configured');
    });
  });

  describe('PATCH /api/admin/contact-messages/:id/status', () => {
    it('lets an authorized admin mark a message as READ', async () => {
      const response = await patchStatus('msg-a', { status: 'READ' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ id: 'msg-a', status: 'READ' });

      expect(state.updatedMessages).toHaveLength(1);
      const update = state.updatedMessages[0];
      expect(update.id).toBe('msg-a');
      // Only status and updatedAt are ever written — the customer's original
      // submission and createdAt are untouched.
      expect(Object.keys(update.patch).sort()).toEqual([
        'status',
        'updatedAt',
      ]);
      expect(update.patch['status']).toBe('READ');
      expect(update.patch['updatedAt']).toBeDefined();
    });

    it('lets an authorized admin mark a message as RESOLVED', async () => {
      const response = await patchStatus('msg-a', { status: 'RESOLVED' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ id: 'msg-a', status: 'RESOLVED' });
      expect(state.messages.get('msg-a')?.['status']).toBe('RESOLVED');
      expect(state.updatedMessages).toHaveLength(1);
      expect(state.updatedMessages[0].patch['status']).toBe('RESOLVED');
    });

    it('rejects NEW and unknown status values with 400', async () => {
      for (const status of ['NEW', 'BOGUS', '', 42, null]) {
        const response = await patchStatus('msg-a', { status });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe('invalid_request');
      }
      expect(state.updatedMessages).toHaveLength(0);
    });

    it('rejects a body without a status', async () => {
      const response = await patchStatus('msg-a', {});
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
      expect(state.updatedMessages).toHaveLength(0);
    });

    it('returns 404 for a nonexistent message', async () => {
      const response = await patchStatus('does-not-exist', {
        status: 'READ',
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('contact_message_not_found');
      expect(state.updatedMessages).toHaveLength(0);
    });

    it('rejects customers even when the body claims admin flags', async () => {
      state.userRole = 'customer';
      const response = await patchStatus('msg-a', {
        status: 'RESOLVED',
        role: 'admin',
        isAdmin: true,
        userId: 'admin-1',
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
      expect(state.updatedMessages).toHaveLength(0);
    });

    it('rejects missing authentication', async () => {
      const response = await patchStatus('msg-a', { status: 'READ' }, null);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
      expect(state.updatedMessages).toHaveLength(0);
    });

    it('rejects invalid tokens', async () => {
      const response = await patchStatus(
        'msg-a',
        { status: 'READ' },
        'forged-token'
      );
      expect(response.status).toBe(401);
      expect(state.updatedMessages).toHaveLength(0);
    });

    it('returns 503 when server credentials are missing', async () => {
      state.throwNotConfigured = true;
      const response = await patchStatus('msg-a', { status: 'READ' });
      expect(response.status).toBe(503);
      expect(state.updatedMessages).toHaveLength(0);
    });
  });
});
