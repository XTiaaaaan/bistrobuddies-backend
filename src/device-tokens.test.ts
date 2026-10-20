import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tokens = new Map<string, Row>();

  function docRef(path: string) {
    const separator = path.indexOf('/');
    const collection = separator === -1 ? path : path.slice(0, separator);
    const id = separator === -1 ? '' : path.slice(separator + 1);
    const store = collection === 'deviceTokens' ? tokens : null;

    return {
      get: async () => {
        const data = store?.get(id);
        return { exists: data !== undefined, data: () => data };
      },
      set: async (payload: Row, options?: { merge?: boolean }) => {
        if (!store) {
          return;
        }
        if (options?.merge && store.has(id)) {
          store.set(id, { ...store.get(id), ...payload });
        } else {
          store.set(id, payload);
        }
      },
      update: async (patch: Row) => {
        if (store?.has(id)) {
          store.set(id, { ...store.get(id), ...patch });
        }
      },
      delete: async () => {
        store?.delete(id);
      },
    };
  }

  function buildDb() {
    return {
      doc: (path: string) => docRef(path),
      collection: () => ({
        where: () => ({
          get: async () => ({ docs: [] }),
        }),
        get: async () => ({ docs: [] }),
      }),
      runTransaction: async (
        fn: (tx: {
          get: (ref: unknown) => Promise<unknown>;
          set: (ref: unknown, payload: Row) => Promise<void>;
          update: (ref: unknown, patch: Row) => Promise<void>;
        }) => Promise<unknown>
      ) =>
        fn({
          get: (ref: unknown) =>
            (ref as ReturnType<typeof docRef>).get() as Promise<unknown>,
          set: (ref: unknown, payload: Row) =>
            (ref as ReturnType<typeof docRef>).set(payload),
          update: (ref: unknown, patch: Row) =>
            (ref as ReturnType<typeof docRef>).update(patch),
        }),
    };
  }

  async function verifyIdToken(
    token: string
  ): Promise<{ uid: string; email?: string }> {
    if (token === 'valid-customer') {
      return { uid: 'cust-1', email: 'customer@example.com' };
    }
    if (token === 'valid-customer-2') {
      return { uid: 'cust-2', email: 'customer2@example.com' };
    }
    if (token === 'valid-admin') {
      return { uid: 'admin-1', email: 'admin@example.com' };
    }
    throw new Error('invalid token');
  }

  function reset() {
    tokens.clear();
  }

  return { tokens, buildDb, verifyIdToken, reset };
});

vi.mock('./firebase/admin', () => ({
  firebaseReady: () => true,
  requireFirebase: () => ({
    auth: { verifyIdToken: state.verifyIdToken },
    db: state.buildDb(),
    messaging: { sendEachForMulticast: async () => ({}) },
  }),
  resetFirebaseForTests: () => undefined,
}));

import { createApp } from './app';
import { deviceTokenDocId } from './services/notifications.service';

describe('device token API', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    state.reset();
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

  function register(
    token: string | null,
    body: unknown
  ): Promise<Response> {
    return fetch(`${base}/api/notifications/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function remove(
    token: string | null,
    body: unknown,
    alias = false
  ): Promise<Response> {
    return fetch(
      `${base}/api/notifications/devices${alias ? '/remove' : ''}`,
      {
        method: alias ? 'POST' : 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }
    );
  }

  it('requires authentication for registration and removal', async () => {
    expect(
      (await register(null, { token: 'some-fcm-token' })).status
    ).toBe(401);
    expect(
      (await remove(null, { token: 'some-fcm-token' })).status
    ).toBe(401);
  });

  it('associates registered tokens with the authenticated user', async () => {
    const response = await register('valid-customer', {
      token: 'device-token-1',
      platform: 'android',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ platform: 'android' });

    const row = state.tokens.get(deviceTokenDocId('device-token-1'));
    expect(row?.['uid']).toBe('cust-1');
    expect(row?.['token']).toBe('device-token-1');
    expect(row?.['platform']).toBe('android');
  });

  it('supports multiple devices per user', async () => {
    await register('valid-customer', {
      token: 'device-a',
      platform: 'android',
    });
    await register('valid-customer', {
      token: 'device-b',
      platform: 'ios',
    });

    expect(state.tokens.size).toBe(2);
    expect(
      [...state.tokens.values()].every((row) => row['uid'] === 'cust-1')
    ).toBe(true);
  });

  it('rejects malformed token payloads', async () => {
    expect((await register('valid-customer', {})).status).toBe(400);
    expect(
      (
        await register('valid-customer', {
          token: 'device-token',
          platform: 'desktop',
        })
      ).status
    ).toBe(400);
    expect(
      (await register('valid-customer', { token: 'has whitespace' })).status
    ).toBe(400);
  });

  it('lets the owner remove a token', async () => {
    await register('valid-customer', { token: 'device-remove' });

    const response = await remove('valid-customer', {
      token: 'device-remove',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect(state.tokens.has(deviceTokenDocId('device-remove'))).toBe(false);
  });

  it('does not let a customer remove another customer token', async () => {
    await register('valid-customer', { token: 'cust-1-device' });

    const response = await remove('valid-customer-2', {
      token: 'cust-1-device',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: false });
    expect(
      state.tokens.get(deviceTokenDocId('cust-1-device'))?.['uid']
    ).toBe('cust-1');
  });

  it('supports the POST /remove alias', async () => {
    await register('valid-customer', { token: 'alias-device' });

    const response = await remove(
      'valid-customer',
      { token: 'alias-device' },
      true
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
  });

  it('moves a shared device token to the account that re-registers it', async () => {
    await register('valid-customer', { token: 'shared-device' });
    await register('valid-customer-2', { token: 'shared-device' });

    const rows = [...state.tokens.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]['uid']).toBe('cust-2');
  });
});
