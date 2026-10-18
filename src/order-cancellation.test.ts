import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __serverTimestamp: true }),
  },
}));

const state = vi.hoisted(() => {
  const FIXED_NOW = new Date('2026-10-16T00:00:00.000Z');

  function toStored(value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
      if ((value as Record<string, unknown>)['__serverTimestamp'] === true) {
        return new Date(FIXED_NOW);
      }
      if (Array.isArray(value)) {
        return value.map(toStored);
      }
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>
      )) {
        out[key] = toStored(entry);
      }
      return out;
    }
    return value;
  }

  const store = {
    roles: new Map<string, string>(),
    orders: new Map<string, Record<string, unknown>>(),
    writes: 0,
  };

  function docRef(path: string) {
    return {
      __path: path,
      get: async () => {
        if (path.startsWith('users/')) {
          const role = store.roles.get(path.slice('users/'.length));
          return {
            exists: role !== undefined,
            data: () => (role !== undefined ? { role } : undefined),
          };
        }
        if (path.startsWith('orders/')) {
          const data = store.orders.get(path.slice('orders/'.length));
          return {
            exists: data !== undefined,
            data: () => data,
          };
        }
        return { exists: false, data: () => undefined };
      },
      set: async (payload: Record<string, unknown>) => {
        if (path.startsWith('orders/')) {
          store.orders.set(
            path.slice('orders/'.length),
            toStored(payload) as Record<string, unknown>
          );
          store.writes += 1;
        }
      },
      update: async (patch: Record<string, unknown>) => {
        if (path.startsWith('orders/')) {
          const id = path.slice('orders/'.length);
          const current = store.orders.get(id) ?? {};
          store.orders.set(id, {
            ...current,
            ...(toStored(patch) as Record<string, unknown>),
          });
          store.writes += 1;
        }
      },
      delete: async () => undefined,
    };
  }

  function buildDb() {
    return {
      doc: (path: string) => docRef(path),
      collection: (name: string) => ({
        doc: (id?: string) => {
          const ref = docRef(`${name}/${id ?? 'generated-1'}`);
          return { id: id ?? 'generated-1', set: ref.set, get: ref.get };
        },
      }),
      runTransaction: async (
        fn: (tx: {
          get: (ref: unknown) => Promise<unknown>;
          update: (ref: unknown, patch: Record<string, unknown>) => void;
          set: (ref: unknown, payload: Record<string, unknown>) => void;
        }) => Promise<unknown>
      ) => {
        const tx = {
          get: (ref: unknown) =>
            (ref as ReturnType<typeof docRef>).get() as Promise<unknown>,
          update: (ref: unknown, patch: Record<string, unknown>) =>
            (ref as ReturnType<typeof docRef>).update(patch),
          set: (ref: unknown, payload: Record<string, unknown>) =>
            (ref as ReturnType<typeof docRef>).set(payload),
        };
        return fn(tx);
      },
    };
  }

  async function verifyIdToken(
    token: string
  ): Promise<{ uid: string; email?: string }> {
    if (token === 'valid-admin') {
      return { uid: 'admin-1', email: 'admin@example.com' };
    }
    if (token === 'valid-customer') {
      return { uid: 'cust-1', email: 'customer@example.com' };
    }
    if (token === 'valid-customer-2') {
      return { uid: 'cust-2', email: 'customer2@example.com' };
    }
    throw new Error('invalid token');
  }

  return { store, buildDb, verifyIdToken, FIXED_NOW };
});

vi.mock('./firebase/admin', () => ({
  firebaseReady: () => true,
  requireFirebase: () => ({
    auth: { verifyIdToken: state.verifyIdToken },
    db: state.buildDb(),
  }),
  resetFirebaseForTests: () => undefined,
}));

import { createApp } from './app';

