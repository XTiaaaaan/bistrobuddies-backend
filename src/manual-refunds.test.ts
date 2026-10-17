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
    // Concurrency helpers: hold reads for one order path until released, and
    // let transactions buffer their writes until commit (like Firestore).
    gatePath: null as string | null,
    gate: null as Promise<void> | null,
    releaseGate: null as null | (() => void),
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
          if (path === store.gatePath && store.gate) {
            await store.gate;
          }
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
        const writes: Array<{ ref: unknown; patch: Record<string, unknown> }> =
          [];
        const tx = {
          get: (ref: unknown) =>
            (ref as ReturnType<typeof docRef>).get() as Promise<unknown>,
          update: (ref: unknown, patch: Record<string, unknown>) => {
            writes.push({ ref, patch });
          },
          set: (ref: unknown, payload: Record<string, unknown>) => {
            writes.push({ ref, patch: payload });
          },
        };
        const result = await fn(tx);
        // Commit: buffered writes land atomically after the transaction body.
        for (const write of writes) {
          await (write.ref as ReturnType<typeof docRef>).update(
            write.patch
          );
        }
        return result;
      },
    };
  }

  async function verifyIdToken(
    token: string
  ): Promise<{ uid: string; email?: string }> {
    if (token === 'valid-admin') {
      return { uid: 'admin-1', email: 'admin@example.com' };
    }
    if (token === 'valid-admin-2') {
      return { uid: 'admin-2', email: 'admin2@example.com' };
    }
    if (token === 'valid-customer') {
      return { uid: 'cust-1', email: 'customer@example.com' };
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
    deliveryFee: 15,
    total: 215,
    currency: 'PHP',
    customerComment: '',
    paymentMethod: 'GCASH',
    paymentStatus: 'PENDING',
    orderStatus: 'PENDING',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function paidCancelledGcash(id: string): Record<string, unknown> {
  return order(id, {
    orderStatus: 'CANCELLED',
    paymentStatus: 'PAID',
    gcashDetails: {
      accountName: 'Juan dela Cruz',
      accountNumber: '09171234567',
      submittedBy: 'cust-1',
      submittedAt: '2026-10-16T00:00:00.000Z',
    },
    paymentDecision: {
      decision: 'PAID',
      decidedBy: 'admin-1',
      decidedAt: '2026-10-16T00:00:00.000Z',
    },
    paymentAudit: [
      { from: 'VERIFYING', to: 'PAID', actorUid: 'admin-1', actorRole: 'admin' },
    ],
  });
}

describe('manual refunds for cancelled paid orders', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    state.store.roles = new Map([
      ['admin-1', 'admin'],
      ['admin-2', 'admin'],
      ['cust-1', 'customer'],
      ['cust-2', 'customer'],
    ]);
    state.store.orders = new Map<string, Record<string, unknown>>([
      ['paid-cancelled-gcash', paidCancelledGcash('paid-cancelled-gcash')],
      [
        'already-refunded',
        {
          ...paidCancelledGcash('already-refunded'),
          refund: {
            status: 'REFUNDED',
            amount: 215,
            requestedBy: 'admin-1',
            requestedAt: '2026-10-16T01:00:00.000Z',
            completedBy: 'admin-1',
            completedAt: '2026-10-16T02:00:00.000Z',
          },
          refundAudit: [
            {
              from: 'NOT_REFUNDED',
              to: 'REFUND_PENDING',
              actorUid: 'admin-1',
              actorRole: 'admin',
            },
            {
              from: 'REFUND_PENDING',
              to: 'REFUNDED',
              actorUid: 'admin-1',
              actorRole: 'admin',
            },
          ],
        },
      ],
      ['cancelled-unpaid', order('cancelled-unpaid', { orderStatus: 'CANCELLED' })],
      [
        'cancelled-cod',
        order('cancelled-cod', {
          orderStatus: 'CANCELLED',
          paymentMethod: 'COD',
        }),
      ],
      [
        'cancelled-verifying',
        order('cancelled-verifying', {
          orderStatus: 'CANCELLED',
          gcashDetails: {
            accountName: 'Juan dela Cruz',
            accountNumber: '09171234567',
          },
        }),
      ],
      ['cancelled-rejected', order('cancelled-rejected', { orderStatus: 'CANCELLED', paymentStatus: 'REJECTED' })],
      [
        'confirmed-paid',
        { ...paidCancelledGcash('confirmed-paid'), orderStatus: 'CONFIRMED' },
      ],
      [
        'completed-paid',
        { ...paidCancelledGcash('completed-paid'), orderStatus: 'COMPLETED' },
      ],
    ]);
    state.store.writes = 0;
    state.store.gatePath = null;
    state.store.gate = null;
    state.store.releaseGate = null;

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

  function refund(orderId: string, token: string | null, body: unknown) {
    return fetch(`${base}/api/admin/orders/${orderId}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function stored(id: string): Record<string, unknown> {
    return state.store.orders.get(id) as Record<string, unknown>;
  }

  function errorCode(body: { error?: { code?: string } }): string | undefined {
    return body.error?.code;
  }

  it('initiates a pending refund on a cancelled paid order', async () => {
    const response = await refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'PENDING',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'paid-cancelled-gcash',
      orderStatus: 'CANCELLED',
      paymentStatus: 'PAID',
    });
    expect(body['refund']).toMatchObject({
      status: 'REFUND_PENDING',
      amount: 215,
    });
    expect(
      (body['refund'] as Record<string, unknown>)['requestedAt']
    ).not.toBeNull();
    expect(body['refundAudit']).toHaveLength(1);

    const doc = stored('paid-cancelled-gcash');
    const docRefund = doc['refund'] as Record<string, unknown>;
    expect(docRefund['status']).toBe('REFUND_PENDING');
    expect(docRefund['amount']).toBe(215);
    expect(docRefund['requestedBy']).toBe('admin-1');
    expect(docRefund['requestedAt']).toBeInstanceOf(Date);
    expect(doc['refundAudit']).toEqual([
      {
        from: 'NOT_REFUNDED',
        to: 'REFUND_PENDING',
        actorUid: 'admin-1',
        actorRole: 'admin',
      },
    ]);
    // Payment/GCash data is untouched by starting a refund.
    expect(doc['paymentStatus']).toBe('PAID');
    expect(doc['orderStatus']).toBe('CANCELLED');
    expect(doc['gcashDetails']).toMatchObject({
      accountName: 'Juan dela Cruz',
      accountNumber: '09171234567',
    });
    expect(doc['paymentAudit']).toEqual([
      {
        from: 'VERIFYING',
        to: 'PAID',
        actorUid: 'admin-1',
        actorRole: 'admin',
      },
    ]);
  });

  it('completes a pending refund only with explicit confirmation', async () => {
    await refund('paid-cancelled-gcash', 'valid-admin', { action: 'PENDING' });

    const response = await refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'COMPLETE',
      confirmed: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['refund']).toMatchObject({
      status: 'REFUNDED',
      amount: 215,
    });
    expect(
      (body['refund'] as Record<string, unknown>)['completedAt']
    ).not.toBeNull();
    expect(body['refundAudit']).toHaveLength(2);

    const docRefund = stored('paid-cancelled-gcash')['refund'] as Record<
      string,
      unknown
    >;
    expect(docRefund['status']).toBe('REFUNDED');
    expect(docRefund['amount']).toBe(215);
    expect(docRefund['requestedBy']).toBe('admin-1');
    expect(docRefund['completedBy']).toBe('admin-1');
    expect(docRefund['completedAt']).toBeInstanceOf(Date);
    expect(stored('paid-cancelled-gcash')['refundAudit']).toEqual([
      {
        from: 'NOT_REFUNDED',
        to: 'REFUND_PENDING',
        actorUid: 'admin-1',
        actorRole: 'admin',
      },
      {
        from: 'REFUND_PENDING',
        to: 'REFUNDED',
        actorUid: 'admin-1',
        actorRole: 'admin',
      },
    ]);
  });

  it('rejects completing without the explicit confirmation flag', async () => {
    await refund('paid-cancelled-gcash', 'valid-admin', { action: 'PENDING' });
    const writesBefore = state.store.writes;

    for (const body of [
      { action: 'COMPLETE', confirmed: false },
      { action: 'COMPLETE' },
    ]) {
      const response = await refund(
        'paid-cancelled-gcash',
        'valid-admin',
        body
      );
      expect(response.status).toBe(400);
      const bodyJson = (await response.json()) as { error?: { code?: string } };
      expect(errorCode(bodyJson)).toBe('invalid_request');
    }
    expect(state.store.writes).toBe(writesBefore);
    expect(
      (stored('paid-cancelled-gcash')['refund'] as Record<string, unknown>)[
        'status'
      ]
    ).toBe('REFUND_PENDING');
  });

  it('rejects non-PAID orders (unpaid, verifying, rejected)', async () => {
    for (const id of [
      'cancelled-unpaid',
      'cancelled-cod',
      'cancelled-verifying',
      'cancelled-rejected',
    ]) {
      const response = await refund(id, 'valid-admin', { action: 'PENDING' });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(errorCode(body)).toBe('order_not_refundable');
      expect(stored(id)['refund']).toBeUndefined();
      expect(stored(id)['refundAudit']).toBeUndefined();
    }
  });

  it('rejects orders that are not cancelled', async () => {
    for (const id of ['confirmed-paid', 'completed-paid']) {
      const response = await refund(id, 'valid-admin', { action: 'PENDING' });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(errorCode(body)).toBe('order_not_refundable');
      expect(stored(id)['refund']).toBeUndefined();
    }
  });

  it('requires authentication and administrator privileges', async () => {
    const writesBefore = state.store.writes;

    const anonymous = await refund('paid-cancelled-gcash', null, {
      action: 'PENDING',
    });
    expect(anonymous.status).toBe(401);

    const customer = await refund('paid-cancelled-gcash', 'valid-customer', {
      action: 'PENDING',
    });
    expect(customer.status).toBe(403);
    const body = (await customer.json()) as { error?: { code?: string } };
    expect(errorCode(body)).toBe('forbidden');

    expect(state.store.writes).toBe(writesBefore);
    expect(stored('paid-cancelled-gcash')['refund']).toBeUndefined();
  });

  it('returns 404 for a missing order', async () => {
    const response = await refund('missing', 'valid-admin', {
      action: 'PENDING',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(errorCode(body)).toBe('order_not_found');
  });

  it('rejects refunds on an order that is already refunded', async () => {
    const writesBefore = state.store.writes;

    for (const body of [
      { action: 'PENDING' },
      { action: 'COMPLETE', confirmed: true },
    ]) {
      const response = await refund('already-refunded', 'valid-admin-2', body);
      expect(response.status).toBe(409);
      const bodyJson = (await response.json()) as { error?: { code?: string } };
      expect(errorCode(bodyJson)).toBe('refund_already_completed');
    }

    expect(state.store.writes).toBe(writesBefore);
    const doc = stored('already-refunded');
    expect((doc['refund'] as Record<string, unknown>)['status']).toBe(
      'REFUNDED'
    );
    expect(doc['refundAudit']).toHaveLength(2);
  });

  it('refuses to complete a refund that was never recorded as pending', async () => {
    const response = await refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'COMPLETE',
      confirmed: true,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(errorCode(body)).toBe('invalid_refund_transition');
    // Nothing was written: no refund state exists on the order.
    expect(stored('paid-cancelled-gcash')['refund']).toBeUndefined();
  });

  it('treats repeating a pending refund as an idempotent no-op', async () => {
    await refund('paid-cancelled-gcash', 'valid-admin', { action: 'PENDING' });
    const writesBefore = state.store.writes;

    const response = await refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'PENDING',
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as Record<string, unknown>)['refund']
    ).toMatchObject({ status: 'REFUND_PENDING', amount: 215 });
    expect(state.store.writes).toBe(writesBefore);
    expect(stored('paid-cancelled-gcash')['refundAudit']).toHaveLength(1);
  });

  it('keeps the second of two concurrent refund initiations harmless', async () => {
    state.store.gatePath = 'orders/paid-cancelled-gcash';
    state.store.gate = new Promise<void>((resolve) => {
      state.store.releaseGate = resolve;
    });

    const first = refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'PENDING',
    });
    const second = refund('paid-cancelled-gcash', 'valid-admin-2', {
      action: 'PENDING',
    });
    // Wait for both handlers to park on the read gate.
    await new Promise((resolve) => setTimeout(resolve, 25));
    state.store.releaseGate?.();

    for (const response of await Promise.all([first, second])) {
      expect(response.status).toBe(200);
    }
    const doc = stored('paid-cancelled-gcash');
    expect((doc['refund'] as Record<string, unknown>)['status']).toBe(
      'REFUND_PENDING'
    );
    expect((doc['refund'] as Record<string, unknown>)['amount']).toBe(215);
    // Exactly one initiation entry no matter which request landed first.
    const audit = doc['refundAudit'] as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ from: 'NOT_REFUNDED', to: 'REFUND_PENDING' });
    expect(
      (doc['refund'] as Record<string, unknown>)['requestedBy']
    ).toBe(audit[0]!['actorUid']);
  });

  it('cannot double-complete two concurrent refund completions', async () => {
    await refund('paid-cancelled-gcash', 'valid-admin', { action: 'PENDING' });

    state.store.gatePath = 'orders/paid-cancelled-gcash';
    state.store.gate = new Promise<void>((resolve) => {
      state.store.releaseGate = resolve;
    });

    const first = refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'COMPLETE',
      confirmed: true,
    });
    const second = refund('paid-cancelled-gcash', 'valid-admin-2', {
      action: 'COMPLETE',
      confirmed: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    state.store.releaseGate?.();

    // At most one completion succeeds; a request racing the committed state
    // may be refused, but the refund can never be recorded twice.
    const statuses = (await Promise.all([first, second])).map(
      (response) => response.status
    );
    expect(statuses).toEqual(expect.arrayContaining([200]));
    for (const status of statuses) {
      expect([200, 409]).toContain(status);
    }
    const doc = stored('paid-cancelled-gcash');
    expect((doc['refund'] as Record<string, unknown>)['status']).toBe(
      'REFUNDED'
    );
    expect((doc['refund'] as Record<string, unknown>)['amount']).toBe(215);
    expect((doc['refund'] as Record<string, unknown>)['completedAt']).toBeInstanceOf(
      Date
    );
    // Exactly one completion audit entry despite two concurrent completions.
    expect(doc['refundAudit']).toEqual([
      {
        from: 'NOT_REFUNDED',
        to: 'REFUND_PENDING',
        actorUid: 'admin-1',
        actorRole: 'admin',
      },
      {
        from: 'REFUND_PENDING',
        to: 'REFUNDED',
        actorUid:
          (doc['refund'] as Record<string, unknown>)['completedBy'],
        actorRole: 'admin',
      },
    ]);
  });

  it('preserves the original payment and GCash data through the full refund flow', async () => {
    await refund('paid-cancelled-gcash', 'valid-admin', { action: 'PENDING' });
    await refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'COMPLETE',
      confirmed: true,
    });

    const doc = stored('paid-cancelled-gcash');
    expect(doc['orderStatus']).toBe('CANCELLED');
    expect(doc['paymentStatus']).toBe('PAID');
    expect(doc['paymentMethod']).toBe('GCASH');
    expect(doc['customerSnapshot']).toMatchObject({ uid: 'cust-1' });
    expect(doc['currency']).toBe('PHP');
    expect(doc['total']).toBe(215);
    expect(doc['gcashDetails']).toMatchObject({
      accountName: 'Juan dela Cruz',
      accountNumber: '09171234567',
      submittedBy: 'cust-1',
    });
    expect(doc['paymentDecision']).toMatchObject({
      decision: 'PAID',
      decidedBy: 'admin-1',
    });
    expect(doc['paymentAudit']).toEqual([
      {
        from: 'VERIFYING',
        to: 'PAID',
        actorUid: 'admin-1',
        actorRole: 'admin',
      },
    ]);
  });

  it('exposes only safe refund fields in customer order responses', async () => {
    function get(orderId: string, token: string) {
      return fetch(`${base}/api/orders/${orderId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    // Before any refund action: status NOT_REFUNDED, no audit data.
    const before = await get('paid-cancelled-gcash', 'valid-customer');
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as Record<string, unknown>;
    expect(beforeBody['refund']).toMatchObject({
      status: 'NOT_REFUNDED',
      amount: null,
      requestedAt: null,
      completedAt: null,
    });
    expect(beforeBody['refundAudit']).toBeUndefined();
    expect(beforeBody['paymentDecision']).toBeUndefined();
    expect(beforeBody['paymentAudit']).toBeUndefined();

    await refund('paid-cancelled-gcash', 'valid-admin', { action: 'PENDING' });
    await refund('paid-cancelled-gcash', 'valid-admin', {
      action: 'COMPLETE',
      confirmed: true,
    });

    const after = await get('paid-cancelled-gcash', 'valid-customer');
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as Record<string, unknown>;
    expect(afterBody['refund']).toMatchObject({
      status: 'REFUNDED',
      amount: 215,
    });
    expect(
      (afterBody['refund'] as Record<string, unknown>)['completedAt']
    ).not.toBeNull();
    expect(afterBody['refundAudit']).toBeUndefined();
    expect(afterBody['customerSnapshot']).toMatchObject({ uid: 'cust-1' });
  });

  it('rejects malformed refund bodies', async () => {
    for (const body of [{}, { action: 'START' }, { confirmed: true }]) {
      const response = await refund('paid-cancelled-gcash', 'valid-admin', body);
      expect(response.status).toBe(400);
      const bodyJson = (await response.json()) as { error?: { code?: string } };
      expect(errorCode(bodyJson)).toBe('invalid_request');
    }

    // A bare JSON primitive is not a valid object body.
    const primitive = await refund(
      'paid-cancelled-gcash',
      'valid-admin',
      'not-json-object'
    );
    expect(primitive.status).toBe(400);
    const primitiveJson = (await primitive.json()) as {
      error?: { code?: string };
    };
    expect(errorCode(primitiveJson)).toBe('invalid_json');
  });
});
