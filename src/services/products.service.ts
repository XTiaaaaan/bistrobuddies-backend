import { FieldValue } from 'firebase-admin/firestore';
import { notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { ValidatedProductInput } from '../lib/validation';

/**
 * Server-side product writes. Every caller must already have passed
 * requireAuth + requireAdmin; these functions do not re-check roles.
 * The written document shape matches the existing Firestore `products`
 * schema used by both frontends.
 */
export async function createProduct(
  input: ValidatedProductInput
): Promise<{ id: string }> {
  const { db } = requireFirebase();

  const productRef = db.collection('products').doc();
  const payload = {
    id: productRef.id,
    name: input.name ?? '',
    description: input.description ?? '',
    category: input.category ?? '',
    imageUrl: input.imageUrl ?? '',
    // Legacy field kept for schema compatibility with existing documents.
    cloudinaryPublicId: input.cloudinaryPublicId ?? '',
    smallPrice: input.smallPrice ?? 0,
    mediumPrice: input.mediumPrice ?? 0,
    largePrice: input.largePrice ?? 0,
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
