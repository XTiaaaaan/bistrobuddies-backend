import { randomInt } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { config } from '../config';
import { ApiError, badRequest, notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { deleteFromCloudinary } from '../lib/cloudinary';
import { saveUploadedImage } from '../lib/image-upload';
import { CURRENCY, resolvePrice, roundMoney } from '../lib/money';
import { toIso } from '../lib/serialize';
import { logger } from '../logger';
import {
  notifyAdminsNewOrder,
  notifyAdminsPaymentProofSubmitted,
  notifyPaymentDecision,
} from './notifications.service';
import {
  CreateOrderRequest,
  CreateOrderItemInput,
  GcashDetailsInput,
  MAX_QUANTITY,
  orderStatusLabel,
  PaymentDecision,
  PaymentStatus,
  ProductSize,
  RefundAction,
  RefundStatus,
} from '../lib/validation';

export interface OrderSummary {
  id: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  currency: string;
  orderStatus: string;
  /** User-facing label (e.g. `OUT_FOR_DELIVERY` -> "On the Way"). */
  orderStatusLabel: string;
  paymentStatus: string;
}

const ORDER_ID_PREFIX = 'bistro';
const ORDER_ID_DIGITS = 10;

/**
 * Human readable order id in the form `bistro` + 10 digits
 * (e.g. `bistro4839201756`). Retries on the unlikely collision.
 */
async function nextOrderId(db: Firestore): Promise<string> {
  for (;;) {
    const candidate = `${ORDER_ID_PREFIX}${randomInt(
      0,
      10 ** ORDER_ID_DIGITS
    )
      .toString()
      .padStart(ORDER_ID_DIGITS, '0')}`;
    if (!(await db.collection('orders').doc(candidate).get()).exists) {
      return candidate;
    }
  }
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

  const orderRef = db.collection('orders').doc(await nextOrderId(db));
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

  // Best-effort admin push; notification failures never fail order creation.
  await notifyAdminsNewOrder(orderRef.id);

  return {
    id: orderRef.id,
    subtotal,
    deliveryFee,
    total,
    currency: CURRENCY,
    orderStatus: 'PENDING',
    orderStatusLabel: orderStatusLabel('PENDING'),
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

/** Customer-visible GCash details stored on a GCash order. */
export interface GcashDetailsResponse {
  accountName: string;
  accountNumber: string;
  submittedAt: string | null;
}

/** Admin-only record of the latest payment decision on an order. */
export interface PaymentDecisionResponse {
  decision: PaymentDecision;
  decidedBy: string;
  decidedAt: string | null;
}

/** Admin-only append-only audit trail of payment status changes. */
export interface PaymentAuditEntry {
  from: PaymentStatus;
  to: PaymentStatus;
  actorUid: string;
  actorRole: 'customer' | 'admin';
}

/** Customer-submitted GCash payment proof stored on the order. */
export interface PaymentProofResponse {
  /** HTTPS Cloudinary URL of the uploaded proof image. */
  url: string;
  /** Cloudinary public id (used for best-effort cleanup). */
  publicId: string;
  /** Detected image MIME type (JPEG/PNG/WebP). */
  mimeType: string;
  /** Uploaded file size in bytes. */
  size: number;
  /** UID of the customer who uploaded the proof (from the verified token). */
  submittedBy: string;
  /** When the proof was submitted (ISO-8601), or null for legacy data. */
  submittedAt: string | null;
}

/**
 * Customer- and admin-visible refund facts on an order. Admin-only notes or
 * audit detail are deliberately excluded — this shape is safe for both.
 */
export interface RefundInfoResponse {
  status: RefundStatus;
  /** PHP amount recorded for the refund; null until one was recorded. */
  amount: number | null;
  requestedAt: string | null;
  completedAt: string | null;
}

/** Admin-only append-only audit trail of refund status changes. */
export interface RefundAuditEntry {
  from: RefundStatus;
  to: RefundStatus;
  actorUid: string;
  actorRole: 'admin';
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
  /** Submitted GCash details, or null when none were submitted yet. */
  gcashDetails: GcashDetailsResponse | null;
  /** Latest submitted GCash payment proof, or null when none exists. */
  paymentProof: PaymentProofResponse | null;
  /** Alias of `paymentProof` using the GCash-specific field name. */
  gcashProof: PaymentProofResponse | null;
  /** Convenience copy of the proof URL (`paymentProof.url`), or null. */
  paymentProofUrl: string | null;
  /** Alias of `paymentProofUrl` for clients using the shorter name. */
  proofUrl: string | null;
  /** Alias of `paymentProofUrl` using the GCash-specific field name. */
  gcashProofUrl: string | null;
  /** Refund facts (status/amount/timestamps) — safe for customers and admins. */
  refund: RefundInfoResponse;
  /**
   * Latest admin payment decision. Present for administrators only — it is
   * omitted from customer responses so verification metadata stays private.
   */
  paymentDecision?: PaymentDecisionResponse | null;
  /** Payment audit trail. Present for administrators only. */
  paymentAudit?: PaymentAuditEntry[];
  /** Refund audit trail. Present for administrators only. */
  refundAudit?: RefundAuditEntry[];
  orderStatus: string;
  /** User-facing label (e.g. `OUT_FOR_DELIVERY` -> "On the Way"). */
  orderStatusLabel: string;
  createdAt: string | null;
  updatedAt: string | null;
}

function readGcashDetails(data: Record<string, unknown>): GcashDetailsResponse | null {
  const raw = data['gcashDetails'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record['accountName'] !== 'string' ||
    typeof record['accountNumber'] !== 'string'
  ) {
    return null;
  }
  return {
    accountName: record['accountName'],
    accountNumber: record['accountNumber'],
    submittedAt: toIso(record['submittedAt']),
  };
}

/**
 * Reads the stored GCash payment proof. Supports the canonical nested
 * `paymentProof` object, the `gcashProof` alias, and the flat
 * `paymentProofUrl` fields so data written by any version of the API remains
 * readable. Image bytes/base64 are never stored or returned.
 */
function readPaymentProof(
  data: Record<string, unknown>
): PaymentProofResponse | null {
  const nested = data['paymentProof'] ?? data['gcashProof'];
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    const url =
      typeof record['url'] === 'string'
        ? record['url']
        : typeof record['imageUrl'] === 'string'
          ? record['imageUrl']
          : '';
    if (url !== '') {
      return {
        url,
        publicId:
          typeof record['publicId'] === 'string' ? record['publicId'] : '',
        mimeType:
          typeof record['mimeType'] === 'string' ? record['mimeType'] : '',
        size:
          typeof record['size'] === 'number' && Number.isFinite(record['size'])
            ? record['size']
            : 0,
        submittedBy:
          typeof record['submittedBy'] === 'string'
            ? record['submittedBy']
            : '',
        submittedAt: toIso(record['submittedAt']),
      };
    }
  }

  const flatUrl =
    typeof data['paymentProofUrl'] === 'string'
      ? data['paymentProofUrl']
      : typeof data['gcashProofUrl'] === 'string'
        ? data['gcashProofUrl']
        : data['proofUrl'];
  if (typeof flatUrl === 'string' && flatUrl !== '') {
    return {
      url: flatUrl,
      publicId:
        typeof data['paymentProofPublicId'] === 'string'
          ? data['paymentProofPublicId']
          : '',
      mimeType: '',
      size: 0,
      submittedBy:
        typeof data['paymentProofSubmittedBy'] === 'string'
          ? data['paymentProofSubmittedBy']
          : '',
      submittedAt: toIso(data['paymentProofSubmittedAt']),
    };
  }

  return null;
}

function readPaymentDecision(
  data: Record<string, unknown>
): PaymentDecisionResponse | null {
  const raw = data['paymentDecision'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const decision = record['decision'];
  if (decision !== 'PAID' && decision !== 'REJECTED') {
    return null;
  }
  return {
    decision,
    decidedBy: typeof record['decidedBy'] === 'string' ? record['decidedBy'] : '',
    decidedAt: toIso(record['decidedAt']),
  };
}

function readPaymentAudit(data: Record<string, unknown>): PaymentAuditEntry[] {
  const raw = data['paymentAudit'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: PaymentAuditEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const from = record['from'];
    const to = record['to'];
    if (
      (from === 'PENDING' || from === 'VERIFYING' || from === 'PAID' || from === 'REJECTED') &&
      (to === 'PENDING' || to === 'VERIFYING' || to === 'PAID' || to === 'REJECTED') &&
      typeof record['actorUid'] === 'string' &&
      (record['actorRole'] === 'customer' || record['actorRole'] === 'admin')
    ) {
      entries.push({
        from,
        to,
        actorUid: record['actorUid'],
        actorRole: record['actorRole'],
      });
    }
  }
  return entries;
}

/**
 * Parses the stored `refund` object into the safe, shared response shape.
 * Historical orders without refund fields come back `NOT_REFUNDED` with
 * `amount: null` — nothing is rewritten on read.
 */
function readRefund(data: Record<string, unknown>): RefundInfoResponse {
  const raw = data['refund'];
  let record: Record<string, unknown> = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    record = raw as Record<string, unknown>;
  }
  const status: RefundStatus =
    record['status'] === 'REFUND_PENDING' || record['status'] === 'REFUNDED'
      ? record['status']
      : 'NOT_REFUNDED';
  const amount =
    typeof record['amount'] === 'number' && Number.isFinite(record['amount'])
      ? roundMoney(record['amount'])
      : null;
  return {
    status,
    amount,
    requestedAt: toIso(record['requestedAt']),
    completedAt: toIso(record['completedAt']),
  };
}

function readStoredRefund(
  data: Record<string, unknown>
): { raw: Record<string, unknown>; status: RefundStatus } {
  const raw = data['refund'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { raw: {}, status: 'NOT_REFUNDED' };
  }
  const record = raw as Record<string, unknown>;
  const status: RefundStatus =
    record['status'] === 'REFUND_PENDING' || record['status'] === 'REFUNDED'
      ? record['status']
      : 'NOT_REFUNDED';
  return { raw: record, status };
}

function readRefundAudit(data: Record<string, unknown>): RefundAuditEntry[] {
  const raw = data['refundAudit'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: RefundAuditEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const from = record['from'];
    const to = record['to'];
    if (
      (from === 'NOT_REFUNDED' || from === 'REFUND_PENDING' || from === 'REFUNDED') &&
      (to === 'NOT_REFUNDED' || to === 'REFUND_PENDING' || to === 'REFUNDED') &&
      typeof record['actorUid'] === 'string' &&
      record['actorRole'] === 'admin'
    ) {
      entries.push({
        from,
        to,
        actorUid: record['actorUid'],
        actorRole: 'admin',
      });
    }
  }
  return entries;
}

/**
 * The paid amount eligible for refund, read from the stored order snapshot.
 * Client-supplied amounts are never trusted — the recorded refund equals what
 * the order snapshot says was actually paid.
 */
function readRefundableAmount(data: Record<string, unknown>): number | null {
  const total = data['total'];
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return roundMoney(total);
  }
  return null;
}

/**
 * Maps a stored order document to its API payload.
 *
 * Historical orders without the newer GCash fields are returned with
 * `gcashDetails: null` (and `refund: NOT_REFUNDED`) and their stored
 * `paymentStatus` untouched — prices and totals are never recomputed or
 * rewritten on read. Admin-only verification metadata (`paymentDecision`,
 * `paymentAudit`, `refundAudit`) is included only when `options.isAdmin`
 * is true. `refund` itself (status/amount/timestamps) is safe and included
 * for both roles.
 */
export function serializeOrder(
  orderId: string,
  data: Record<string, unknown>,
  options?: { isAdmin?: boolean }
): OrderResponse {
  const paymentProof = readPaymentProof(data);
  const storedOrderStatus =
    typeof data['orderStatus'] === 'string'
      ? data['orderStatus']
      : 'PENDING';
  const response: OrderResponse = {
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
    gcashDetails: readGcashDetails(data),
    paymentProof,
    gcashProof: paymentProof,
    paymentProofUrl: paymentProof?.url ?? null,
    proofUrl: paymentProof?.url ?? null,
    gcashProofUrl: paymentProof?.url ?? null,
    refund: readRefund(data),
    orderStatus: storedOrderStatus,
    orderStatusLabel: orderStatusLabel(storedOrderStatus),
    createdAt: toIso(data['createdAt']),
    updatedAt: toIso(data['updatedAt']),
  };
  if (options?.isAdmin) {
    response.paymentDecision = readPaymentDecision(data);
    response.paymentAudit = readPaymentAudit(data);
    response.refundAudit = readRefundAudit(data);
  }
  return response;
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

  return serializeOrder(orderId, data, { isAdmin: options.isAdmin });
}

function readStoredOrderStatus(data: Record<string, unknown>): string {
  return typeof data['orderStatus'] === 'string' && data['orderStatus']
    ? data['orderStatus']
    : 'PENDING';
}

/**
 * Cancels an order on behalf of its owner.
 *
 * Ownership is enforced from the verified token (customerId == uid); anyone
 * else — including administrators, who cancel through the admin status
 * endpoint instead — receives the same 404 as a missing order so order ids
 * cannot be probed. A customer may cancel only while the order is still
 * awaiting confirmation (`PENDING`); once it has been confirmed or is further
 * along the fulfilment flow it can no longer be cancelled. Cancelling an
 * already-cancelled order is an idempotent no-op that returns the order.
 *
 * The document is never deleted: `orderStatus` is set to `CANCELLED` and the
 * independent `paymentStatus` (including any submitted GCash details) is left
 * untouched. Runs in a Firestore transaction so a concurrent admin
 * confirmation cannot be overwritten by a cancellation.
 *
 * Rejected with 404 when the order is missing or owned by someone else, and
 * 409 when the order is no longer cancellable.
 */
export async function cancelOrder(
  user: { uid: string },
  orderId: string
): Promise<OrderResponse> {
  const { db } = requireFirebase();
  const orderRef = db.doc(`orders/${orderId}`);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(orderRef);
    if (!snapshot.exists) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const data = (snapshot.data() ?? {}) as Record<string, unknown>;
    if (data['customerId'] !== user.uid) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }

    const current = readStoredOrderStatus(data);
    if (current === 'CANCELLED') {
      // Idempotent: the order is already in the requested state.
      return serializeOrder(orderId, data);
    }
    if (current !== 'PENDING') {
      throw new ApiError(
        409,
        'order_not_cancellable',
        'This order has already been confirmed and can no longer be cancelled.'
      );
    }

    tx.update(orderRef, {
      orderStatus: 'CANCELLED',
      updatedAt: FieldValue.serverTimestamp(),
    });

    return serializeOrder(orderId, {
      ...data,
      orderStatus: 'CANCELLED',
      updatedAt: new Date(),
    });
  });
}

