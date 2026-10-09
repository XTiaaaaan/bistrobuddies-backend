import { FieldIssue, badRequest } from '../errors';

export type ProductSize = 'small' | 'medium' | 'large';
export type PaymentMethod = 'COD' | 'ONLINE';
export type OrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PREPARING'
  | 'READY'
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
  'COMPLETED',
  'CANCELLED',
];

/** Allowed order status transitions (server-enforced). */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

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
  if (paymentMethodRaw !== 'COD' && paymentMethodRaw !== 'ONLINE') {
    issues.add('paymentMethod', 'paymentMethod must be COD or ONLINE.');
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
  smallPrice?: number;
  mediumPrice?: number;
  largePrice?: number;
  sugarOptions?: string[];
  available?: boolean;
}

const UPDATABLE_PRODUCT_FIELDS = new Set([
  'name',
  'description',
  'category',
  'imageUrl',
  'cloudinaryPublicId',
  'smallPrice',
  'mediumPrice',
  'largePrice',
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

  for (const priceField of ['smallPrice', 'mediumPrice', 'largePrice'] as const) {
    if (!options.partial || source[priceField] !== undefined) {
      const price = readNumberField(source, priceField, issues, {
        required: true,
      });
      if (price !== undefined) {
        result[priceField] = price;
      }
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
