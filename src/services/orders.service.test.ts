import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors';

vi.mock('../firebase/admin', () => ({
  requireFirebase: vi.fn(),
  firebaseReady: vi.fn(() => true),
  resetFirebaseForTests: vi.fn(),
}));

import { requireFirebase } from '../firebase/admin';
import { createOrder } from './orders.service';

interface ProductDoc {
  id: string;
  data: Record<string, unknown> | null;
}

function makeDb(products: ProductDoc[]) {
  const created: Record<string, unknown>[] = [];
  const byId = new Map(products.map((p) => [p.id, p.data]));

  return {
    created,
    doc: (path: string) => ({
      get: async () => {
        if (path.startsWith('products/')) {
          const id = path.slice('products/'.length);
          const data = byId.get(id) ?? null;
          return { exists: data !== null, data: () => data };
        }
        return { exists: false, data: () => undefined };
      },
      set: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    }),
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'order-created-1',
        set: async (payload: Record<string, unknown>) => {
          if (name === 'orders') {
            created.push(payload);
          }
        },
      }),
    }),
  };
}

const availableProduct = {
  name: 'House Latte',
  imageUrl: 'assets/products/latte.png',
  available: true,
  sugarOptions: ['No Sugar', 'Regular'],
  smallPrice: 100,
  mediumPrice: 120,
  largePrice: 140,
};

function request() {
  return {
    items: [{ productId: 'p1', size: 'small' as const, sugar: 'Regular', quantity: 2 }],
    customer: { name: 'Juan dela Cruz', phone: '09171234567' },
    address: {
      recipientName: 'Juan dela Cruz',
      phone: '09171234567',
      address: '123 Rizal St, Manila',
    },
    customerComment: 'ring bell',
    paymentMethod: 'COD' as const,
  };
}

describe('createOrder (server-side pricing)', () => {
  beforeEach(() => {
    vi.mocked(requireFirebase).mockReset();
  });

  it('computes prices from the product document, not the client', async () => {
    const db = makeDb([{ id: 'p1', data: availableProduct }]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    const summary = await createOrder(
      { uid: 'u1', email: 'juan@example.com' },
      request()
    );

    expect(summary.subtotal).toBe(200); // 100 x 2 — from product doc
    expect(summary.deliveryFee).toBe(0); // DELIVERY_FEE default
    expect(summary.total).toBe(200);
    expect(summary.currency).toBe('PHP');
    expect(summary.orderStatus).toBe('PENDING');
    expect(summary.paymentStatus).toBe('PENDING');

    expect(db.created).toHaveLength(1);
    const order = db.created[0] as Record<string, unknown>;
    expect(order['customerId']).toBe('u1');
    expect(order['customerSnapshot']).toEqual({
      uid: 'u1',
      name: 'Juan dela Cruz',
      email: 'juan@example.com',
      phone: '09171234567',
    });
    expect(order['orderStatus']).toBe('PENDING');
    expect(order['paymentStatus']).toBe('PENDING');
    expect(order['addressSnapshot']).toMatchObject({
      recipientName: 'Juan dela Cruz',
      address: '123 Rizal St, Manila',
    });

    const items = order['items'] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      productId: 'p1',
      productName: 'House Latte',
      imageUrl: 'assets/products/latte.png',
      size: 'small',
      sugar: 'Regular',
      quantity: 2,
      unitPrice: 100,
      subtotal: 200,
    });
  });

  it('picks the price for the requested size', async () => {
    const db = makeDb([{ id: 'p1', data: availableProduct }]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    const body = request();
    body.items[0] = { productId: 'p1', size: 'large', sugar: 'Regular', quantity: 1 };
    const summary = await createOrder({ uid: 'u1', email: null }, body);
    expect(summary.subtotal).toBe(140);
  });

  it('falls back to the canonical price for single-price products', async () => {
    const db = makeDb([
      {
        id: 'p1',
        data: {
          name: 'Bottled Water',
          imageUrl: '',
          available: true,
          sugarOptions: ['Regular'],
          price: 25,
          currency: 'PHP',
        },
      },
    ]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    const summary = await createOrder({ uid: 'u1', email: null }, request());
    expect(summary.subtotal).toBe(50); // 25 x 2 — no size tiers stored
    expect(summary.currency).toBe('PHP');

    const order = db.created[0] as Record<string, unknown>;
    expect(order['currency']).toBe('PHP');
    const items = order['items'] as Array<Record<string, unknown>>;
    expect(items[0]['unitPrice']).toBe(25);
    expect(items[0]['currency']).toBe('PHP');
  });

  it('rejects invalid quantities even when request validation is bypassed', async () => {
    const db = makeDb([{ id: 'p1', data: availableProduct }]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    const body = request();
    body.items[0].quantity = 0;
    await expect(
      createOrder({ uid: 'u1', email: null }, body)
    ).rejects.toMatchObject({ status: 400, code: 'invalid_quantity' });
    expect(db.created).toHaveLength(0);
  });

  it('rejects orders for missing products', async () => {
    const db = makeDb([]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    await expect(
      createOrder({ uid: 'u1', email: null }, request())
    ).rejects.toMatchObject({ status: 404, code: 'product_not_found' });
  });

  it('rejects orders for unavailable products', async () => {
    const db = makeDb([
      { id: 'p1', data: { ...availableProduct, available: false } },
    ]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    await expect(
      createOrder({ uid: 'u1', email: null }, request())
    ).rejects.toMatchObject({ status: 409, code: 'product_unavailable' });
  });

  it('rejects sugar options the product does not offer', async () => {
    const db = makeDb([{ id: 'p1', data: availableProduct }]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    const body = request();
    body.items[0] = { productId: 'p1', size: 'small', sugar: 'Keto', quantity: 1 };
    await expect(createOrder({ uid: 'u1', email: null }, body)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_sugar_option',
    });
  });

  it('rejects products without a valid price for the size', async () => {
    const db = makeDb([
      { id: 'p1', data: { ...availableProduct, smallPrice: 0 } },
    ]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    await expect(
      createOrder({ uid: 'u1', email: null }, request())
    ).rejects.toMatchObject({ status: 422, code: 'invalid_product_price' });
  });

  it('stores an empty email when the token has none', async () => {
    const db = makeDb([{ id: 'p1', data: availableProduct }]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });

    await createOrder({ uid: 'u1', email: null }, request());
    const order = db.created[0] as {
      customerSnapshot: { email: string };
    };
    expect(order.customerSnapshot.email).toBe('');
  });

  it('throws ApiError subclasses only', async () => {
    const db = makeDb([]);
    vi.mocked(requireFirebase).mockReturnValue({
      auth: {} as never,
      db: db as never,
    });
    await createOrder({ uid: 'u1', email: null }, request()).catch((error) => {
      expect(error).toBeInstanceOf(ApiError);
    });
  });
});