function order(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    customerId: 'cust-1',
    customerSnapshot: { uid: 'cust-1', name: 'Juan', email: '', phone: '' },
    addressSnapshot: {},
    items: [],
    subtotal: 200,
    deliveryFee: 0,
    total: 200,
    currency: 'PHP',
    customerComment: '',
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    orderStatus: 'PENDING',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('customer order cancellation', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    state.store.roles = new Map([
      ['admin-1', 'admin'],
      ['cust-1', 'customer'],
      ['cust-2', 'customer'],
    ]);
    state.store.orders = new Map([
      ['pending-cod', order('pending-cod')],
      [
        'pending-gcash',
        order('pending-gcash', {
          paymentMethod: 'GCASH',
          paymentStatus: 'VERIFYING',
          gcashDetails: {
            accountName: 'Juan dela Cruz',
            accountNumber: '09171234567',
            submittedBy: 'cust-1',
            submittedAt: '2026-10-16T00:00:00.000Z',
          },
        }),
      ],
      [
        'other-user',
        order('other-user', { customerId: 'cust-2' }),
      ],
      [
        'confirmed',
        order('confirmed', {
          orderStatus: 'CONFIRMED',
          paymentMethod: 'GCASH',
          paymentStatus: 'PAID',
        }),
      ],
      ['preparing', order('preparing', { orderStatus: 'PREPARING' })],
      ['ready', order('ready', { orderStatus: 'READY' })],
      ['completed', order('completed', { orderStatus: 'COMPLETED' })],
      ['cancelled', order('cancelled', { orderStatus: 'CANCELLED' })],
    ]);
    state.store.writes = 0;

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

  function cancel(orderId: string, token: string | null) {
    return fetch(`${base}/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  }

  function stored(id: string): Record<string, unknown> {
    return state.store.orders.get(id) as Record<string, unknown>;
  }

  it('cancels a PENDING order and leaves the document in place', async () => {
    const response = await cancel('pending-cod', 'valid-customer');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'pending-cod',
      orderStatus: 'CANCELLED',
      paymentStatus: 'PENDING',
      total: 200,
    });

    expect(state.store.orders.has('pending-cod')).toBe(true);
    expect(stored('pending-cod')['orderStatus']).toBe('CANCELLED');
    expect(stored('pending-cod')['paymentStatus']).toBe('PENDING');
    expect(stored('pending-cod')['updatedAt']).toBeInstanceOf(Date);
  });

  it('keeps GCash payment status and details untouched', async () => {
    const response = await cancel('pending-gcash', 'valid-customer');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['orderStatus']).toBe('CANCELLED');
    expect(body['paymentStatus']).toBe('VERIFYING');
    expect(body['gcashDetails']).toMatchObject({
      accountName: 'Juan dela Cruz',
      accountNumber: '09171234567',
    });

    expect(stored('pending-gcash')['paymentStatus']).toBe('VERIFYING');
    expect(stored('pending-gcash')['gcashDetails']).toMatchObject({
      accountName: 'Juan dela Cruz',
    });
  });

  it('requires authentication', async () => {
    const response = await cancel('pending-cod', null);
    expect(response.status).toBe(401);
    expect(stored('pending-cod')['orderStatus']).toBe('PENDING');
  });

  it('hides another customer’s order behind 404 without modifying it', async () => {
    const response = await cancel('other-user', 'valid-customer');
    expect(response.status).toBe(404);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code
    ).toBe('order_not_found');
    expect(stored('other-user')['orderStatus']).toBe('PENDING');
  });

  it('returns 404 for a missing order', async () => {
    const response = await cancel('missing', 'valid-customer');
    expect(response.status).toBe(404);
  });

  it('refuses to cancel orders that are no longer PENDING', async () => {
    for (const id of ['confirmed', 'preparing', 'ready', 'completed']) {
      const response = await cancel(id, 'valid-customer');
      expect(response.status).toBe(409);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code
      ).toBe('order_not_cancellable');
      expect(stored(id)['orderStatus']).not.toBe('CANCELLED');
    }
  });

  it('treats an already-cancelled order as an idempotent no-op', async () => {
    const writesBefore = state.store.writes;
    const response = await cancel('cancelled', 'valid-customer');
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { orderStatus: string }).orderStatus
    ).toBe('CANCELLED');
    expect(state.store.writes).toBe(writesBefore);
  });

  it('cannot cancel an order an admin already confirmed', async () => {
    const confirm = await fetch(`${base}/api/admin/orders/pending-cod/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-admin',
      },
      body: JSON.stringify({ orderStatus: 'CONFIRMED' }),
    });
    expect(confirm.status).toBe(200);

    const response = await cancel('pending-cod', 'valid-customer');
    expect(response.status).toBe(409);
    expect(stored('pending-cod')['orderStatus']).toBe('CONFIRMED');
  });

  it('does not let an admin cancel through the customer endpoint', async () => {
    const response = await cancel('pending-cod', 'valid-admin');
    expect(response.status).toBe(404);
    expect(stored('pending-cod')['orderStatus']).toBe('PENDING');
  });
});
