import { FieldIssue, badRequest } from '../errors';
import { roundMoney } from './money';

export type ProductSize = 'small' | 'medium' | 'large';
/**
 * Payment methods accepted on order creation.
 *
 * - `COD` — cash on delivery (unchanged behaviour).
 * - `GCASH` — manual GCash verification by an admin (see docs/API_CONTRACT.md).
 *
 * Unknown values are rejected — they are never silently treated as COD.
 */
export type PaymentMethod = 'COD' | 'GCASH';
export type OrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PREPARING'
  | 'READY'
  | 'OUT_FOR_DELIVERY'
  | 'COMPLETED'
  | 'CANCELLED';

export const PRODUCT_SIZES: ProductSize[] = ['small', 'medium', 'large'];

/** Sugar choices documented in PROJECT_CONTEXT.md and used by the apps. */
export const SUGAR_CHOICES = [
  'No Sugar',
  'Less Sugar',
  'Regular',
  'Extra Sugar',
] as const;

export const ORDER_STATUSES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'OUT_FOR_DELIVERY',
  'COMPLETED',
  'CANCELLED',
];

/**
 * User-facing labels for the internal order statuses. `OUT_FOR_DELIVERY` is
 * stored exactly as-is and displayed as "On the Way".
 */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PREPARING: 'Preparing',
  READY: 'Ready',
  OUT_FOR_DELIVERY: 'On the Way',
  COMPLETED: 'Delivered',
  CANCELLED: 'Cancelled',
};

/**
 * Allowed order status transitions (server-enforced).
 *
 * Every order is delivered and follows `CONFIRMED -> PREPARING -> READY ->
 * OUT_FOR_DELIVERY -> COMPLETED` (displayed as Confirmed → Preparing → Ready →
 * On the Way → Delivered). `OUT_FOR_DELIVERY` is only reachable from `READY`,
 * and `COMPLETED` is only reachable from `OUT_FOR_DELIVERY`, so an order can
 * never be marked delivered before it is on the way.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** Returns the user-facing label for an order status. */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status;
}

export const MAX_ORDER_ITEMS = 50;
export const MAX_QUANTITY = 99;

export interface CreateOrderItemInput {
  productId: string;
  size: ProductSize;
  sugar: string;
  quantity: number;
}

export interface CreateOrderRequest {
  items: CreateOrderItemInput[];
  customer: { name: string; phone: string };
  address: {
    recipientName: string;
    phone: string;
    address: string;
    city?: string;
    postalCode?: string;
  };
  customerComment: string;
  paymentMethod: PaymentMethod;
}

const PHONE_PATTERN = /^[0-9+\-()\s]{7,20}$/;

class Issues {
  private readonly list: FieldIssue[] = [];

  add(field: string, message: string): void {
    this.list.push({ field, message });
  }

  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  throwIfAny(message = 'The request payload is invalid.'): void {
    if (!this.isEmpty) {
      throw badRequest(message, this.list);
    }
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Expected a JSON object body.');
  }
  return body as Record<string, unknown>;
}

function readString(
  source: Record<string, unknown>,
  field: string,
  issues: Issues,
  options: { required?: boolean; min?: number; max: number }
): string | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null || raw === '') {
    if (options.required) {
      issues.add(field, `${field} is required.`);
      return undefined;
    }
    if (raw === '') {
      return '';
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    issues.add(field, `${field} must be a string.`);
    return undefined;
  }
  const value = raw.trim();
  const min = options.required ? (options.min ?? 1) : 0;
  if (value.length < min) {
    issues.add(field, `${field} must be at least ${min} characters.`);
    return undefined;
  }
  if (value.length > options.max) {
    issues.add(field, `${field} must be at most ${options.max} characters.`);
    return undefined;
  }
  return value;
}