export interface GcashSubmissionResult {
  id: string;
  paymentStatus: PaymentStatus;
  gcashDetails: { accountName: string; accountNumber: string };
}

function readStoredPaymentStatus(data: Record<string, unknown>): PaymentStatus {
  const raw = data['paymentStatus'];
  if (
    raw === 'PENDING' ||
    raw === 'VERIFYING' ||
    raw === 'PAID' ||
    raw === 'REJECTED'
  ) {
    return raw;
  }
  // Historical orders predate explicit payment statuses; treat them as pending.
  return 'PENDING';
}

/**
 * Submits GCash payment details for an order (customer, owner only).
 *
 * Allowed from `PENDING` (first submission), `VERIFYING` (update while awaiting
 * review) and `REJECTED` (resubmission after an admin rejection — the order
 * returns to `VERIFYING`). Repeating a submission is safe: details are replaced
 * and the status stays (or returns to) `VERIFYING`.
 *
 * Rejected with 404 when the order is missing or owned by someone else, 409
 * when the order does not use GCash or its payment was already confirmed.
 * Runs in a Firestore transaction so concurrent submissions stay consistent.
 * Only the validated account name/number are stored — no client-supplied
 * totals, statuses or credentials are accepted.
 */
export async function submitGcashDetails(
  user: { uid: string },
  orderId: string,
  input: GcashDetailsInput
): Promise<GcashSubmissionResult> {
  const { db } = requireFirebase();
  const orderRef = db.doc(`orders/${orderId}`);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(orderRef);
    if (!snapshot.exists) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const data = (snapshot.data() ?? {}) as Record<string, unknown>;
    if (data['customerId'] !== user.uid) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    if (data['paymentMethod'] !== 'GCASH') {
      throw new ApiError(
        409,
        'invalid_payment_method',
        'Only GCash orders can submit GCash payment details.'
      );
    }
    const current = readStoredPaymentStatus(data);
    if (current === 'PAID') {
      throw new ApiError(
        409,
        'payment_already_confirmed',
        'This payment has already been confirmed and cannot be changed.'
      );
    }

    const audit = readPaymentAudit(data);
    audit.push({
      from: current,
      to: 'VERIFYING',
      actorUid: user.uid,
      actorRole: 'customer',
    });

    tx.update(orderRef, {
      gcashDetails: {
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        submittedBy: user.uid,
        submittedAt: FieldValue.serverTimestamp(),
      },
      paymentStatus: 'VERIFYING',
      paymentAudit: audit,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      id: orderId,
      paymentStatus: 'VERIFYING' as PaymentStatus,
      gcashDetails: {
        accountName: input.accountName,
        accountNumber: input.accountNumber,
      },
    };
  });
}

