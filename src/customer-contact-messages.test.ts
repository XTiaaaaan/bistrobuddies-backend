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
  messages: new Map<string, Record<string, unknown>>(),
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
          collection: (name: string) => ({
            where: (field: string, _op: string, value: unknown) => ({
              get: async () => ({
                docs:
                  name === 'contactMessages'
                    ? [...state.messages.entries()]
                        .filter(([, data]) => data[field] === value)
                        .map(([id, data]) => ({ id, data: () => data }))
                    : [],
              }),
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
      'msg-mine-new',
      {
        id: 'msg-mine-new',
        name: 'Juan dela Cruz',
        email: 'juan@example.com',
        subject: 'Order question',
        message: 'Where is my order?',
        userId: 'cust-1',
        status: 'READ',
        createdAt: ts(4000),
        updatedAt: ts(5000),
        replies: [
          {
            id: 'reply-1',
            senderRole: 'ADMIN',
            reply: 'We found it — shipping tomorrow.',
            createdAt: ts(4500),
          },
        ],
      },
    ],
    [
      'msg-mine-old',
      {
        id: 'msg-mine-old',
        name: 'Juan dela Cruz',
        email: 'juan@example.com',
        subject: 'Feedback',
        message: 'Great coffee!',
        userId: 'cust-1',
        status: 'RESOLVED',
        createdAt: ts(1000),
        updatedAt: ts(2500),
      },
    ],
    [
      'msg-other',
      {
        id: 'msg-other',
        name: 'Maria Clara',
        email: 'maria@example.com',
        subject: 'Secret',
        message: 'Another customer private message',
        userId: 'cust-2',
        status: 'READ',
        createdAt: ts(3000),
        updatedAt: ts(3000),
        replies: [
          {
            id: 'reply-other',
            senderRole: 'ADMIN',
            reply: 'A private reply to another customer.',
            createdAt: ts(3100),
          },
        ],
      },
    ],
  ]);
}

describe('GET /api/contact-messages/mine (customer messages)', () => {
  let server: Server;
  let base: string;

  function list(query = '', token: string | null = 'valid-customer') {
    return fetch(`${base}/api/contact-messages/mine${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  beforeEach(async () => {
    state.messages = seedMessages();
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

  it("returns only the caller's messages, newest first", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(body.messages.map((message) => message['id'])).toEqual([
      'msg-mine-new',
      'msg-mine-old',
    ]);
    const first = body.messages[0];
    expect(first['subject']).toBe('Order question');
    expect(first['message']).toBe('Where is my order?');
    // A message with an admin reply is READ.
    expect(first['status']).toBe('READ');
    expect(first['createdAt']).toBe(new Date(4000).toISOString());
    expect(first['updatedAt']).toBe(new Date(5000).toISOString());
  });

  it('returns admin replies to the owner of the message', async () => {
    const response = await list();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<Record<string, unknown>>;
    };

    const withReply = body.messages.find(
      (message) => message['id'] === 'msg-mine-new'
    );
    const replies = withReply?.['replies'] as Array<Record<string, unknown>>;
    expect(replies).toEqual([
      {
        id: 'reply-1',
        senderRole: 'ADMIN',
        reply: 'We found it — shipping tomorrow.',
        createdAt: new Date(4500).toISOString(),
      },
    ]);

    // Feedback without any reply still serializes to an empty array.
    const withoutReply = body.messages.find(
      (message) => message['id'] === 'msg-mine-old'
    );
    expect(withoutReply?.['replies']).toEqual([]);
  });

  it("never returns another customer's replies", async () => {
    const response = await list();
    const text = await response.text();
    expect(text).not.toContain('reply-other');
    expect(text).not.toContain('A private reply to another customer.');

    const other = await list('', 'valid-customer-2');
    expect(other.status).toBe(200);
    const otherText = await other.text();
    expect(otherText).not.toContain('reply-1');
  });

  it('returns only the fields the customer UI needs', async () => {
    const response = await list();
    const text = await response.text();
    expect(text).not.toContain('userId');
    expect(text).not.toContain('juan@example.com');
    expect(text).not.toContain('cust-1');

    const body = JSON.parse(text) as { messages: Array<object> };
    for (const message of body.messages) {
      expect(Object.keys(message).sort()).toEqual([
        'createdAt',
        'id',
        'message',
        'replies',
        'status',
        'subject',
        'updatedAt',
      ]);
    }
  });

  it('never leaks another customer even when the query claims their id', async () => {
    const response = await list('?userId=cust-2');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages.map((message) => message['id'])).toEqual([
      'msg-mine-new',
      'msg-mine-old',
    ]);
    expect(body.messages.map((message) => message['id'])).not.toContain(
      'msg-other'
    );
  });

  it('scopes the list to each authenticated customer', async () => {
    const other = await list('', 'valid-customer-2');
    expect(other.status).toBe(200);
    const body = (await other.json()) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages.map((message) => message['id'])).toEqual(['msg-other']);
  });

  it('returns an empty list when the customer has no messages', async () => {
    state.messages = new Map();
    const response = await list();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it('requires authentication', async () => {
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
