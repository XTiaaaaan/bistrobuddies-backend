import { FieldValue } from 'firebase-admin/firestore';
import { notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { CURRENCY, isPositivePrice, resolvePrice } from '../lib/money';
import { timestampMs, toIso } from '../lib/serialize';
import { SIZE_PRICE_FIELDS, ValidatedProductInput } from '../lib/validation';

/**
 * Standardized product payload returned by the read API.
 *
 * Canonical fields: name, category, description, imageUrl, price, currency,
 * available, createdAt, updatedAt. The size-tiered prices and sugar options
 * are still returned because the existing mobile and admin clients depend on
 * them for the size selector and cart re-pricing.
 */
export interface ProductResponse {
  id: string;
  name: string;
  category: string;
  description: string;
  imageUrl: string;
  /** Canonical PHP list price (derived from the size tiers when unset). */
  price: number;
  currency: string;
  available: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  smallPrice: number | null;
  mediumPrice: number | null;
  largePrice: number | null;
  sugarOptions: string[];
  cloudinaryPublicId: string;
}

type PriceRecord = Record<string, unknown>;

function sizePrice(value: unknown): number | null {
  return isPositivePrice(value) ? value : null;
}

/**
 * Derives the canonical `price` from a product record. The size tiers win
 * over an explicitly supplied `price` so the canonical price can never drift
 * away from what customers are actually charged per size.
 */
function derivePrice(record: PriceRecord): number | null {
  return resolvePrice([
    record['mediumPrice'],
    record['smallPrice'],
    record['largePrice'],
    record['price'],
  ]);
}

/** Server-side product writes. Every caller must already have passed
 * requireAuth + requireAdmin; these functions do not re-check roles.
 * The written document shape matches the standardized product schema:
 * name, category, description, imageUrl, price, currency, available,
 * createdAt, updatedAt (plus the size tiers used by existing clients).
 */
export async function createProduct(
  input: ValidatedProductInput
): Promise<{ id: string }> {
  const { db } = requireFirebase();

  const productRef = db.collection('products').doc();
  // Validation guarantees at least one positive price source (canonical
  // `price` or the three size tiers); the missing side is backfilled so the
  // stored document is always coherent for every client.
  const smallPrice = input.smallPrice ?? input.price ?? 0;
  const mediumPrice = input.mediumPrice ?? input.price ?? 0;
  const largePrice = input.largePrice ?? input.price ?? 0;

  const payload = {
    id: productRef.id,
    name: input.name ?? '',
    description: input.description ?? '',
    category: input.category ?? '',
    imageUrl: input.imageUrl ?? '',
    // Legacy field kept for schema compatibility with existing documents.
    cloudinaryPublicId: input.cloudinaryPublicId ?? '',
    price:
      derivePrice({ smallPrice, mediumPrice, largePrice, price: input.price }) ??
      0,
    currency: CURRENCY,
    smallPrice,
    mediumPrice,
    largePrice,
    sugarOptions: input.sugarOptions ?? [],
    available: input.available ?? true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await productRef.set(payload);
  return { id: productRef.id };
}

export async function updateProduct(
  productId: string,
  input: ValidatedProductInput
): Promise<{ id: string }> {
  const { db } = requireFirebase();

  const productRef = db.doc(`products/${productId}`);
  const snapshot = await productRef.get();
  if (!snapshot.exists) {
    throw notFound('product_not_found', 'This product no longer exists.');
  }

  const patch: Record<string, unknown> = { ...input };
  delete patch['id'];
  // Currency is server-owned: always PHP, never taken from the request.
  delete patch['currency'];

  const tiersProvided = SIZE_PRICE_FIELDS.some(
    (field) => patch[field] !== undefined
  );
  if (input.price !== undefined && !tiersProvided) {
    // A canonical price without tiers means "flat pricing": backfill the
    // tiers so size-selector clients keep working with the same amount.
    patch['smallPrice'] = input.price;
    patch['mediumPrice'] = input.price;
    patch['largePrice'] = input.price;
  }

  // Keep `price` in sync with the (possibly merged) size tiers. Existing
  // documents without a `price` are normalized the first time they are edited.
  const merged: PriceRecord = { ...snapshot.data(), ...patch };
  const derived = derivePrice(merged);
  if (derived !== null) {
    patch['price'] = derived;
  }
  patch['currency'] = CURRENCY;
  patch['updatedAt'] = FieldValue.serverTimestamp();

  await productRef.update(patch);
  return { id: productId };
}

export async function deleteProduct(productId: string): Promise<{ id: string }> {
  const { db } = requireFirebase();

  const productRef = db.doc(`products/${productId}`);
  const snapshot = await productRef.get();
  if (!snapshot.exists) {
    throw notFound('product_not_found', 'This product no longer exists.');
  }

  await productRef.delete();
  return { id: productId };
}

/** Maps a stored product document to the standardized API payload. */
export function serializeProduct(
  productId: string,
  data: PriceRecord
): ProductResponse {
  return {
    id: productId,
    name: typeof data['name'] === 'string' ? data['name'] : '',
    category: typeof data['category'] === 'string' ? data['category'] : '',
    description:
      typeof data['description'] === 'string' ? data['description'] : '',
    imageUrl: typeof data['imageUrl'] === 'string' ? data['imageUrl'] : '',
    price:
      resolvePrice([
        data['price'],
        data['mediumPrice'],
        data['smallPrice'],
        data['largePrice'],
      ]) ?? 0,
    currency: CURRENCY,
    available: data['available'] !== false,
    createdAt: toIso(data['createdAt']),
    updatedAt: toIso(data['updatedAt']),
    smallPrice: sizePrice(data['smallPrice']),
    mediumPrice: sizePrice(data['mediumPrice']),
    largePrice: sizePrice(data['largePrice']),
    sugarOptions: Array.isArray(data['sugarOptions'])
      ? data['sugarOptions'].filter(
          (entry): entry is string => typeof entry === 'string'
        )
      : [],
    cloudinaryPublicId:
      typeof data['cloudinaryPublicId'] === 'string'
        ? data['cloudinaryPublicId']
        : '',
  };
}

/**
 * Lists the public catalog, newest first (matches the Firestore
 * `orderBy('createdAt', 'desc')` convention used by both frontends).
 * Public read: no authentication required.
 */
export async function listProducts(): Promise<ProductResponse[]> {
  const { db } = requireFirebase();
  const snapshot = await db.collection('products').get();

  const rows = snapshot.docs.map((doc) => ({
    id: doc.id,
    data: (doc.data() ?? {}) as PriceRecord,
  }));

  rows.sort(
    (a, b) =>
      (timestampMs(b.data['createdAt']) ?? Number.NEGATIVE_INFINITY) -
      (timestampMs(a.data['createdAt']) ?? Number.NEGATIVE_INFINITY)
  );

  return rows.map((row) => serializeProduct(row.id, row.data));
}

/** Reads one product for the public catalog. Public read: no auth required. */
export async function getProduct(productId: string): Promise<ProductResponse> {
  const { db } = requireFirebase();
  const snapshot = await db.doc(`products/${productId}`).get();
  if (!snapshot.exists) {
    throw notFound('product_not_found', 'This product no longer exists.');
  }
  return serializeProduct(productId, (snapshot.data() ?? {}) as PriceRecord);
}