export interface PaymentProofSubmissionResult {
  id: string;
  paymentStatus: PaymentStatus;
  paymentProof: {
    url: string;
    publicId: string;
    mimeType: string;
    size: number;
    submittedBy: string;
    submittedAt: string;
  };
}

function assertProofUploadAllowed(
  data: Record<string, unknown>,
  customerId: string
): void {
  if (data['customerId'] !== customerId) {
    throw notFound('order_not_found', 'This order no longer exists.');
  }
  if (data['paymentMethod'] !== 'GCASH') {
    throw new ApiError(
      409,
      'invalid_payment_method',
      'Only GCash orders can upload payment proof.'
    );
  }
  if (readStoredPaymentStatus(data) === 'PAID') {
    throw new ApiError(
      409,
      'payment_already_confirmed',
      'This payment has already been confirmed and its proof cannot be changed.'
    );
  }
}

/**
 * Stores a customer-submitted GCash payment proof image on an order.
 *
 * The caller must own the order (verified token uid), the order must use
 * GCASH, and the payment must not already be PAID. Proof may be submitted
 * from `PENDING`, replaced while `VERIFYING`, or replaced after a `REJECTED`
 * decision; a successful upload moves the independent `paymentStatus` to
 * `VERIFYING` so an administrator can review it. It never marks the payment
 * PAID — only the admin decision endpoint may do that.
 *
 * The image is validated by `saveUploadedImage` (magic bytes, JPEG/PNG/WebP,
 * configured size cap) and stored in Cloudinary; only its HTTPS URL and
 * metadata are written to Firestore. If the upload succeeds but the order
 * write fails, the newly uploaded Cloudinary asset is deleted on a
 * best-effort basis.
 */
