import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  type ProductRow = Record<string, unknown> | null;

  const store = {
    userRole: 'admin' as string | null,
    products: new Map<string, ProductRow>(),
    orders: new Map<string, Record<string, unknown>>(),
    createdOrders: [] as Record<string, unknown>[],
    createdProducts: [] as Record<string, unknown>[],
    updatedProducts: [] as { id: string; patch: Record<string, unknown> }[],
    deletedProducts: [] as string[],
    updatedOrders: [] as { id: string; patch: Record<string, unknown> }[],
    throwNotConfigured: false,
  };

  function buildDb() {
    return {
      doc: (path: string) => ({
        get: async () => {
          if (path.startsWith('users/')) {
            const role = store.userRole;
            return {
              exists: role !== null,
              data: () => (role !== null ? { role } : undefined),
            };
          }
          if (path.startsWith('products/')) {
            const id = path.slice('products/'.length);
            const data = store.products.get(id) ?? null;
            return { exists: data !== null, data: () => data };
          }
          if (path.startsWith('orders/')) {
            const id = path.slice('orders/'.length);
            const data = store.orders.get(id);
            return { exists: data !== undefined, data: () => data };
          }
          return { exists: false, data: () => undefined };
        },
        set: async () => undefined,
        update: async (patch: Record<string, unknown>) => {
          if (path.startsWith('orders/')) {
            store.updatedOrders.push({ id: path.slice('orders/'.length), patch });
          } else if (path.startsWith('products/')) {
            store.updatedProducts.push({
              id: path.slice('products/'.length),
              patch,
            });
          }
        },
        delete: async () => {
          if (path.startsWith('products/')) {
            store.deletedProducts.push(path.slice('products/'.length));
          }
        },
      }),
      collection: (name: string) => ({
        doc: (id?: string) => ({
          id: id ?? 'generated-1',
          set: async (payload: Record<string, unknown>) => {
            if (name === 'orders') {
              store.createdOrders.push(payload);
            } else if (name === 'products') {
              store.createdProducts.push(payload);
            }
          },
        }),
        get: async () => ({
          docs:
            name === 'products'
              ? [...store.products.entries()]
                  .filter(([, data]) => data !== null)
                  .map(([id, data]) => ({ id, data: () => data }))
              : [],
        }),
      }),
    };
  }

  async function verifyIdToken(token: string): Promise<{ uid: string; email?: string }> {
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

  return { store, buildDb, verifyIdToken };
});

vi.mock('./firebase/admin', async () => {
  const { ServerNotConfiguredError } = await import('./errors');
  return {
    firebaseReady: () => true,
    requireFirebase: () => {
      if (state.store.throwNotConfigured) {
        throw new ServerNotConfiguredError();
      }
      return {
        auth: { verifyIdToken: state.verifyIdToken },
        db: state.buildDb(),
      };
    },
    resetFirebaseForTests: () => undefined,
  };
});

import { createApp } from './app';

const AVAILABLE_PRODUCT: Record<string, unknown> = {
  name: 'House Latte',
  imageUrl: 'assets/products/latte.png',
  available: true,
  sugarOptions: ['Regular'],
  smallPrice: 100,
  mediumPrice: 120,
  largePrice: 140,
};

function orderBody(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ productId: 'p1', size: 'small', sugar: 'Regular', quantity: 2 }],
    customer: { name: 'Juan dela Cruz', phone: '09171234567' },
    address: {
      recipientName: 'Juan dela Cruz',
      phone: '09171234567',
      address: '123 Rizal St, Manila',
    },
    customerComment: '',
    paymentMethod: 'COD',
    ...overrides,
  };
}

function productBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'House Latte',
    description: 'Creamy latte',
    category: 'Hot',
    imageUrl: 'assets/products/latte.png',
    cloudinaryPublicId: '',
    smallPrice: 99,
    mediumPrice: 119,
    largePrice: 139,
    sugarOptions: ['Regular'],
    available: true,
    ...overrides,
  };
}