function readPhone(
  source: Record<string, unknown>,
  field: string,
  issues: Issues
): string | undefined {
  const value = readString(source, field, issues, {
    required: true,
    max: 20,
  });
  if (value !== undefined && !PHONE_PATTERN.test(value)) {
    issues.add(field, `${field} must be a valid phone number.`);
    return undefined;
  }
  return value;
}

function readNumberField(
  source: Record<string, unknown>,
  field: string,
  issues: Issues,
  options: { required?: boolean }
): number | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    if (options.required) {
      issues.add(field, `${field} is required.`);
    }
    return undefined;
  }
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issues.add(field, `${field} must be a number greater than 0.`);
    return undefined;
  }
  return value;
}

/**
 * Reads a PHP price field with the project's existing price rules (a finite
 * number greater than 0) and normalizes it to two-decimal precision using the
 * same `roundMoney` convention the order totals use, so every stored size
 * price is a valid centavo amount (`99.999` → `100`, `0.001` → rejected).
 */
function readPriceField(
  source: Record<string, unknown>,
  field: string,
  issues: Issues,
  options: { required?: boolean }
): number | undefined {
  const value = readNumberField(source, field, issues, options);
  if (value === undefined) {
    return undefined;
  }
  const rounded = roundMoney(value);
  if (rounded <= 0) {
    issues.add(field, `${field} must be at least 0.01.`);
    return undefined;
  }
  return rounded;
}

function readBooleanField(
  source: Record<string, unknown>,
  field: string,
  issues: Issues,
  options: { required?: boolean }
): boolean | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    if (options.required) {
      issues.add(field, `${field} is required.`);
    }
    return undefined;
  }
  if (typeof raw !== 'boolean') {
    issues.add(field, `${field} must be true or false.`);
    return undefined;
  }
  return raw;
}