export async function submitGcashProof(
  user: { uid: string },
  orderId: string,
  file: Express.Multer.File | undefined
): Promise<PaymentProofSubmissionResult> {
  const { db } = requireFirebase();
  const orderRef = db.doc(`orders/${orderId}`);

  // Reject missing/foreign/COD/PAID orders before uploading anything.
  const preflight = await orderRef.get();
  if (!preflight.exists) {
    throw notFound('order_not_found', 'This order no longer exists.');
  }
  assertProofUploadAllowed(
    (preflight.data() ?? {}) as Record<string, unknown>,
    user.uid
  );

  const saved = await saveUploadedImage(file);
  const now = new Date();

  try {
    const result = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(orderRef);
      if (!snapshot.exists) {
        throw notFound('order_not_found', 'This order no longer exists.');
      }
      const data = (snapshot.data() ?? {}) as Record<string, unknown>;
      // Re-check inside the transaction in case the order changed while the
      // image was uploading (e.g. an admin confirmed it or it was cancelled).
      assertProofUploadAllowed(data, user.uid);

      const current = readStoredPaymentStatus(data);
      const audit = readPaymentAudit(data);
      if (current !== 'VERIFYING') {
        audit.push({
          from: current,
          to: 'VERIFYING',
          actorUid: user.uid,
          actorRole: 'customer',
        });
      }

      const storedProof = {
        url: saved.publicUrl,
        publicId: saved.publicId,
        mimeType: saved.mimeType,
        size: saved.size,
        submittedBy: user.uid,
        submittedAt: FieldValue.serverTimestamp(),
      };

      tx.update(orderRef, {
        // Canonical nested record plus aliases read by older/newer clients.
        paymentProof: storedProof,
        gcashProof: storedProof,
        paymentProofUrl: saved.publicUrl,
        proofUrl: saved.publicUrl,
        gcashProofUrl: saved.publicUrl,
        paymentProofPublicId: saved.publicId,
        paymentProofSubmittedBy: user.uid,
        paymentProofSubmittedAt: FieldValue.serverTimestamp(),
        paymentStatus: 'VERIFYING',
        paymentAudit: audit,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        id: orderId,
        paymentStatus: 'VERIFYING' as PaymentStatus,
        paymentProof: {
          url: saved.publicUrl,
          publicId: saved.publicId,
          mimeType: saved.mimeType,
          size: saved.size,
          submittedBy: user.uid,
          submittedAt: now.toISOString(),
        },
      };
    });

    await notifyAdminsPaymentProofSubmitted(orderId, saved.publicId);
    return result;
  } catch (error) {
    const cleaned = await deleteFromCloudinary(saved.publicId);
    logger.warn('Orphaned GCash payment proof upload cleanup attempted.', {
      orderId,
      publicId: saved.publicId,
      cleaned,
    });
    throw error;
  }
}

