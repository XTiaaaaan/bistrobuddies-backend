import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../firebase/admin', () => ({
  requireFirebase: vi.fn(),
  firebaseReady: vi.fn(() => true),
  resetFirebaseForTests: vi.fn(),
}));

import { requireFirebase } from '../firebase/admin';
import {
  createProduct,
  getProduct,
  listProducts,
  serializeProduct,
  updateProduct,
} from './products.service';

interface ProductStore {
  created: Record<string, unknown>[];
  updated: { id: string; patch: Record<string, unknown> }[];
}

function makeDb(products: Record<string, Record<string, unknown>>): {
  db: unknown;
} & ProductStore {
  const created: Record<string, unknown>[] = [];
  const updated: { id: string; patch: Record<string, unknown> }[] = [];
  const byId = new Map(Object.entries(products));

  const db = {
    doc: (path: string) => ({
      get: async () => {
        if (path.startsWith('products/')) {
          const id = path.slice('products/'.length);
          const data = byId.get(id) ?? null;
          return { exists: data !== null, data: () => data };
        }
        return { exists: false, data: () => undefined };
      },
      update: async (patch: Record<string, unknown>) => {
        if (path.startsWith('products/')) {
          updated.push({ id: path.slice('products/'.length), patch });
        }
      },
      delete: async () => undefined,
      set: async () => undefined,
    }),
    collection: (name: string) => ({
      doc: (id?: string) => ({
        id: id ?? 'new-product-1',
        set: async (payload: Record<string, unknown>) => {
          if (name === 'products') {
            created.push(payload);
          }
        },
      }),
      get: async () => ({
        docs: [...byId.entries()]
          .filter(([, data]) => data !== null)
          .map(([id, data]) => ({ id, data: () => data })),
      }),
    }),
  };

  return { db, created, updated };
}

function mockWith(products: Record<string, Record<string, unknown>>) {
  const store = makeDb(products);
  vi.mocked(requireFirebase).mockReturnValue({
    auth: {} as never,
    db: store.db as never,
  });
  return store;
}

const legacyProduct: Record<string, unknown> = {
  name: 'House Latte',
  description: 'Creamy latte',
  category: 'Hot',
  imageUrl: 'assets/products/latte.png',
  cloudinaryPublicId: '',
  smallPrice: 99,
  mediumPrice: 119,
  largePrice: 139,
  sugarOptions: ['No Sugar', 'Regular'],
  available: true,
};

function createInput(
  overrides: Record<string, unknown> = {}
): Parameters<typeof createProduct>[0] {
  return {
    name: 'House Latte',
    description: 'Creamy latte',
    category: 'Hot',
    imageUrl: 'assets/products/latte.png',
    cloudinaryPublicId: '',
    smallPrice: 99,
    mediumPrice: 119,
    largePrice: 139,
    sugarOptions: ['No Sugar', 'Regular'],
    available: true,
    ...overrides,
  } as Parameters<typeof createProduct>[0];
}

describe('products.service writes (standardized schema)', () => {
  beforeEach(() => {
    vi.mocked(requireFirebase).mockReset();
  });

  it('creates a product with a derived canonical price and PHP currency', async () => {
    const store = mockWith({});
    const result = await createProduct(createInput());
    expect(result.id).toBe('new-product-1');
    expect(store.created).toHaveLength(1);

    const payload = store.created[0];
    expect(payload['name']).toBe('House Latte');
    expect(payload['category']).toBe('Hot');
    expect(payload['currency']).toBe('PHP');
    expect(payload['price']).toBe(119); // canonical = medium (standard) tier
    expect(payload['smallPrice']).toBe(99);
    expect(payload['mediumPrice']).toBe(119);
    expect(payload['largePrice']).toBe(139);
    expect(payload['createdAt']).toBeDefined();
    expect(payload['updatedAt']).toBeDefined();
  });

  it('backfills size tiers when creating from a single canonical price', async () => {
    const store = mockWith({});
    await createProduct(
      createInput({
        smallPrice: undefined,
        mediumPrice: undefined,
        largePrice: undefined,
        price: 88,
      })
    );
    const payload = store.created[0];
    expect(payload['price']).toBe(88);
    expect(payload['smallPrice']).toBe(88);
    expect(payload['mediumPrice']).toBe(88);
    expect(payload['largePrice']).toBe(88);
    expect(payload['currency']).toBe('PHP');
  });

  it('re-derives the canonical price when a size tier is patched', async () => {
    const store = mockWith({ p1: legacyProduct });
    await updateProduct('p1', { mediumPrice: 130 });
    const { patch } = store.updated[0];
    expect(patch['mediumPrice']).toBe(130);
    expect(patch['price']).toBe(130);
    expect(patch['currency']).toBe('PHP');
    expect(patch['updatedAt']).toBeDefined();
    expect(patch['createdAt']).toBeUndefined();
  });

  it('backfills all size tiers when only the canonical price is patched', async () => {
    const store = mockWith({ p1: legacyProduct });
    await updateProduct('p1', { price: 150 });
    const { patch } = store.updated[0];
    expect(patch['price']).toBe(150);
    expect(patch['smallPrice']).toBe(150);
    expect(patch['mediumPrice']).toBe(150);
    expect(patch['largePrice']).toBe(150);
  });

  it('normalizes legacy documents on any update (price + currency)', async () => {
    const store = mockWith({
      p1: { ...legacyProduct, smallPrice: 100, mediumPrice: 100, largePrice: 100 },
    });
    await updateProduct('p1', { available: false });
    const { patch } = store.updated[0];
    expect(patch['available']).toBe(false);
    expect(patch['price']).toBe(100);
    expect(patch['currency']).toBe('PHP');
  });
});

describe('products.service reads (public catalog)', () => {
  beforeEach(() => {
    vi.mocked(requireFirebase).mockReset();
  });

  it('serializes the standardized payload from a legacy document', () => {
    const product = serializeProduct('p1', legacyProduct);
    expect(product).toMatchObject({
      id: 'p1',
      name: 'House Latte',
      category: 'Hot',
      description: 'Creamy latte',
      imageUrl: 'assets/products/latte.png',
      price: 119,
      currency: 'PHP',
      available: true,
      smallPrice: 99,
      mediumPrice: 119,
      largePrice: 139,
      sugarOptions: ['No Sugar', 'Regular'],
      createdAt: null,
      updatedAt: null,
    });
  });

  it('lists products newest-first with standardized fields', async () => {
    mockWith({
      older: { ...legacyProduct, price: 10, createdAt: { toMillis: () => 1000 } },
      newer: { ...legacyProduct, price: 20, createdAt: { toMillis: () => 2000 } },
    });
    const products = await listProducts();
    expect(products.map((entry) => entry.id)).toEqual(['newer', 'older']);
    expect(products[0].price).toBe(20);
    expect(products[0].currency).toBe('PHP');
    expect(products[0].createdAt).toBe(new Date(2000).toISOString());
  });

  it('returns a single product or 404', async () => {
    mockWith({ p1: legacyProduct });
    await expect(getProduct('p1')).resolves.toMatchObject({
      id: 'p1',
      price: 119,
      currency: 'PHP',
    });
    await expect(getProduct('missing')).rejects.toMatchObject({
      status: 404,
      code: 'product_not_found',
    });
  });
});
