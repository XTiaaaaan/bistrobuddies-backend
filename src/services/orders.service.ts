import { FieldValue } from 'firebase-admin/firestore';
import { config } from '../config';
import { ApiError, notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import {
  CreateOrderRequest,
  CreateOrderItemInput,
  ProductSize,
} from '../lib/validation';

export interface OrderSummary {
  id: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  orderStatus: string;
  paymentStatus: string;
}

interface StoredProduct {
  name?: unknown;
  imageUrl?: unknown;
  available?: unknown;
  sugarOptions?: unknown;
  smallPrice?: unknown;
  mediumPrice?: unknown;
  largePrice?: unknown;
}

const PRICE_FIELDS: Record<ProductSize, 'smallPrice' | 'mediumPrice' | 'largePrice'> = {
  small: 'smallPrice',
  medium: 'mediumPrice',
  large: 'largePrice',
};

/**
 * Creates an order using server-side pricing.
 *
 * - The customer identity comes from the verified auth token (uid/email).
 * - Product names, images, availability and prices are read from Firestore
 *   authoritative product documents — client-supplied prices are ignored.
 * - Purchase-time snapshots (customer, address, items) are stored on the order.
 * - New orders always start as orderStatus=PENDING / paymentStatus=PENDING.
 */
export async function createOrder(
  user: { uid: string; email: string | null },
  request: CreateOrderRequest
): Promise<OrderSummary> {
  const { db } = requireFirebase();

  const productIds = [...new Set(request.items.map((item) => item.productId))];
  const products = new Map<string, StoredProduct | null>();
  await Promise.all(
    productIds.map(async (productId) => {
      const snapshot = await db.doc(`products/${productId}`).get();
      products.set(
        productId,
        snapshot.exists
          ? (snapshot.data() as StoredProduct)
          : null
      );
    })
  );

  const items = request.items.map((item) =>
    buildOrderItem(item, products.get(item.productId) ?? null)
  );

  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.subtotal, 0));
  const deliveryFee = config.deliveryFee;
  const total = roundMoney(subtotal + deliveryFee);

  const orderRef = db.collection('orders').doc();
  const order = {
    id: orderRef.id,
    customerId: user.uid,
    customerSnapshot: {
      uid: user.uid,
      name: request.customer.name,
      email: user.email ?? '',
      phone: request.customer.phone,
    },
    addressSnapshot: { ...request.address },
    items,
    subtotal,
    deliveryFee,
    total,
    customerComment: request.customerComment,
    paymentMethod: request.paymentMethod,
    paymentStatus: 'PENDING',
    orderStatus: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await orderRef.set(order);

  return {
    id: orderRef.id,
    subtotal,
    deliveryFee,
    total,
    orderStatus: 'PENDING',
    paymentStatus: 'PENDING',
  };
}

function buildOrderItem(
  item: CreateOrderItemInput,
  product: StoredProduct | null
): {
  productId: string;
  productName: string;
  imageUrl: string;
  size: ProductSize;
  sugar: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
} {
  if (!product) {
    throw notFound(
      'product_not_found',
      `A product in your cart no longer exists (${item.productId}).`
    );
  }

  const productName = typeof product.name === 'string' ? product.name : '';

  if (product.available === false) {
    throw new ApiError(
      409,
      'product_unavailable',
      `"${productName || item.productId}" is currently unavailable.`
    );
  }

  const sugarOptions = Array.isArray(product.sugarOptions)
    ? product.sugarOptions
    : [];
  if (!sugarOptions.includes(item.sugar)) {
    throw new ApiError(
      422,
      'invalid_sugar_option',
      `Sugar option "${item.sugar}" is not available for "${productName || item.productId}".`
    );
  }

  const priceField = PRICE_FIELDS[item.size];
  const unitPrice = product[priceField];
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw new ApiError(
      422,
      'invalid_product_price',
      `"${productName || item.productId}" has no valid ${item.size} price.`
    );
  }

  return {
    productId: item.productId,
    productName,
    imageUrl: typeof product.imageUrl === 'string' ? product.imageUrl : '',
    size: item.size,
    sugar: item.sugar,
    quantity: item.quantity,
    unitPrice,
    subtotal: roundMoney(unitPrice * item.quantity),
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