export interface PaymentDecisionResult {
  id: string;
  paymentStatus: PaymentStatus;
}

type PaymentDecisionScope = 'GCASH' | 'COD' | 'ANY';

/**
 * Shared admin payment-decision transaction.
 *
 * `scope` restricts which payment method the caller is allowed to act on:
 * the GCash endpoint cannot touch COD orders, the COD collection endpoint
 * cannot touch GCash orders, and the general admin payment endpoint accepts
 * either (but applies the correct rules for each).
 *
 * GCash rules: the order must be `VERIFYING` with submitted details AND
 * submitted proof before it can become `PAID`. Repeating the current decision
 * is an idempotent no-op. `PAID` can never be overwritten and `REJECTED` can
 * only become `PAID` after the customer resubmits.
 *
 * COD rules: only a `PAID` decision (cash actually collected) is accepted,
 * and only once the order is `COMPLETED` (cash is collected on delivery).
 * The admin status endpoint settles COD automatically on delivery; this path
 * stays as the idempotent explicit confirmation for completed COD orders.
 * The fulfilment field `orderStatus` is never touched here.
 */
async function decidePayment(
  admin: { uid: string },
  orderId: string,
  decision: PaymentDecision,
  scope: PaymentDecisionScope
): Promise<PaymentDecisionResult> {
  const { db } = requireFirebase();
  const orderRef = db.doc(`orders/${orderId}`);
  const paymentNotification: {
    value: {
      customerId: string;
      decision: PaymentDecision;
      revision: number;
    } | null;
  } = { value: null };

  const result = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(orderRef);
    if (!snapshot.exists) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const data = (snapshot.data() ?? {}) as Record<string, unknown>;
    const method = data['paymentMethod'];

    if (scope !== 'ANY' && method !== scope) {
      throw new ApiError(
        409,
        'invalid_payment_method',
        scope === 'COD'
          ? 'Only cash-on-delivery orders can be marked as collected.'
          : 'Only GCash orders can receive a GCash payment decision.'
      );
    }
    if (method === 'COD') {
      if (decision !== 'PAID') {
        throw new ApiError(
          409,
          'invalid_payment_method',
          'Cash-on-delivery payments can only be marked as collected (PAID).'
        );
      }
      const current = readStoredPaymentStatus(data);
      if (current === 'PAID') {
        return { id: orderId, paymentStatus: current };
      }
      if (data['orderStatus'] !== 'COMPLETED') {
        throw new ApiError(
          409,
          'invalid_payment_transition',
          'Cash-on-delivery payment can only be collected after the order is completed.'
        );
      }
      if (current !== 'PENDING') {
        throw new ApiError(
          409,
          'invalid_payment_transition',
          'This cash-on-delivery payment cannot be marked as collected from its current state.'
        );
      }

      const audit = readPaymentAudit(data);
      audit.push({
        from: current,
        to: 'PAID',
        actorUid: admin.uid,
        actorRole: 'admin',
      });

      tx.update(orderRef, {
        paymentStatus: 'PAID',
        paymentDecision: {
          decision: 'PAID',
          decidedBy: admin.uid,
          decidedAt: FieldValue.serverTimestamp(),
        },
        paymentAudit: audit,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { id: orderId, paymentStatus: 'PAID' as PaymentStatus };
    }

    if (method !== 'GCASH') {
      throw new ApiError(
        409,
        'invalid_payment_method',
        'Only GCash or COD orders can receive a payment decision.'
      );
    }

    const current = readStoredPaymentStatus(data);

    if (current === decision) {
      // Idempotent: repeating a recorded decision is a successful no-op.
      return { id: orderId, paymentStatus: current };
    }
    if (current === 'PAID') {
      throw new ApiError(
        409,
        'invalid_payment_transition',
        'This payment has already been confirmed and cannot be changed.'
      );
    }
    if (current === 'REJECTED' && decision === 'PAID') {
      throw new ApiError(
        409,
        'invalid_payment_transition',
        'A rejected payment cannot become paid without new customer details. Ask the customer to resubmit, then decide again.'
      );
    }
    if (current !== 'VERIFYING' || readGcashDetails(data) === null) {
      throw new ApiError(
        409,
        'payment_details_required',
        'The customer must submit GCash payment details before an admin can decide.'
      );
    }
    if (decision === 'PAID' && readPaymentProof(data) === null) {
      throw new ApiError(
        409,
        'payment_proof_required',
        'The customer must upload GCash payment proof before the payment can be confirmed.'
      );
    }

    const audit = readPaymentAudit(data);
    audit.push({
      from: current,
      to: decision,
      actorUid: admin.uid,
      actorRole: 'admin',
    });

    tx.update(orderRef, {
      paymentStatus: decision,
      paymentDecision: {
        decision,
        decidedBy: admin.uid,
        decidedAt: FieldValue.serverTimestamp(),
      },
      paymentAudit: audit,
      updatedAt: FieldValue.serverTimestamp(),
    });

    paymentNotification.value = {
      customerId:
        typeof data['customerId'] === 'string' ? data['customerId'] : '',
      decision,
      revision: audit.length,
    };

    return { id: orderId, paymentStatus: decision };
  });

  const pendingNotification = paymentNotification.value;
  if (pendingNotification) {
    await notifyPaymentDecision(
      orderId,
      pendingNotification.customerId,
      pendingNotification.decision,
      pendingNotification.revision
    );
  }

  return result;
}