describe('bistrobuddies-backend HTTP API', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    state.store.userRole = 'admin';
    state.store.products = new Map([['p1', AVAILABLE_PRODUCT]]);
    state.store.orders = new Map([
      ['o1', { customerId: 'cust-1', orderStatus: 'PENDING' }],
      ['o2', { customerId: 'cust-2', orderStatus: 'COMPLETED' }],
    ]);
    state.store.createdOrders = [];
    state.store.createdProducts = [];
    state.store.updatedProducts = [];
    state.store.deletedProducts = [];
    state.store.updatedOrders = [];
    state.store.throwNotConfigured = false;

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

  it('GET /api/health returns ok with firebase status', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('bistrobuddies-backend');
    expect(body['firebaseConfigured']).toBe(true);
  });

  it('returns 404 for unknown endpoints', async () => {
    const response = await fetch(`${base}/api/definitely-not-a-route`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('rejects malformed JSON bodies', async () => {
    const response = await fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_json');
  });

  describe('POST /api/orders', () => {
    it('requires authentication', async () => {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody()),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('rejects invalid tokens', async () => {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer forged-token',
        },
        body: JSON.stringify(orderBody()),
      });
      expect(response.status).toBe(401);
    });

    it('creates an order with server-side pricing for a valid customer', async () => {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify(orderBody()),
      });
      expect(response.status).toBe(201);
      const summary = (await response.json()) as Record<string, unknown>;
      expect(summary['id']).toBe('generated-1');
      expect(summary['subtotal']).toBe(200);
      expect(summary['total']).toBe(200);
      expect(summary['orderStatus']).toBe('PENDING');
      expect(summary['paymentStatus']).toBe('PENDING');

      expect(state.store.createdOrders).toHaveLength(1);
      const order = state.store.createdOrders[0];
      expect(order['customerId']).toBe('cust-1');
      expect(order['orderStatus']).toBe('PENDING');
      expect(order['paymentStatus']).toBe('PENDING');
      expect((order['customerSnapshot'] as { email: string }).email).toBe(
        'customer@example.com'
      );
    });

    it('rejects unavailable products with 409', async () => {
      state.store.products.set('p1', {
        ...AVAILABLE_PRODUCT,
        available: false,
      });
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify(orderBody()),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('product_unavailable');
    });

    it('rejects invalid payloads with field details', async () => {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify({
          ...orderBody(),
          items: [{ productId: 'p1', size: 'small', sugar: 'Regular', quantity: 0 }],
        }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: unknown[] };
      };
      expect(body.error.code).toBe('invalid_request');
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(state.store.createdOrders).toHaveLength(0);
    });

    it('returns 503 when server credentials are missing', async () => {
      state.store.throwNotConfigured = true;
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify(orderBody()),
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('server_not_configured');
    });

    it('stores PHP currency on the order, its items and the response', async () => {
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify(orderBody()),
      });
      expect(response.status).toBe(201);
      const summary = (await response.json()) as Record<string, unknown>;
      expect(summary['currency']).toBe('PHP');

      const order = state.store.createdOrders[0];
      expect(order['currency']).toBe('PHP');
      const items = order['items'] as Array<Record<string, unknown>>;
      expect(items[0]['currency']).toBe('PHP');
      expect(items[0]['unitPrice']).toBe(100);
    });

    it('prices a standardized single-price product from the server record', async () => {
      state.store.products.set('single', {
        name: 'Bottled Water',
        category: 'Drinks',
        description: '500ml bottle',
        imageUrl: 'assets/products/water.png',
        price: 25,
        currency: 'PHP',
        available: true,
        sugarOptions: ['No Sugar'],
      });
      const response = await fetch(`${base}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-customer',
        },
        body: JSON.stringify(
          orderBody({
            items: [
              { productId: 'single', size: 'medium', sugar: 'No Sugar', quantity: 4 },
            ],
          })
        ),
      });
      expect(response.status).toBe(201);
      const summary = (await response.json()) as Record<string, unknown>;
      expect(summary['subtotal']).toBe(100);
      expect(summary['total']).toBe(100);
      expect(summary['currency']).toBe('PHP');
    });

    it('rate limits after 20 requests per minute', async () => {
      let lastStatus = 0;
      for (let i = 0; i < 21; i += 1) {
        const response = await fetch(`${base}/api/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(orderBody()),
        });
        lastStatus = response.status;
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe('admin product API', () => {
    function post(path: string, token: string | null, body: unknown) {
      return fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    }

    it('rejects unauthenticated product creation', async () => {
      const response = await post('/api/admin/products', null, productBody());
      expect(response.status).toBe(401);
    });

    it('rejects product creation by non-admin customers', async () => {
      state.store.userRole = 'customer';
      const response = await post(
        '/api/admin/products',
        'valid-customer',
        productBody()
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
      expect(state.store.createdProducts).toHaveLength(0);
    });

    it('creates a product for an admin', async () => {
      const response = await post(
        '/api/admin/products',
        'valid-admin',
        productBody()
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      expect(body.id).toBe('generated-1');
      expect(state.store.createdProducts).toHaveLength(1);
      expect(state.store.createdProducts[0]['name']).toBe('House Latte');
      expect(state.store.createdProducts[0]['createdAt']).toBeDefined();
    });

    it('standardizes price and PHP currency on create', async () => {
      const response = await post(
        '/api/admin/products',
        'valid-admin',
        productBody()
      );
      expect(response.status).toBe(201);
      const created = state.store.createdProducts[0];
      expect(created['currency']).toBe('PHP');
      // Canonical price derived from the medium (standard) size tier.
      expect(created['price']).toBe(119);
      expect(created['smallPrice']).toBe(99);
      expect(created['mediumPrice']).toBe(119);
      expect(created['largePrice']).toBe(139);
    });

    it('creates a single-price product from `price` alone', async () => {
      const body = productBody({ price: 88 });
      delete body['smallPrice'];
      delete body['mediumPrice'];
      delete body['largePrice'];

      const response = await post('/api/admin/products', 'valid-admin', body);
      expect(response.status).toBe(201);
      const created = state.store.createdProducts[0];
      expect(created['price']).toBe(88);
      expect(created['currency']).toBe('PHP');
      // Size tiers are backfilled so size-selector clients keep working.
      expect(created['smallPrice']).toBe(88);
      expect(created['mediumPrice']).toBe(88);
      expect(created['largePrice']).toBe(88);
    });

    it('validates product payloads', async () => {
      const response = await post(
        '/api/admin/products',
        'valid-admin',
        productBody({ smallPrice: -5 })
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('updates a product (PATCH)', async () => {
      const response = await fetch(`${base}/api/admin/products/p1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin',
        },
        body: JSON.stringify({ available: false }),
      });
      expect(response.status).toBe(200);
      expect(state.store.updatedProducts).toHaveLength(1);
      expect(state.store.updatedProducts[0].patch['available']).toBe(false);
      expect(state.store.updatedProducts[0].patch['updatedAt']).toBeDefined();
    });

    it('re-derives the canonical price when a size tier changes', async () => {
      const response = await fetch(`${base}/api/admin/products/p1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin',
        },
        body: JSON.stringify({ mediumPrice: 130 }),
      });
      expect(response.status).toBe(200);
      const patch = state.store.updatedProducts[0].patch;
      expect(patch['mediumPrice']).toBe(130);
      expect(patch['price']).toBe(130);
      expect(patch['currency']).toBe('PHP');
    });

    it('backfills size tiers when only the canonical price is patched', async () => {
      const response = await fetch(`${base}/api/admin/products/p1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin',
        },
        body: JSON.stringify({ price: 150 }),
      });
      expect(response.status).toBe(200);
      const patch = state.store.updatedProducts[0].patch;
      expect(patch['price']).toBe(150);
      expect(patch['smallPrice']).toBe(150);
      expect(patch['mediumPrice']).toBe(150);
      expect(patch['largePrice']).toBe(150);
    });

    it('returns 404 when patching a missing product', async () => {
      const response = await fetch(`${base}/api/admin/products/missing`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-admin',
        },
        body: JSON.stringify({ available: false }),
      });
      expect(response.status).toBe(404);
    });

    it('deletes a product', async () => {
      const response = await fetch(`${base}/api/admin/products/p1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-admin' },
      });
      expect(response.status).toBe(200);
      expect(state.store.deletedProducts).toContain('p1');
    });

    it('returns 404 when deleting a missing product', async () => {
      const response = await fetch(`${base}/api/admin/products/missing`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-admin' },
      });
      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/products (public catalog)', () => {
    const CANONICAL_FIELDS = [
      'name',
      'category',
      'description',
      'imageUrl',
      'price',
      'currency',
      'available',
      'createdAt',
      'updatedAt',
    ];

    it('serves the catalog without authentication', async () => {
      const response = await fetch(`${base}/api/products`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        products: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(body.products)).toBe(true);
      expect(body.products).toHaveLength(1);

      const product = body.products[0];
      expect(product['id']).toBe('p1');
      for (const field of CANONICAL_FIELDS) {
        expect(product).toHaveProperty(field);
      }
      expect(product['currency']).toBe('PHP');
      // Legacy document without a canonical price: derived from mediumPrice.
      expect(product['price']).toBe(120);
      expect(product['smallPrice']).toBe(100);
      expect(product['available']).toBe(true);
      expect(product['sugarOptions']).toEqual(['Regular']);
    });

    it('returns a single product without authentication', async () => {
      const response = await fetch(`${base}/api/products/p1`);
      expect(response.status).toBe(200);
      const product = (await response.json()) as Record<string, unknown>;
      expect(product['id']).toBe('p1');
      for (const field of CANONICAL_FIELDS) {
        expect(product).toHaveProperty(field);
      }
      expect(product['price']).toBe(120);
      expect(product['currency']).toBe('PHP');
    });

    it('exposes the canonical price of a single-price product', async () => {
      state.store.products.set('single', {
        name: 'Bottled Water',
        category: 'Drinks',
        description: '500ml bottle',
        imageUrl: 'assets/products/water.png',
        price: 25,
        currency: 'PHP',
        available: true,
        sugarOptions: ['No Sugar'],
      });
      const response = await fetch(`${base}/api/products/single`);
      expect(response.status).toBe(200);
      const product = (await response.json()) as Record<string, unknown>;
      expect(product['price']).toBe(25);
      expect(product['currency']).toBe('PHP');
      expect(product['smallPrice']).toBeNull();
      expect(product['available']).toBe(true);
    });

    it('returns 404 for an unknown product', async () => {
      const response = await fetch(`${base}/api/products/does-not-exist`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('product_not_found');
    });
  });

  describe('GET /api/orders/:id (ownership)', () => {
    function fetchOrder(orderId: string, token: string | null) {
      return fetch(`${base}/api/orders/${orderId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    }

    it('requires authentication', async () => {
      const response = await fetchOrder('o1', null);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('lets the owner read their own order with stored prices', async () => {
      state.store.userRole = 'customer';
      const response = await fetchOrder('o1', 'valid-customer');
      expect(response.status).toBe(200);
      const order = (await response.json()) as Record<string, unknown>;
      expect(order['id']).toBe('o1');
      expect(order['customerId']).toBe('cust-1');
      expect(order['orderStatus']).toBe('PENDING');
      expect(order['currency']).toBe('PHP');
    });

    it('hides other customers behind a 404 (no order id probing)', async () => {
      state.store.userRole = 'customer';
      const response = await fetchOrder('o1', 'valid-customer-2');
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('order_not_found');
    });

    it('returns 404 for a missing order', async () => {
      state.store.userRole = 'customer';
      const response = await fetchOrder('missing', 'valid-customer');
      expect(response.status).toBe(404);
    });

    it('lets an administrator read any order', async () => {
      state.store.userRole = 'admin';
      const response = await fetchOrder('o2', 'valid-admin');
      expect(response.status).toBe(200);
      const order = (await response.json()) as Record<string, unknown>;
      expect(order['id']).toBe('o2');
      expect(order['customerId']).toBe('cust-2');
    });
  });

  describe('POST /api/admin/orders/:id/status', () => {
    function postStatus(orderId: string, token: string, orderStatus: string) {
      return fetch(`${base}/api/admin/orders/${orderId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderStatus }),
      });
    }

    it('transitions PENDING to CONFIRMED for an admin', async () => {
      const response = await postStatus('o1', 'valid-admin', 'CONFIRMED');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { orderStatus: string };
      expect(body.orderStatus).toBe('CONFIRMED');
      expect(state.store.updatedOrders[0].patch['orderStatus']).toBe(
        'CONFIRMED'
      );
    });

    it('is idempotent for the current status', async () => {
      const response = await postStatus('o1', 'valid-admin', 'PENDING');
      expect(response.status).toBe(200);
      expect(state.store.updatedOrders).toHaveLength(0);
    });

    it('rejects illegal transitions', async () => {
      const response = await postStatus('o2', 'valid-admin', 'PENDING');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_status_transition');
    });

    it('rejects unknown statuses', async () => {
      const response = await postStatus('o1', 'valid-admin', 'BOGUS');
      expect(response.status).toBe(400);
    });

    it('returns 404 for missing orders', async () => {
      const response = await postStatus('nope', 'valid-admin', 'CONFIRMED');
      expect(response.status).toBe(404);
    });

    it('rejects customers (server-side admin authorization)', async () => {
      state.store.userRole = 'customer';
      const response = await postStatus('o1', 'valid-customer', 'CONFIRMED');
      expect(response.status).toBe(403);
      expect(state.store.updatedOrders).toHaveLength(0);
    });
  });

  describe('CORS', () => {
    it('allows configured dev origins', async () => {
      const response = await fetch(`${base}/api/health`, {
        headers: { Origin: 'http://localhost:4200' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:4200'
      );
    });

    it('does not allow unknown origins', async () => {
      const response = await fetch(`${base}/api/health`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