/** Validates the POST /api/orders request body. */
export function validateCreateOrderRequest(body: unknown): CreateOrderRequest {
  const source = asObject(body);
  const issues = new Issues();

  // items
  const itemsRaw = source['items'];
  let items: CreateOrderItemInput[] = [];
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    issues.add('items', 'items must be a non-empty array.');
  } else if (itemsRaw.length > MAX_ORDER_ITEMS) {
    issues.add('items', `items must contain at most ${MAX_ORDER_ITEMS} entries.`);
  } else {
    items = itemsRaw.map((entry, index): CreateOrderItemInput => {
      const field = `items[${index}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.add(field, `${field} must be an object.`);
        return { productId: '', size: 'small', sugar: '', quantity: 1 };
      }
      const record = entry as Record<string, unknown>;
      const productId = readString(record, 'productId', issues, {
        required: true,
        max: 128,
      });
      const sizeRaw = record['size'];
      let size: ProductSize = 'small';
      if (
        typeof sizeRaw !== 'string' ||
        !PRODUCT_SIZES.includes(sizeRaw as ProductSize)
      ) {
        issues.add(`${field}.size`, `${field}.size must be small, medium or large.`);
      } else {
        size = sizeRaw as ProductSize;
      }
      const sugar = readString(record, 'sugar', issues, {
        required: true,
        max: 64,
      });
      const quantityRaw = record['quantity'];
      let quantity = 1;
      if (
        typeof quantityRaw !== 'number' ||
        !Number.isInteger(quantityRaw) ||
        quantityRaw < 1 ||
        quantityRaw > MAX_QUANTITY
      ) {
        issues.add(
          `${field}.quantity`,
          `${field}.quantity must be an integer between 1 and ${MAX_QUANTITY}.`
        );
      } else {
        quantity = quantityRaw;
      }
      return {
        productId: productId ?? '',
        size,
        sugar: sugar ?? '',
        quantity,
      };
    });
  }

  // customer
  const customerRaw = source['customer'];
  let customer = { name: '', phone: '' };
  if (
    customerRaw === null ||
    typeof customerRaw !== 'object' ||
    Array.isArray(customerRaw)
  ) {
    issues.add('customer', 'customer is required.');
  } else {
    const record = customerRaw as Record<string, unknown>;
    const name = readString(record, 'name', issues, {
      required: true,
      max: 120,
    });
    const phone = readPhone(record, 'phone', issues);
    customer = { name: name ?? '', phone: phone ?? '' };
  }

  // address
  const addressRaw = source['address'];
  let address: CreateOrderRequest['address'] = {
    recipientName: '',
    phone: '',
    address: '',
  };
  if (
    addressRaw === null ||
    typeof addressRaw !== 'object' ||
    Array.isArray(addressRaw)
  ) {
    issues.add('address', 'address is required.');
  } else {
    const record = addressRaw as Record<string, unknown>;
    const recipientName = readString(record, 'recipientName', issues, {
      required: true,
      max: 120,
    });
    const phone = readPhone(record, 'phone', issues);
    const street = readString(record, 'address', issues, {
      required: true,
      max: 400,
    });
    const city = readString(record, 'city', issues, { max: 120 });
    const postalCode = readString(record, 'postalCode', issues, { max: 16 });
    address = {
      recipientName: recipientName ?? '',
      phone: phone ?? '',
      address: street ?? '',
      ...(city !== undefined ? { city } : {}),
      ...(postalCode !== undefined ? { postalCode } : {}),
    };
  }

  // comment (optional, defaults to '')
  const comment = readString(source, 'customerComment', issues, { max: 1000 });

  // payment method
  const paymentMethodRaw = source['paymentMethod'];
  let paymentMethod: PaymentMethod = 'COD';
  if (paymentMethodRaw !== 'COD' && paymentMethodRaw !== 'GCASH') {
    issues.add('paymentMethod', 'paymentMethod must be COD or GCASH.');
  } else {
    paymentMethod = paymentMethodRaw;
  }

  issues.throwIfAny();

  return {
    items,
    customer,
    address,
    customerComment: comment ?? '',
    paymentMethod,
  };
}

export interface ValidatedProductInput {
  name?: string;
  description?: string;
  category?: string;
  imageUrl?: string;
  cloudinaryPublicId?: string;
  /**
   * Legacy single PHP price, still accepted so older admin clients keep
   * working. The size tiers below are the canonical prices: `price` is never
   * allowed to replace them, it is re-derived from them server-side.
   */
  price?: number;
  /** Canonical PHP size prices — the source of truth for what each size costs. */
  smallPrice?: number;
  mediumPrice?: number;
  largePrice?: number;
  sugarOptions?: string[];
  available?: boolean;
}

export const SIZE_PRICE_FIELDS = [
  'smallPrice',
  'mediumPrice',
  'largePrice',
] as const;

/** `currency` is never accepted from clients — the server always writes PHP. */
const UPDATABLE_PRODUCT_FIELDS = new Set([
  'name',
  'description',
  'category',
  'imageUrl',
  'cloudinaryPublicId',
  'price',
  ...SIZE_PRICE_FIELDS,
  'sugarOptions',
  'available',
]);

/**
 * Validates product payloads for the admin API.
 * With `partial: false` (create) all required product fields must be present.
 * With `partial: true` (update) only the provided fields are validated.
 */
export function validateProductInput(
  body: unknown,
  options: { partial: boolean }
): ValidatedProductInput {
  const source = asObject(body);
  const issues = new Issues();
  const result: ValidatedProductInput = {};

  const provided = Object.keys(source).filter((key) =>
    UPDATABLE_PRODUCT_FIELDS.has(key)
  );
  if (provided.length === 0) {
    throw badRequest('No updatable product fields were provided.');
  }

  if (!options.partial || source['name'] !== undefined) {
    const name = readString(source, 'name', issues, {
      required: true,
      max: 120,
    });
    if (name !== undefined) {
      result.name = name;
    }
  }
  if (!options.partial || source['description'] !== undefined) {
    const description = readString(source, 'description', issues, {
      max: 2000,
    });
    if (description !== undefined) {
      result.description = description;
    } else if (!options.partial) {
      result.description = '';
    }
  }
  if (!options.partial || source['category'] !== undefined) {
    const category = readString(source, 'category', issues, {
      required: true,
      max: 64,
    });
    if (category !== undefined) {
      result.category = category;
    }
  }
  if (!options.partial || source['imageUrl'] !== undefined) {
    const imageUrl = readString(source, 'imageUrl', issues, { max: 2048 });
    if (imageUrl !== undefined) {
      result.imageUrl = imageUrl;
    } else if (!options.partial) {
      result.imageUrl = '';
    }
  }
  if (!options.partial || source['cloudinaryPublicId'] !== undefined) {
    const cloudinaryPublicId = readString(source, 'cloudinaryPublicId', issues, {
      max: 255,
    });
    if (cloudinaryPublicId !== undefined) {
      result.cloudinaryPublicId = cloudinaryPublicId;
    } else if (!options.partial) {
      result.cloudinaryPublicId = '';
    }
  }

  // Legacy single price. Optional on create — when it is the only price
  // supplied, the server writes flat pricing (all three size tiers) so
  // size-selector clients keep working. It never overwrites size tiers that
  // are supplied in the same payload or already stored on the product.
  const hasCanonicalPrice = source['price'] !== undefined;
  if (hasCanonicalPrice) {
    const price = readPriceField(source, 'price', issues, { required: true });
    if (price !== undefined) {
      result.price = price;
    }
  }

  // Canonical size prices: small/medium/large are what a customer pays per
  // size. On create they are required unless the legacy `price` was supplied
  // (flat pricing); on update only the provided tiers change and the stored
  // tiers are never replaced by a single legacy `price`.
  for (const priceField of SIZE_PRICE_FIELDS) {
    const provided = source[priceField] !== undefined;
    if (!options.partial && !provided && !hasCanonicalPrice) {
      issues.add(
        priceField,
        `${priceField} is required unless price is provided.`
      );
      continue;
    }
    if (!provided) {
      continue;
    }
    const price = readPriceField(source, priceField, issues, {
      required: true,
    });
    if (price !== undefined) {
      result[priceField] = price;
    }
  }

  if (!options.partial || source['sugarOptions'] !== undefined) {
    const sugarRaw = source['sugarOptions'];
    if (!Array.isArray(sugarRaw) || sugarRaw.length === 0) {
      issues.add('sugarOptions', 'sugarOptions must be a non-empty array.');
    } else {
      const invalid = sugarRaw.filter(
        (entry) =>
          typeof entry !== 'string' ||
          !(SUGAR_CHOICES as readonly string[]).includes(entry)
      );
      if (invalid.length > 0) {
        issues.add(
          'sugarOptions',
          `sugarOptions may only contain: ${SUGAR_CHOICES.join(', ')}.`
        );
      } else {
        result.sugarOptions = sugarRaw as string[];
      }
    }
  }

  if (!options.partial || source['available'] !== undefined) {
    const available = readBooleanField(source, 'available', issues, {
      required: true,
    });
    if (available !== undefined) {
      result.available = available;
    }
  }

  issues.throwIfAny('The product payload is invalid.');
  return result;
}

export interface ContactMessageInput {
  name: string;
  email: string;
  subject: string;
  message: string;
}

/** Maximum accepted lengths for the Contact Us form fields. */
export const CONTACT_NAME_MAX = 120;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_SUBJECT_MAX = 150;
export const CONTACT_MESSAGE_MAX = 2000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates the POST /api/contact-messages request body.
 *
 * Values are trimmed and rejected when empty/whitespace-only or longer than
 * the limits above; `email` must additionally look like an email address.
 * Only these four fields are read — any other client-supplied properties
 * (e.g. `userId`, `status`, timestamps) are ignored and never trusted.
 */
export function validateContactMessageRequest(body: unknown): ContactMessageInput {
  const source = asObject(body);
  const issues = new Issues();

  const name = readString(source, 'name', issues, {
    required: true,
    max: CONTACT_NAME_MAX,
  });
  const email = readString(source, 'email', issues, {
    required: true,
    max: CONTACT_EMAIL_MAX,
  });
  if (email !== undefined && !EMAIL_PATTERN.test(email)) {
    issues.add('email', 'email must be a valid email address.');
  }
  const subject = readString(source, 'subject', issues, {
    required: true,
    max: CONTACT_SUBJECT_MAX,
  });
  const message = readString(source, 'message', issues, {
    required: true,
    max: CONTACT_MESSAGE_MAX,
  });

  issues.throwIfAny('The contact message payload is invalid.');

  return {
    name: name ?? '',
    email: email ?? '',
    subject: subject ?? '',
    message: message ?? '',
  };
}

/** Maximum accepted length for an admin reply body. */
export const CONTACT_REPLY_MAX = 5000;

export interface ContactMessageReplyInput {
  reply: string;
}

/**
 * Validates POST /api/admin/contact-messages/:id/replies bodies.
 *
 * Only `reply` is read — any client-supplied `senderRole`, `id` or timestamp
 * properties are ignored and never trusted; the sender role and timestamps
 * are decided by the server. The value is trimmed and rejected when
 * whitespace-only or longer than CONTACT_REPLY_MAX.
 */
export function validateContactMessageReply(body: unknown): ContactMessageReplyInput {
  const source = asObject(body);
  const issues = new Issues();

  const reply = readString(source, 'reply', issues, {
    required: true,
    max: CONTACT_REPLY_MAX,
  });

  issues.throwIfAny('The reply payload is invalid.');

  return { reply: reply ?? '' };
}

/** Sender roles stored on a contact-message reply. */
export type ContactReplySenderRole = 'ADMIN' | 'CUSTOMER';

export type ContactMessageStatus = 'NEW' | 'READ' | 'RESOLVED';

/** Workflow statuses a stored contact message can carry. */
export const CONTACT_MESSAGE_STATUSES: ContactMessageStatus[] = [
  'NEW',
  'READ',
  'RESOLVED',
];

/**
 * Statuses the admin API accepts on an update. `NEW` is the server-assigned
 * initial status only — an administrator moves messages forward to READ or
 * RESOLVED, never back to NEW.
 */
export const CONTACT_MESSAGE_UPDATABLE_STATUSES: ContactMessageStatus[] = [
  'READ',
  'RESOLVED',
];

export const CONTACT_MESSAGES_DEFAULT_PAGE_SIZE = 25;
export const CONTACT_MESSAGES_MAX_PAGE_SIZE = 100;

/** Validates PATCH /api/admin/contact-messages/:id/status body. */
export function validateContactMessageStatusUpdate(
  body: unknown
): ContactMessageStatus {
  const source = asObject(body);
  const raw = source['status'];
  if (
    typeof raw !== 'string' ||
    !CONTACT_MESSAGE_UPDATABLE_STATUSES.includes(raw as ContactMessageStatus)
  ) {
    throw badRequest(
      `status must be one of: ${CONTACT_MESSAGE_UPDATABLE_STATUSES.join(', ')}.`
    );
  }
  return raw as ContactMessageStatus;
}

export interface ContactMessageListQuery {
  page: number;
  pageSize: number;
  status?: ContactMessageStatus;
}

/** Parses a query-string value into a positive integer, or null when invalid. */
function readPositiveInteger(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

/**
 * Validates GET /api/admin/contact-messages query parameters.
 *
 * `status` (optional) must be a known workflow status; `page` and `pageSize`
 * (optional) must be positive integers with `pageSize` capped at
 * CONTACT_MESSAGES_MAX_PAGE_SIZE so a single request can never ask Firestore
 * for an unbounded page.
 */
export function readContactMessageListQuery(
  query: Record<string, unknown>
): ContactMessageListQuery {
  const issues = new Issues();
  let page = 1;
  let pageSize = CONTACT_MESSAGES_DEFAULT_PAGE_SIZE;
  let status: ContactMessageStatus | undefined;

  const statusRaw = query['status'];
  if (statusRaw !== undefined && statusRaw !== null && statusRaw !== '') {
    if (
      typeof statusRaw !== 'string' ||
      !CONTACT_MESSAGE_STATUSES.includes(statusRaw as ContactMessageStatus)
    ) {
      issues.add(
        'status',
        `status must be one of: ${CONTACT_MESSAGE_STATUSES.join(', ')}.`
      );
    } else {
      status = statusRaw as ContactMessageStatus;
    }
  }

  const pageRaw = query['page'];
  if (pageRaw !== undefined && pageRaw !== null && pageRaw !== '') {
    const parsed = readPositiveInteger(pageRaw);
    if (parsed === null) {
      issues.add('page', 'page must be a positive integer.');
    } else {
      page = parsed;
    }
  }

  const pageSizeRaw = query['pageSize'];
  if (pageSizeRaw !== undefined && pageSizeRaw !== null && pageSizeRaw !== '') {
    const parsed = readPositiveInteger(pageSizeRaw);
    if (parsed === null || parsed > CONTACT_MESSAGES_MAX_PAGE_SIZE) {
      issues.add(
        'pageSize',
        `pageSize must be an integer between 1 and ${CONTACT_MESSAGES_MAX_PAGE_SIZE}.`
      );
    } else {
      pageSize = parsed;
    }
  }

  issues.throwIfAny('The contact message query is invalid.');

  return {
    page,
    pageSize,
    ...(status !== undefined ? { status } : {}),
  };
}

/** Validates and normalizes a `:id` path parameter for contact message routes. */
export function readContactMessageId(raw: string): string {
  let decoded = raw ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed percent-encoding: treat the raw value as the id.
  }
  const messageId = decoded.trim();
  if (!messageId || messageId.length > 128) {
    throw badRequest('A valid message id is required.', [
      { field: 'id', message: 'id must be 1-128 characters.' },
    ]);
  }
  return messageId;
}

/**
 * Payment lifecycle for manual GCash verification (stored on the order doc).
 *
 * - `PENDING` — initial status for every new order (COD and GCash alike).
 * - `VERIFYING` — the customer submitted GCash details; awaiting admin review.
 * - `PAID` — an admin confirmed the payment (terminal).
 * - `REJECTED` — an admin rejected the payment; the customer may resubmit,
 *   which moves the order back to `VERIFYING`.
 *
 * COD orders stay `PENDING` until the order reaches `COMPLETED` (delivery),
 * at which point the successful cash collection is recorded as `PAID` by the
 * backend. GCash orders are only ever marked `PAID` by an admin decision.
 * Payment status and the separate fulfilment field `orderStatus` stay
 * independent.
 */
export type PaymentStatus = 'PENDING' | 'VERIFYING' | 'PAID' | 'REJECTED';

/** Decisions an admin may record on a GCash payment. */
export type PaymentDecision = 'PAID' | 'REJECTED';

export const PAYMENT_DECISIONS: PaymentDecision[] = ['PAID', 'REJECTED'];

/** Maximum accepted lengths for the GCash payment-detail fields. */
export const GCASH_ACCOUNT_NAME_MIN = 2;
export const GCASH_ACCOUNT_NAME_MAX = 80;

export interface GcashDetailsInput {
  /** Trimmed account name (whitespace collapsed). Never proves payment. */
  accountName: string;
  /** Philippine mobile number normalized to local `09XXXXXXXXX` form. */
  accountNumber: string;
}

/**
 * Normalizes a Philippine mobile number to local `09XXXXXXXXX` form.
 *
 * Accepted inputs (ignoring spaces, hyphens, dots and parentheses):
 * `09XXXXXXXXX`, `639XXXXXXXXX` and `+639XXXXXXXXX`. Anything else —
 * landlines, short codes, non-PH numbers, letters — returns null.
 */
export function normalizeGcashNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const compact = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^(?:\+?63|0)9\d{9}$/.test(compact)) {
    return null;
  }
  if (compact.startsWith('+63')) {
    return `0${compact.slice(3)}`;
  }
  if (compact.startsWith('63')) {
    return `0${compact.slice(2)}`;
  }
  return compact;
}

/**
 * Validates POST /api/orders/:id/gcash-details bodies.
 *
 * Only `accountName` and `accountNumber` are read — any other properties
 * (totals, statuses, `pin`/`otp`/`password` or other credentials) are ignored
 * and never trusted. GCash credentials must never be sent; this endpoint has
 * no fields for them.
 */
export function validateGcashDetails(body: unknown): GcashDetailsInput {
  const source = asObject(body);
  const issues = new Issues();

  const accountName = readString(source, 'accountName', issues, {
    required: true,
    min: GCASH_ACCOUNT_NAME_MIN,
    max: GCASH_ACCOUNT_NAME_MAX,
  });

  const numberRaw = source['accountNumber'];
  let accountNumber: string | null = null;
  if (typeof numberRaw !== 'string' || numberRaw.trim() === '') {
    issues.add('accountNumber', 'accountNumber is required.');
  } else {
    const normalized = normalizeGcashNumber(numberRaw);
    if (normalized === null) {
      issues.add(
        'accountNumber',
        'accountNumber must be a valid Philippine mobile number (e.g. 09171234567).'
      );
    } else {
      accountNumber = normalized;
    }
  }

  issues.throwIfAny('The GCash payment details are invalid.');

  // Collapse internal whitespace so equivalent names compare equal.
  const collapsed = (accountName ?? '').replace(/\s+/g, ' ').trim();
  return { accountName: collapsed, accountNumber: accountNumber ?? '' };
}

/** Validates POST /api/admin/orders/:id/payment bodies. */
export function validatePaymentDecision(body: unknown): PaymentDecision {
  const source = asObject(body);
  const raw = source['decision'];
  if (typeof raw !== 'string' || !PAYMENT_DECISIONS.includes(raw as PaymentDecision)) {
    throw badRequest('decision must be one of: PAID, REJECTED.');
  }
  return raw as PaymentDecision;
}

/**
 * Refund lifecycle for cancelled orders whose payment was confirmed as PAID.
 * Stored on the order document as `refund.status` — independent of the
 * `paymentStatus` field (which stays `PAID`; a refund is returned money, not
 * a payment-state change):
 *
 * - `NOT_REFUNDED` — default for every order; no refund recorded yet.
 * - `REFUND_PENDING` — an admin opened a refund; the money has not been sent.
 * - `REFUNDED` — an admin explicitly confirmed the money was actually sent.
 */
export type RefundStatus = 'NOT_REFUNDED' | 'REFUND_PENDING' | 'REFUNDED';

export const REFUND_STATUSES: RefundStatus[] = [
  'NOT_REFUNDED',
  'REFUND_PENDING',
  'REFUNDED',
];

/** Admin actions accepted on the refund endpoint. */
export type RefundAction = 'PENDING' | 'COMPLETE';

export const REFUND_ACTIONS: RefundAction[] = ['PENDING', 'COMPLETE'];

export interface RefundActionInput {
  action: RefundAction;
  /**
   * Explicit admin confirmation that the money was actually sent back. Only
   * required (and only meaningful) for `COMPLETE` — starting a refund never
   * needs it and never marks the refund completed.
   */
  confirmed: boolean;
}

/** Validates POST /api/admin/orders/:id/refund bodies. */
export function validateRefundAction(body: unknown): RefundActionInput {
  const source = asObject(body);
  const raw = source['action'];
  if (
    typeof raw !== 'string' ||
    !REFUND_ACTIONS.includes(raw as RefundAction)
  ) {
    throw badRequest('action must be one of: PENDING, COMPLETE.');
  }
  const action = raw as RefundAction;
  const confirmed = source['confirmed'] === true;
  if (action === 'COMPLETE' && !confirmed) {
    throw badRequest(
      'Recording a completed refund requires explicit confirmation: set "confirmed" to true.'
    );
  }
  return { action, confirmed };
}

/** Platforms a registered FCM device token can report. */
export type DevicePlatform = 'android' | 'ios' | 'web' | 'unknown';

export const DEVICE_PLATFORMS: DevicePlatform[] = [
  'android',
  'ios',
  'web',
  'unknown',
];

export const MAX_DEVICE_TOKEN_LENGTH = 4096;

export interface DeviceTokenInput {
  token: string;
  platform: DevicePlatform;
}

function readDeviceToken(source: Record<string, unknown>, issues: Issues): string {
  const raw = source['token'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    issues.add('token', 'token is required.');
    return '';
  }
  const token = raw.trim();
  if (token.length > MAX_DEVICE_TOKEN_LENGTH) {
    issues.add(
      'token',
      `token must be at most ${MAX_DEVICE_TOKEN_LENGTH} characters.`
    );
  } else if (/\s/.test(token)) {
    issues.add('token', 'token must not contain whitespace.');
  }
  return token;
}

/**
 * Validates POST /api/notifications/devices bodies.
 *
 * Only the FCM registration `token` and an optional `platform` are read. The
 * owning uid always comes from the verified auth token, never the body.
 */
export function validateDeviceTokenRegistration(
  body: unknown
): DeviceTokenInput {
  const source = asObject(body);
  const issues = new Issues();
  const token = readDeviceToken(source, issues);

  let platform: DevicePlatform = 'unknown';
  const platformRaw = source['platform'];
  if (platformRaw !== undefined && platformRaw !== null && platformRaw !== '') {
    const normalized =
      typeof platformRaw === 'string' ? platformRaw.trim().toLowerCase() : '';
    if (!DEVICE_PLATFORMS.includes(normalized as DevicePlatform)) {
      issues.add(
        'platform',
        `platform must be one of: ${DEVICE_PLATFORMS.join(', ')}.`
      );
    } else {
      platform = normalized as DevicePlatform;
    }
  }

  issues.throwIfAny('The device token payload is invalid.');
  return { token, platform };
}

/** Validates DELETE /api/notifications/devices bodies. */
export function validateDeviceTokenRemoval(body: unknown): { token: string } {
  const source = asObject(body);
  const issues = new Issues();
  const token = readDeviceToken(source, issues);
  issues.throwIfAny('The device token payload is invalid.');
  return { token };
}

/** Validates POST /api/admin/orders/:id/status body. */
export function validateOrderStatus(body: unknown): OrderStatus {
  const source = asObject(body);
  const raw = source['orderStatus'];
  if (typeof raw !== 'string' || !ORDER_STATUSES.includes(raw as OrderStatus)) {
    throw badRequest(
      `orderStatus must be one of: ${ORDER_STATUSES.join(', ')}.`
    );
  }
  return raw as OrderStatus;
}

/** Returns the new status list when `next` is a legal transition from `current`. */
export function allowedNextStatuses(current: OrderStatus): OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[current] ?? [];
}

/** Validates and normalizes a `:id` path parameter for product routes. */
export function readProductId(raw: string): string {
  let decoded = raw ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed percent-encoding: treat the raw value as the id.
  }
  const productId = decoded.trim();
  if (!productId || productId.length > 128) {
    throw badRequest('A valid product id is required.', [
      { field: 'id', message: 'id must be 1-128 characters.' },
    ]);
  }
  return productId;
}
