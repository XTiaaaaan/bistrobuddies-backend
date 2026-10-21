import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => new Date('2026-10-20T00:00:00.000Z'),
  },
}));

const state = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const users = new Map<string, Row>();
  const tokens = new Map<string, Row>();
  const events = new Map<string, Row>();
  const sendCalls: Array<{
    tokens: string[];
    notification: { title: string; body: string };
    data: Record<string, string>;
  }> = [];

  let sendImpl: (message: {
    tokens: string[];
  }) => Promise<{
    successCount: number;
    failureCount: number;
    responses: Array<{
      success: boolean;
      error?: { code: string };
    }>;
  }> = async (message) => ({
    successCount: message.tokens.length,
    failureCount: 0,
    responses: message.tokens.map(() => ({ success: true })),
  });

  function storeFor(collection: string): Map<string, Row> | null {
    if (collection === 'users') {
      return users;
    }
    if (collection === 'deviceTokens') {
      return tokens;
    }
    if (collection === 'notifications') {
      return events;
    }
    return null;
  }

  function docRef(path: string) {
    const separator = path.indexOf('/');
    const collection = separator === -1 ? path : path.slice(0, separator);
    const id = separator === -1 ? '' : path.slice(separator + 1);
    const store = storeFor(collection);

    return {
      __path: path,
      get: async () => {
        const data = store?.get(id);
        return { exists: data !== undefined, data: () => data };
      },
      set: async (
        payload: Row,
        options?: { merge?: boolean }
      ) => {
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

  function collectionRef(collection: string) {
    const store = storeFor(collection);
    const filters: Array<{ field: string; value: unknown }> = [];

    const query = {
      where(field: string, _op: string, value: unknown) {
        filters.push({ field, value });
        return query;
      },
      get: async () => {
        const docs: Array<{ id: string; data: () => Row }> = [];
        for (const [id, data] of store?.entries() ?? []) {
          if (filters.every((filter) => data[filter.field] === filter.value)) {
            docs.push({ id, data: () => data });
          }
        }
        return { docs };
      },
    };
    return query;
  }

  function buildDb() {
    return {
      doc: (path: string) => docRef(path),
      collection: (name: string) => collectionRef(name),
      runTransaction: async (
        fn: (tx: {
          get: (ref: unknown) => Promise<unknown>;
          set: (ref: unknown, payload: Row) => Promise<void>;
          update: (ref: unknown, patch: Row) => Promise<void>;
        }) => Promise<unknown>
      ) => {
        const tx = {
          get: (ref: unknown) =>
            (ref as ReturnType<typeof docRef>).get() as Promise<unknown>,
          set: (ref: unknown, payload: Row) =>
            (ref as ReturnType<typeof docRef>).set(payload),
          update: (ref: unknown, patch: Row) =>
            (ref as ReturnType<typeof docRef>).update(patch),
        };
        return fn(tx);
      },
    };
  }

  async function sendEachForMulticast(message: {
    tokens: string[];
    notification: { title: string; body: string };
    data: Record<string, string>;
  }) {
    sendCalls.push(message);
    return sendImpl(message);
  }

  function reset() {
    users.clear();
    tokens.clear();
    events.clear();
    sendCalls.length = 0;
    sendImpl = async (message) => ({
      successCount: message.tokens.length,
      failureCount: 0,
      responses: message.tokens.map(() => ({ success: true })),
    });
    users.set('admin-1', { uid: 'admin-1', role: 'admin' });
    users.set('admin-2', { uid: 'admin-2', role: 'admin' });
    users.set('cust-1', { uid: 'cust-1', role: 'customer' });
    users.set('cust-2', { uid: 'cust-2', role: 'customer' });
  }

  return {
    users,
    tokens,
    events,
    sendCalls,
    buildDb,
    sendEachForMulticast,
    reset,
    setSendImpl: (impl: typeof sendImpl) => {
      sendImpl = impl;
    },
  };
});

vi.mock('./firebase/admin', () => ({
  firebaseReady: () => true,
  requireFirebase: () => ({
    auth: {
      verifyIdToken: async () => {
        throw new Error('not used');
      },
    },
    db: state.buildDb(),
    messaging: { sendEachForMulticast: state.sendEachForMulticast },
  }),
  resetFirebaseForTests: () => undefined,
}));

import {
  allowedNextStatuses,
  ORDER_STATUS_LABELS,
  orderStatusLabel,
  validateOrderStatus,
} from './lib/validation';
import {
  deviceTokenDocId,
  notifyAdminsNewOrder,
  notifyAdminsPaymentProofSubmitted,
  notifyOrderStatusChanged,
  notifyPaymentDecision,
  registerDeviceToken,
  removeDeviceToken,
} from './services/notifications.service';

describe('OUT_FOR_DELIVERY status model', () => {
  it('accepts and labels OUT_FOR_DELIVERY consistently', () => {
    expect(validateOrderStatus({ orderStatus: 'OUT_FOR_DELIVERY' })).toBe(
      'OUT_FOR_DELIVERY'
    );
    expect(ORDER_STATUS_LABELS.OUT_FOR_DELIVERY).toBe('On the Way');
    expect(orderStatusLabel('OUT_FOR_DELIVERY')).toBe('On the Way');
  });

  it('supports the single delivery workflow path', () => {
    expect(allowedNextStatuses('CONFIRMED')).toContain('PREPARING');
    expect(allowedNextStatuses('PREPARING')).toContain('READY');
    expect(allowedNextStatuses('READY')).toContain('OUT_FOR_DELIVERY');
    expect(allowedNextStatuses('READY')).not.toContain('COMPLETED');
    expect(allowedNextStatuses('OUT_FOR_DELIVERY')).toContain('COMPLETED');
    expect(allowedNextStatuses('COMPLETED')).toEqual([]);
    expect(allowedNextStatuses('CANCELLED')).toEqual([]);
  });

  it('labels COMPLETED as Delivered for the customer-facing workflow', () => {
    expect(ORDER_STATUS_LABELS.COMPLETED).toBe('Delivered');
    expect(orderStatusLabel('COMPLETED')).toBe('Delivered');
  });

  it('never dispatches an order that is not READY yet', () => {
    for (const status of [
      'PENDING',
      'CONFIRMED',
      'PREPARING',
      'COMPLETED',
      'CANCELLED',
    ] as const) {
      expect(allowedNextStatuses(status)).not.toContain('OUT_FOR_DELIVERY');
    }
  });
});

describe('device token registration', () => {
  beforeEach(() => {
    state.reset();
  });

  it('associates multiple devices with the authenticated user', async () => {
    await registerDeviceToken(
      { uid: 'cust-1' },
      { token: 'customer-token-a', platform: 'android' }
    );
    await registerDeviceToken(
      { uid: 'cust-1' },
      { token: 'customer-token-b', platform: 'ios' }
    );

    expect(state.tokens.size).toBe(2);
    const stored = [...state.tokens.values()];
    expect(stored.map((row) => row['uid'])).toEqual(['cust-1', 'cust-1']);
    expect(stored.map((row) => row['platform']).sort()).toEqual([
      'android',
      'ios',
    ]);
  });

  it('refreshes an existing token without duplicating it', async () => {
    await registerDeviceToken(
      { uid: 'cust-1' },
      { token: 'same-token', platform: 'android' }
    );
    await registerDeviceToken(
      { uid: 'cust-1' },
      { token: 'same-token', platform: 'web' }
    );

    expect(state.tokens.size).toBe(1);
    const row = state.tokens.get(deviceTokenDocId('same-token'));
    expect(row?.['platform']).toBe('web');
    expect(row?.['uid']).toBe('cust-1');
  });

  it('only lets the owner remove a token', async () => {
    await registerDeviceToken(
      { uid: 'cust-1' },
      { token: 'owned-by-cust-1', platform: 'android' }
    );

    expect(
      await removeDeviceToken({ uid: 'cust-2' }, 'owned-by-cust-1')
    ).toEqual({ removed: false });
    expect(state.tokens.size).toBe(1);

    expect(
      await removeDeviceToken({ uid: 'cust-1' }, 'owned-by-cust-1')
    ).toEqual({ removed: true });
    expect(state.tokens.size).toBe(0);
  });
});

describe('notification routing', () => {
  beforeEach(async () => {
    state.reset();
    await registerDeviceToken(
      { uid: 'cust-1' },
      { token: 'customer-token', platform: 'android' }
    );
    await registerDeviceToken(
      { uid: 'cust-2' },
      { token: 'other-customer-token', platform: 'android' }
    );
    await registerDeviceToken(
      { uid: 'admin-1' },
      { token: 'admin-token-1', platform: 'web' }
    );
    await registerDeviceToken(
      { uid: 'admin-2' },
      { token: 'admin-token-2', platform: 'ios' }
    );
  });

  it('sends status updates only to the order customer', async () => {
    await notifyOrderStatusChanged('o1', 'cust-1', 'OUT_FOR_DELIVERY');

    expect(state.sendCalls).toHaveLength(1);
    const message = state.sendCalls[0];
    expect(message.tokens).toEqual(['customer-token']);
    expect(message.notification.title).toBe('On the Way');
    expect(message.notification.body).toBe(
      'Your coffee order is on the way!'
    );
    expect(message.data).toEqual({
      type: 'ORDER_STATUS',
      orderId: 'o1',
      orderStatus: 'OUT_FOR_DELIVERY',
      orderStatusLabel: 'On the Way',
    });
  });

  it('announces every fulfilment milestone and skips non-notifiable states', async () => {
    for (const status of [
      'CONFIRMED',
      'PREPARING',
      'READY',
      'OUT_FOR_DELIVERY',
      'COMPLETED',
    ]) {
      await notifyOrderStatusChanged('o1', 'cust-1', status);
    }
    expect(state.sendCalls).toHaveLength(5);
    expect(state.sendCalls.map((call) => call.data['orderStatus'])).toEqual([
      'CONFIRMED',
      'PREPARING',
      'READY',
      'OUT_FOR_DELIVERY',
      'COMPLETED',
    ]);

    await notifyOrderStatusChanged('o1', 'cust-1', 'PENDING');
    await notifyOrderStatusChanged('o1', 'cust-1', 'CANCELLED');
    expect(state.sendCalls).toHaveLength(5);
  });

  it('notifies every admin about a new order, never customers', async () => {
    await notifyAdminsNewOrder('o2');

    // One event per admin recipient keeps the idempotency records isolated.
    expect(state.sendCalls).toHaveLength(2);
    const tokens = state.sendCalls.flatMap((call) => call.tokens).sort();
    expect(tokens).toEqual(['admin-token-1', 'admin-token-2']);
    for (const call of state.sendCalls) {
      expect(call.data).toEqual({ type: 'ADMIN_NEW_ORDER', orderId: 'o2' });
      expect(call.notification.body).toContain('o2');
    }
  });

  it('notifies admins about GCash proof without payment details', async () => {
    await notifyAdminsPaymentProofSubmitted('o3', 'proof-public-id');

    expect(state.sendCalls).toHaveLength(2);
    const tokens = state.sendCalls.flatMap((call) => call.tokens).sort();
    expect(tokens).toEqual(['admin-token-1', 'admin-token-2']);
    for (const call of state.sendCalls) {
      expect(call.data).toEqual({
        type: 'ADMIN_PAYMENT_PROOF',
        orderId: 'o3',
      });
      expect(JSON.stringify(call)).not.toMatch(
        /accountNumber|0917|proofUrl/
      );
    }
  });

  it('sends GCash payment decisions to the customer only', async () => {
    await notifyPaymentDecision('o4', 'cust-1', 'PAID', 2);
    expect(state.sendCalls).toHaveLength(1);
    expect(state.sendCalls[0].tokens).toEqual(['customer-token']);
    expect(state.sendCalls[0].data).toEqual({
      type: 'PAYMENT_DECISION',
      orderId: 'o4',
      paymentStatus: 'PAID',
    });

    await notifyPaymentDecision('o4', 'cust-1', 'REJECTED', 3);
    expect(state.sendCalls).toHaveLength(2);
    expect(state.sendCalls[1].tokens).toEqual(['customer-token']);
    expect(state.sendCalls[1].notification.title).toBe('Payment rejected');
  });

  it('prevents duplicate notifications for the same event', async () => {
    await notifyOrderStatusChanged('o5', 'cust-1', 'CONFIRMED');
    await notifyOrderStatusChanged('o5', 'cust-1', 'CONFIRMED');
    expect(state.sendCalls).toHaveLength(1);

    // Two admins => two isolated admin events; repeating both is a no-op.
    await notifyAdminsNewOrder('o6');
    await notifyAdminsNewOrder('o6');
    expect(state.sendCalls).toHaveLength(3);

    await notifyPaymentDecision('o7', 'cust-1', 'PAID', 1);
    await notifyPaymentDecision('o7', 'cust-1', 'PAID', 1);
    expect(state.sendCalls).toHaveLength(4);
  });

  it('removes invalid FCM tokens without failing the operation', async () => {
    state.setSendImpl(async (message) => ({
      successCount: 0,
      failureCount: message.tokens.length,
      responses: message.tokens.map(() => ({
        success: false,
        error: { code: 'messaging/registration-token-not-registered' },
      })),
    }));

    await expect(
      notifyOrderStatusChanged('o8', 'cust-1', 'READY')
    ).resolves.toBeUndefined();

    expect(state.tokens.has(deviceTokenDocId('customer-token'))).toBe(false);
    // Other users' devices are unaffected.
    expect(state.tokens.has(deviceTokenDocId('other-customer-token'))).toBe(
      true
    );
  });

  it('records a delivery failure without throwing', async () => {
    state.setSendImpl(async () => {
      throw new Error('FCM unavailable');
    });

    await expect(
      notifyOrderStatusChanged('o9', 'cust-1', 'CONFIRMED')
    ).resolves.toBeUndefined();

    const failed = [...state.events.values()].find(
      (event) => event['orderId'] === 'o9'
    );
    expect(failed?.['status']).toBe('FAILED');
  });

  it('skips delivery when the recipient has no registered device', async () => {
    await notifyOrderStatusChanged('o10', 'missing-user', 'CONFIRMED');

    expect(state.sendCalls).toHaveLength(0);
    const skipped = [...state.events.values()].find(
      (event) => event['orderId'] === 'o10'
    );
    expect(skipped?.['status']).toBe('SKIPPED');
  });
});