/** Records an admin PAID/REJECTED decision on a GCash payment (GCash only). */
export function decideGcashPayment(
  admin: { uid: string },
  orderId: string,
  decision: PaymentDecision
): Promise<PaymentDecisionResult> {
  return decidePayment(admin, orderId, decision, 'GCASH');
}

/**
 * Records an admin payment decision without pre-selecting the method: GCash
 * orders follow the verification workflow, COD orders may only be marked as
 * collected (`PAID`).
 */
export function decideOrderPayment(
  admin: { uid: string },
  orderId: string,
  decision: PaymentDecision
): Promise<PaymentDecisionResult> {
  return decidePayment(admin, orderId, decision, 'ANY');
}

/**
 * Explicitly confirms that cash was collected for a COD order.
 *
 * Reaching `COMPLETED` already settles COD as `PAID` automatically, so this
 * action is an idempotent confirmation for completed orders. It requires
 * `orderStatus === 'COMPLETED'`, is an idempotent no-op once paid, and a
 * confirmed payment can never be overwritten.
 */
export function confirmCodPayment(
  admin: { uid: string },
  orderId: string
): Promise<PaymentDecisionResult> {
  return decidePayment(admin, orderId, 'PAID', 'COD');
}

/**
 * Records a manual (off-platform) refund action on an order.
 *
 * Eligibility: `orderStatus === 'CANCELLED'` **and**
 * `paymentStatus === 'PAID'`. Unpaid/verifying/rejected payments and
 * non-cancelled orders are refused — a refund only makes sense after the
 * store confirmed it received (and is returning) money.
 *
 * Allowed transitions per action:
 * - `PENDING`: `NOT_REFUNDED → REFUND_PENDING` (repeating `PENDING` while
 *   `REFUND_PENDING` is an idempotent no-op). This never completes a refund.
 * - `COMPLETE`: `REFUND_PENDING → REFUNDED`, and only after the admin
 *   explicitly confirms (`confirmed: true`) that the money was actually sent.
 *   `COMPLETE` from `NOT_REFUNDED` is refused (record it as pending first).
 * - Once `REFUNDED` the order can never be refunded again.
 *
 * The refund amount is read from the stored order snapshot (`total` — what
 * the customer actually paid); client-supplied amounts are ignored. The
 * independent `paymentStatus`, GCash details, payment decision and payment
 * audit trail are never modified; refund transitions go to the separate
 * `refundAudit` trail with the acting admin's uid. Runs in a Firestore
 * transaction so concurrent duplicate refund actions cannot double-refund.
 *
 * Returns the updated order in the same (admin) shape as
 * GET /api/orders/:id.
 */
