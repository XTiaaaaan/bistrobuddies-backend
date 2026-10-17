import { FieldValue } from 'firebase-admin/firestore';
import { config } from '../config';
import { ApiError, badRequest, notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { CURRENCY, resolvePrice, roundMoney } from '../lib/money';
import { toIso } from '../lib/serialize';
import {
  CreateOrderRequest,
  CreateOrderItemInput,
  GcashDetailsInput,
  MAX_QUANTITY,
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
    refund: readRefund(data),
    orderStatus:
      typeof data['orderStatus'] === 'string'
        ? data['orderStatus']
        : 'PENDING',
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

export interface PaymentDecisionResult {
  id: string;
  paymentStatus: PaymentStatus;
}

/**
 * Records an admin decision on a GCash payment.
 *
 * The order must use GCash and currently be `VERIFYING` with submitted
 * details. Repeating the current decision (`PAID` → `PAID`,
 * `REJECTED` → `REJECTED`) is an idempotent no-op that writes nothing.
 * A confirmed (`PAID`) payment can never be overwritten, and a `REJECTED`
 * payment can only become `PAID` after the customer resubmits details (which
 * returns the order to `VERIFYING`) — never directly. The fulfilment field
 * `orderStatus` is never touched here. Runs in a Firestore transaction so
 * concurrent admin decisions cannot create inconsistent states.
 */
export async function decideGcashPayment(
  admin: { uid: string },
  orderId: string,
  decision: PaymentDecision
): Promise<PaymentDecisionResult> {
  const { db } = requireFirebase();
  const orderRef = db.doc(`orders/${orderId}`);

  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(orderRef);
    if (!snapshot.exists) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const data = (snapshot.data() ?? {}) as Record<string, unknown>;
    if (data['paymentMethod'] !== 'GCASH') {
      throw new ApiError(
        409,
        'invalid_payment_method',
        'Only GCash orders can receive a GCash payment decision.'
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

    return { id: orderId, paymentStatus: decision };
  });
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
