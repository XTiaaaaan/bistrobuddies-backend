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
    products: new Map<string, Record<string, unknown>>(),
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
        if (path.startsWith('products/')) {
          const data = store.products.get(path.slice('products/'.length));
          return {
            exists: data !== undefined,
            data: () => data,
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
        get: async () => ({
          docs: [...store.products.entries()].map(([id, data]) => ({
            id,
            data: () => data,
          })),
        }),
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

vi.mock('./firebase/admin', async () => {
  const { ServerNotConfiguredError } = await import('./errors');
  void ServerNotConfiguredError;
  return {
    firebaseReady: () => true,
    requireFirebase: () => ({
      auth: { verifyIdToken: state.verifyIdToken },
      db: state.buildDb(),
    }),
    resetFirebaseForTests: () => undefined,
  };
});

import { createApp } from './app';
import {
  normalizeGcashNumber,
  validateGcashDetails,
  validatePaymentDecision,
} from './lib/validation';

function gcashOrder(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'g1',
    customerId: 'cust-1',
    customerSnapshot: { uid: 'cust-1', name: 'Juan', email: '', phone: '' },
    addressSnapshot: {},
    items: [],
    subtotal: 200,
    deliveryFee: 0,
    total: 200,
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

describe('manual GCash verification', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    state.store.roles = new Map([
      ['admin-1', 'admin'],
      ['cust-1', 'customer'],
      ['cust-2', 'customer'],
    ]);
    state.store.products = new Map([
      [
        'p1',
        {
          name: 'House Latte',
          imageUrl: 'assets/products/latte.png',
          available: true,
          sugarOptions: ['Regular'],
          smallPrice: 100,
          mediumPrice: 120,
          largePrice: 150,
        },
      ],
    ]);
    const proof = {
      url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/bistrobuddies/proof.png',
      publicId: 'bistrobuddies/proof',
      mimeType: 'image/png',
      size: 128,
      submittedBy: 'cust-1',
      submittedAt: '2026-10-16T00:00:00.000Z',
    };

    state.store.orders = new Map([
      ['g-pending', gcashOrder({ id: 'g-pending', paymentProof: proof })],
      [
        'g-verifying',
        gcashOrder({
          id: 'g-verifying',
          paymentStatus: 'VERIFYING',
          gcashDetails: {
            accountName: 'Juan dela Cruz',
            accountNumber: '09171234567',
            submittedBy: 'cust-1',
            submittedAt: '2026-10-16T00:00:00.000Z',
          },
          paymentProof: proof,
        }),
      ],
      ['g-other', gcashOrder({ id: 'g-other', customerId: 'cust-2' })],
      [
        'c-cod',
        gcashOrder({
          id: 'c-cod',
          paymentMethod: 'COD',
          paymentStatus: 'PENDING',
        }),
      ],
      // Historical order: predates GCash fields entirely.
      [
        'h-old',
        {
          id: 'h-old',
          customerId: 'cust-1',
          items: [],
          subtotal: 150,
          deliveryFee: 0,
          total: 150,
          paymentMethod: 'COD',
          orderStatus: 'COMPLETED',
        },
      ],
      [
        'g-paid',
        gcashOrder({
          id: 'g-paid',
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
            {
              from: 'PENDING',
              to: 'VERIFYING',
              actorUid: 'cust-1',
              actorRole: 'customer',
            },
            {
              from: 'VERIFYING',
              to: 'PAID',
              actorUid: 'admin-1',
              actorRole: 'admin',
            },
          ],
        }),
      ],
      [
        'g-rejected',
        gcashOrder({
          id: 'g-rejected',
          paymentStatus: 'REJECTED',
          gcashDetails: {
            accountName: 'Juan dela Cruz',
            accountNumber: '09171234567',
            submittedBy: 'cust-1',
            submittedAt: '2026-10-16T00:00:00.000Z',
          },
          paymentProof: proof,
        }),
      ],
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

  function submitDetails(
    orderId: string,
    token: string | null,
    body: unknown
  ) {
    return fetch(`${base}/api/orders/${orderId}/gcash-details`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function decide(orderId: string, token: string | null, body: unknown) {
    return fetch(`${base}/api/admin/orders/${orderId}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  describe('PH number validation', () => {
    it('accepts and normalizes the documented formats', () => {
      expect(normalizeGcashNumber('09171234567')).toBe('09171234567');
      expect(normalizeGcashNumber('+639171234567')).toBe('09171234567');
      expect(normalizeGcashNumber('639171234567')).toBe('09171234567');
      expect(normalizeGcashNumber('0917 123 4567')).toBe('09171234567');
      expect(normalizeGcashNumber('0917-123-4567')).toBe('09171234567');
      expect(normalizeGcashNumber('(0917) 123-4567')).toBe('09171234567');
    });

    it('rejects landlines, short codes, foreign and non-numeric input', () => {
      expect(normalizeGcashNumber('0212345678')).toBeNull();
      expect(normalizeGcashNumber('123')).toBeNull();
      expect(normalizeGcashNumber('0917123456')).toBeNull();
      expect(normalizeGcashNumber('091712345678')).toBeNull();
      expect(normalizeGcashNumber('+14155552671')).toBeNull();
      expect(normalizeGcashNumber('0917abcdefg')).toBeNull();
      expect(normalizeGcashNumber('')).toBeNull();
      expect(normalizeGcashNumber(9171234567)).toBeNull();
    });

    it('trims and collapses the account name', () => {
      const result = validateGcashDetails({
        accountName: '  Juan   dela   Cruz  ',
        accountNumber: '09171234567',
      });
      expect(result).toEqual({
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
    });

    it('rejects invalid names and numbers with field details', async () => {
      const badName = await submitDetails('g-pending', 'valid-customer', {
        accountName: 'J',
        accountNumber: '09171234567',
      });
      expect(badName.status).toBe(400);

      const badNumber = await submitDetails('g-pending', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '0212345678',
      });
      expect(badNumber.status).toBe(400);
      const body = (await badNumber.json()) as {
        error: { code: string; details?: Array<{ field: string }> };
      };
      expect(body.error.code).toBe('invalid_request');
      expect(
        (body.error.details ?? []).some((d) => d.field === 'accountNumber')
      ).toBe(true);
    });

    it('rejects unknown payment decisions', () => {
      expect(() => validatePaymentDecision({ decision: 'VERIFYING' })).toThrow();
      expect(() => validatePaymentDecision({ decision: 'PENDING' })).toThrow();
      expect(() => validatePaymentDecision({})).toThrow();
      expect(validatePaymentDecision({ decision: 'PAID' })).toBe('PAID');
      expect(validatePaymentDecision({ decision: 'REJECTED' })).toBe('REJECTED');
    });
  });

  describe('POST /api/orders/:id/gcash-details', () => {
    it('stores valid details and moves PENDING to VERIFYING', async () => {
      const response = await submitDetails('g-pending', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '+639171234567',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        id: 'g-pending',
        paymentStatus: 'VERIFYING',
        gcashDetails: {
          accountName: 'Juan dela Cruz',
          accountNumber: '09171234567',
        },
      });

      const stored = state.store.orders.get('g-pending') as Record<string, unknown>;
      expect(stored['paymentStatus']).toBe('VERIFYING');
      expect(stored['total']).toBe(200); // historical totals untouched
      const details = stored['gcashDetails'] as Record<string, unknown>;
      expect(details['accountName']).toBe('Juan dela Cruz');
      expect(details['accountNumber']).toBe('09171234567');
      expect(details['submittedBy']).toBe('cust-1');
      const audit = stored['paymentAudit'] as Array<Record<string, unknown>>;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        from: 'PENDING',
        to: 'VERIFYING',
        actorUid: 'cust-1',
        actorRole: 'customer',
      });
    });

    it('ignores client-supplied totals, statuses and credentials', async () => {
      const response = await submitDetails('g-pending', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
        total: 1,
        subtotal: 1,
        paymentStatus: 'PAID',
        pin: '1234',
        otp: '999999',
        password: 'secret',
      });
      expect(response.status).toBe(200);
      const stored = state.store.orders.get('g-pending') as Record<string, unknown>;
      expect(stored['total']).toBe(200);
      expect(stored['paymentStatus']).toBe('VERIFYING');
      expect(stored).not.toHaveProperty('pin');
      expect(stored).not.toHaveProperty('otp');
      expect(stored).not.toHaveProperty('password');
      const details = stored['gcashDetails'] as Record<string, unknown>;
      expect(Object.keys(details).sort()).toEqual(
        ['accountName', 'accountNumber', 'submittedAt', 'submittedBy'].sort()
      );
    });

    it('requires authentication', async () => {
      const response = await submitDetails('g-pending', null, {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(response.status).toBe(401);
    });

    it('hides another customer behind 404', async () => {
      const post = await submitDetails('g-other', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(post.status).toBe(404);

      const get = await fetch(`${base}/api/orders/g-other`, {
        headers: { Authorization: 'Bearer valid-customer' },
      });
      expect(get.status).toBe(404);
    });

    it('rejects COD orders', async () => {
      const cod = await submitDetails('c-cod', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(cod.status).toBe(409);
      expect(((await cod.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_payment_method'
      );
    });

    it('returns 404 for a missing order', async () => {
      const response = await submitDetails('missing', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(response.status).toBe(404);
    });

    it('allows safe resubmission while VERIFYING', async () => {
      const first = await submitDetails('g-verifying', 'valid-customer', {
        accountName: 'Juan D Cruz',
        accountNumber: '639171234567',
      });
      expect(first.status).toBe(200);
      const second = await submitDetails('g-verifying', 'valid-customer', {
        accountName: 'Juan D Cruz',
        accountNumber: '639171234567',
      });
      expect(second.status).toBe(200);
      const stored = state.store.orders.get('g-verifying') as Record<string, unknown>;
      expect(stored['paymentStatus']).toBe('VERIFYING');
      const details = stored['gcashDetails'] as Record<string, unknown>;
      expect(details['accountNumber']).toBe('09171234567');
    });

    it('allows resubmission after a rejection', async () => {
      const response = await submitDetails('g-rejected', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { paymentStatus: string }).paymentStatus).toBe(
        'VERIFYING'
      );
      expect(
        (state.store.orders.get('g-rejected') as Record<string, unknown>)[
          'paymentStatus'
        ]
      ).toBe('VERIFYING');
    });

    it('refuses new details once PAID', async () => {
      const response = await submitDetails('g-paid', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'payment_already_confirmed'
      );
    });
  });

  describe('POST /api/admin/orders/:id/payment', () => {
    it('requires authentication and the admin role', async () => {
      const anon = await decide('g-verifying', null, { decision: 'PAID' });
      expect(anon.status).toBe(401);

      const customer = await decide('g-verifying', 'valid-customer', {
        decision: 'PAID',
      });
      expect(customer.status).toBe(403);
    });

    it('confirms a VERIFYING payment without touching fulfilment', async () => {
      const response = await decide('g-verifying', 'valid-admin', {
        decision: 'PAID',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: 'g-verifying',
        paymentStatus: 'PAID',
      });

      const stored = state.store.orders.get('g-verifying') as Record<string, unknown>;
      expect(stored['paymentStatus']).toBe('PAID');
      expect(stored['orderStatus']).toBe('PENDING'); // fulfilment untouched
      const decision = stored['paymentDecision'] as Record<string, unknown>;
      expect(decision['decision']).toBe('PAID');
      expect(decision['decidedBy']).toBe('admin-1');
      expect(decision['decidedAt']).toBeDefined();
      const audit = stored['paymentAudit'] as Array<Record<string, unknown>>;
      expect(audit[audit.length - 1]).toMatchObject({
        from: 'VERIFYING',
        to: 'PAID',
        actorUid: 'admin-1',
        actorRole: 'admin',
      });
    });

    it('rejects a VERIFYING payment', async () => {
      const response = await decide('g-verifying', 'valid-admin', {
        decision: 'REJECTED',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: 'g-verifying',
        paymentStatus: 'REJECTED',
      });
    });

    it('requires submitted details before deciding', async () => {
      const response = await decide('g-pending', 'valid-admin', {
        decision: 'PAID',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'payment_details_required'
      );
    });

    it('rejects invalid decisions and non-GCash orders', async () => {
      for (const body of [
        { decision: 'VERIFYING' },
        { decision: 'PENDING' },
        { decision: 'BOGUS' },
        {},
      ]) {
        const response = await decide('g-verifying', 'valid-admin', body);
        expect(response.status).toBe(400);
      }

      // COD has its own explicit collection action: PAID is accepted, while
      // REJECTED is not meaningful for cash on delivery.
      const cod = await decide('c-cod', 'valid-admin', { decision: 'PAID' });
      expect(cod.status).toBe(200);
      const codRejected = await decide('c-cod', 'valid-admin', {
        decision: 'REJECTED',
      });
      expect(codRejected.status).toBe(409);

      const missing = await decide('missing', 'valid-admin', { decision: 'PAID' });
      expect(missing.status).toBe(404);
    });

    it('treats a repeated identical decision as a no-op without writes', async () => {
      const first = await decide('g-paid', 'valid-admin', { decision: 'PAID' });
      expect(first.status).toBe(200);
      const writesAfterFirst = state.store.writes;

      const second = await decide('g-paid', 'valid-admin', { decision: 'PAID' });
      expect(second.status).toBe(200);
      expect(state.store.writes).toBe(writesAfterFirst);
      expect(
        (state.store.orders.get('g-paid') as Record<string, unknown>)[
          'paymentStatus'
        ]
      ).toBe('PAID');
    });

    it('never overwrites a confirmed payment', async () => {
      const response = await decide('g-paid', 'valid-admin', {
        decision: 'REJECTED',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_payment_transition'
      );
    });

    it('never flips REJECTED to PAID without a customer resubmission', async () => {
      const direct = await decide('g-rejected', 'valid-admin', {
        decision: 'PAID',
      });
      expect(direct.status).toBe(409);

      // Valid workflow: customer resubmits, then the admin confirms.
      const resubmit = await submitDetails('g-rejected', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(resubmit.status).toBe(200);

      const confirm = await decide('g-rejected', 'valid-admin', {
        decision: 'PAID',
      });
      expect(confirm.status).toBe(200);
      expect(await confirm.json()).toEqual({
        id: 'g-rejected',
        paymentStatus: 'PAID',
      });
    });

    it('keeps concurrent identical decisions consistent', async () => {
      const [first, second] = await Promise.all([
        decide('g-verifying', 'valid-admin', { decision: 'PAID' }),
        decide('g-verifying', 'valid-admin', { decision: 'PAID' }),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(
        (state.store.orders.get('g-verifying') as Record<string, unknown>)[
          'paymentStatus'
        ]
      ).toBe('PAID');
      expect(
        (state.store.orders.get('g-verifying') as Record<string, unknown>)[
          'orderStatus'
        ]
      ).toBe('PENDING');
    });
  });

  describe('customer payment status and backward compatibility', () => {
    it('exposes payment status and details to the owner, hiding admin metadata', async () => {
      await submitDetails('g-pending', 'valid-customer', {
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      await decide('g-pending', 'valid-admin', { decision: 'PAID' });

      const owner = await fetch(`${base}/api/orders/g-pending`, {
        headers: { Authorization: 'Bearer valid-customer' },
      });
      expect(owner.status).toBe(200);
      const ownerBody = (await owner.json()) as Record<string, unknown>;
      expect(ownerBody['paymentStatus']).toBe('PAID');
      expect(ownerBody['gcashDetails']).toMatchObject({
        accountName: 'Juan dela Cruz',
        accountNumber: '09171234567',
      });
      expect(ownerBody).not.toHaveProperty('paymentDecision');
      expect(ownerBody).not.toHaveProperty('paymentAudit');

      const admin = await fetch(`${base}/api/orders/g-pending`, {
        headers: { Authorization: 'Bearer valid-admin' },
      });
      expect(admin.status).toBe(200);
      const adminBody = (await admin.json()) as Record<string, unknown>;
      expect(adminBody['paymentStatus']).toBe('PAID');
      expect(adminBody['gcashDetails']).toMatchObject({
        accountName: 'Juan dela Cruz',
      });
      expect(adminBody['paymentDecision']).toMatchObject({
        decision: 'PAID',
        decidedBy: 'admin-1',
      });
      expect(Array.isArray(adminBody['paymentAudit'])).toBe(true);
    });

    it('returns historical orders without new fields unchanged', async () => {
      const response = await fetch(`${base}/api/orders/h-old`, {
        headers: { Authorization: 'Bearer valid-customer' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['total']).toBe(150);
      expect(body['subtotal']).toBe(150);
      expect(body['paymentStatus']).toBe('PENDING');
      expect(body['gcashDetails']).toBeNull();
      expect(body['orderStatus']).toBe('COMPLETED');
      expect(body).not.toHaveProperty('paymentDecision');
    });

    it('keeps COD order creation working (regression)', async () => {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify({
          items: [{ productId: 'p1', size: 'small', sugar: 'Regular', quantity: 2 }],
          customer: { name: 'Juan dela Cruz', phone: '09171234567' },
          address: {
            recipientName: 'Juan dela Cruz',
            phone: '09171234567',
            address: '123 Rizal St, Manila',
          },
          customerComment: '',
          paymentMethod: 'COD',
        }),
      });
      expect(response.status).toBe(201);
      const summary = (await response.json()) as Record<string, unknown>;
      expect(summary['subtotal']).toBe(200);
      expect(summary['paymentStatus']).toBe('PENDING');
    });

    it('accepts GCASH on creation but rejects unknown methods', async () => {
      async function createWith(paymentMethod: string) {
        return fetch(`${base}/api/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid-customer',
          },
          body: JSON.stringify({
            items: [
              { productId: 'p1', size: 'small', sugar: 'Regular', quantity: 1 },
            ],
            customer: { name: 'Juan dela Cruz', phone: '09171234567' },
            address: {
              recipientName: 'Juan dela Cruz',
              phone: '09171234567',
              address: '123 Rizal St, Manila',
            },
            customerComment: '',
            paymentMethod,
          }),
        });
      }

      expect((await createWith('GCASH')).status).toBe(201);
      expect((await createWith('ONLINE')).status).toBe(400);
      expect((await createWith('BITCOIN')).status).toBe(400);
    });
  });
});