export async function recordRefundAction(
  admin: { uid: string },
  orderId: string,
  action: RefundAction,
  confirmed: boolean
): Promise<OrderResponse> {
  const { db } = requireFirebase();
  const orderRef = db.doc(`orders/${orderId}`);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(orderRef);
    if (!snapshot.exists) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const data = (snapshot.data() ?? {}) as Record<string, unknown>;
    if (
      readStoredOrderStatus(data) !== 'CANCELLED' ||
      readStoredPaymentStatus(data) !== 'PAID'
    ) {
      throw new ApiError(
        409,
        'order_not_refundable',
        'Only cancelled orders with a confirmed (PAID) payment can be refunded.'
      );
    }

    const stored = readStoredRefund(data);
    const audit = readRefundAudit(data);

    if (action === 'COMPLETE' && !confirmed) {
      // Backstop for callers that bypassed request validation: completing a
      // refund always requires the admin's explicit confirmation.
      throw badRequest(
        'Recording a completed refund requires explicit confirmation: set "confirmed" to true.'
      );
    }

    if (action === 'PENDING') {
      if (stored.status === 'REFUND_PENDING') {
        // Idempotent: the refund is already recorded as pending.
        return serializeOrder(orderId, data, { isAdmin: true });
      }
      if (stored.status === 'REFUNDED') {
        throw new ApiError(
          409,
          'refund_already_completed',
          'This order has already been refunded and cannot be refunded again.'
        );
      }

      const amount = readRefundableAmount(data);
      const now = new Date();
      tx.update(orderRef, {
        refund: {
          ...stored.raw,
          status: 'REFUND_PENDING' as RefundStatus,
          amount,
          requestedBy: admin.uid,
          requestedAt: FieldValue.serverTimestamp(),
        },
        refundAudit: [
          ...audit,
          {
            from: stored.status,
            to: 'REFUND_PENDING',
            actorUid: admin.uid,
            actorRole: 'admin',
          },
        ],
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Response mirrors the post-commit document; real timestamps are
      // written by Firestore, the response uses the current time.
      const response = serializeOrder(
        orderId,
        {
          ...data,
          refund: {
            ...stored.raw,
            status: 'REFUND_PENDING' as RefundStatus,
            amount,
            requestedAt: now,
          },
          updatedAt: now,
        },
        { isAdmin: true }
      );
      response.refundAudit = [
        ...audit,
        {
          from: stored.status,
          to: 'REFUND_PENDING',
          actorUid: admin.uid,
          actorRole: 'admin',
        },
      ];
      return response;
    }

    // action === 'COMPLETE' (explicit confirmation already validated).
    if (stored.status === 'REFUNDED') {
      throw new ApiError(
        409,
        'refund_already_completed',
        'This order has already been refunded and cannot be refunded again.'
      );
    }
    if (stored.status !== 'REFUND_PENDING') {
      throw new ApiError(
        409,
        'invalid_refund_transition',
        'Record the refund as pending first, then complete it once the money was actually sent.'
      );
    }

    const now = new Date();
    tx.update(orderRef, {
      refund: {
        ...stored.raw,
        status: 'REFUNDED' as RefundStatus,
        completedBy: admin.uid,
        completedAt: FieldValue.serverTimestamp(),
      },
      refundAudit: [
        ...audit,
        {
          from: stored.status,
          to: 'REFUNDED',
          actorUid: admin.uid,
          actorRole: 'admin',
        },
      ],
      updatedAt: FieldValue.serverTimestamp(),
    });

    const response = serializeOrder(
      orderId,
      {
        ...data,
        refund: {
          ...stored.raw,
          status: 'REFUNDED' as RefundStatus,
          completedBy: admin.uid,
          completedAt: now,
        },
        updatedAt: now,
      },
      { isAdmin: true }
    );
    response.refundAudit = [
      ...audit,
      {
        from: stored.status,
        to: 'REFUNDED',
        actorUid: admin.uid,
        actorRole: 'admin',
      },
    ];
    return response;
  });
}
