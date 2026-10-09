import { FieldValue } from 'firebase-admin/firestore';
import { config } from '../config';
import { ApiError, notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { CURRENCY, resolvePrice, roundMoney } from '../lib/money';
import { toIso } from '../lib/serialize';
import {
  CreateOrderRequest,
  CreateOrderItemInput,
  MAX_QUANTITY,
  ProductSize,
} from '../lib/validation';

export interface OrderSummary {
  id: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: string;
  orderStatus: string;
  paymentStatus: string;
}

interface StoredProduct {
  name?: unknown;
  imageUrl?: unknown;
  available?: unknown;
  sugarOptions?: unknown;
  price?: unknown;
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
    currency: CURRENCY,
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
    currency: CURRENCY,
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
  currency: string;
} {
  if (!product) {
    throw notFound(
      'product_not_found',
      `A product in your cart no longer exists (${item.productId}).`
    );
  }

  // Backstop for callers that bypassed request validation.
  if (
    !Number.isInteger(item.quantity) ||
    item.quantity < 1 ||
    item.quantity > MAX_QUANTITY
  ) {
    throw new ApiError(
      400,
      'invalid_quantity',
      `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`
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

  // Trusted server-side price: the size tier first (existing products), then
  // the standardized canonical `price` (single-price documents).
  const priceField = PRICE_FIELDS[item.size];
  const unitPrice = resolvePrice([product[priceField], product['price']]);
  if (unitPrice === null) {
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
    currency: CURRENCY,
  };
}

/** Full order document as returned by GET /api/orders/:id. */
export interface OrderResponse {
  id: string;
  customerId: string;
  customerSnapshot: unknown;
  addressSnapshot: unknown;
  items: unknown;
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: string;
  customerComment: string;
  paymentMethod: string;
  paymentStatus: string;
  orderStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Maps a stored order document to its API payload. */
export function serializeOrder(
  orderId: string,
  data: Record<string, unknown>
): OrderResponse {
  return {
    id: orderId,
    customerId:
      typeof data['customerId'] === 'string' ? data['customerId'] : '',
    customerSnapshot: data['customerSnapshot'] ?? null,
    addressSnapshot: data['addressSnapshot'] ?? null,
    items: Array.isArray(data['items']) ? data['items'] : [],
    subtotal: typeof data['subtotal'] === 'number' ? data['subtotal'] : 0,
    deliveryFee:
      typeof data['deliveryFee'] === 'number' ? data['deliveryFee'] : 0,
    total: typeof data['total'] === 'number' ? data['total'] : 0,
    // Historic orders predate the currency field; their amounts are PHP too.
    currency:
      typeof data['currency'] === 'string' ? data['currency'] : CURRENCY,
    customerComment:
      typeof data['customerComment'] === 'string'
        ? data['customerComment']
        : '',
    paymentMethod:
      typeof data['paymentMethod'] === 'string' ? data['paymentMethod'] : '',
    paymentStatus:
      typeof data['paymentStatus'] === 'string'
        ? data['paymentStatus']
        : 'PENDING',
    orderStatus:
      typeof data['orderStatus'] === 'string'
        ? data['orderStatus']
        : 'PENDING',
    createdAt: toIso(data['createdAt']),
    updatedAt: toIso(data['updatedAt']),
  };
}

/**
 * Reads a single order with ownership enforcement.
 *
 * The owner (customerId == uid) and administrators may read the order.
 * Anyone else receives the same 404 as a missing order so that order ids
 * cannot be probed. Historical order documents are returned as stored —
 * prices are never recomputed or rewritten on read.
 */
export async function getOrder(
  user: { uid: string },
  orderId: string,
  options: { isAdmin: boolean }
): Promise<OrderResponse> {
  const { db } = requireFirebase();

  const snapshot = await db.doc(`orders/${orderId}`).get();
  if (!snapshot.exists) {
    throw notFound('order_not_found', 'This order no longer exists.');
  }

  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (!options.isAdmin && data['customerId'] !== user.uid) {
    throw notFound('order_not_found', 'This order no longer exists.');
  }

  return serializeOrder(orderId, data);
}
