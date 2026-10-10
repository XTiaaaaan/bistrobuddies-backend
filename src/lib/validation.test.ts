import { describe, expect, it } from 'vitest';
import { ApiError, FieldIssue } from '../errors';
import {
  allowedNextStatuses,
  validateCreateOrderRequest,
  validateOrderStatus,
  validateProductInput,
} from './validation';

/** Asserts the callable throws an ApiError whose field details match `pattern`. */
function expectFieldIssues(fn: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const details = (caught as ApiError).details as FieldIssue[] | undefined;
  expect(Array.isArray(details)).toBe(true);
  expect(
    (details ?? []).some(
      (issue) => pattern.test(issue.message) || pattern.test(issue.field)
    )
  ).toBe(true);
}

function validOrderBody() {
  return {
    items: [{ productId: 'p1', size: 'small', sugar: 'Regular', quantity: 2 }],
    customer: { name: 'Juan dela Cruz', phone: '09171234567' },
    address: {
      recipientName: 'Juan dela Cruz',
      phone: '09171234567',
      address: '123 Rizal St, Manila',
    },
    customerComment: 'Please ring the bell',
    paymentMethod: 'COD',
  };
}

describe('validateCreateOrderRequest', () => {
  it('accepts a valid payload', () => {
    const request = validateCreateOrderRequest(validOrderBody());
    expect(request.items).toHaveLength(1);
    expect(request.items[0]).toEqual({
      productId: 'p1',
      size: 'small',
      sugar: 'Regular',
      quantity: 2,
    });
    expect(request.customer.name).toBe('Juan dela Cruz');
    expect(request.address.address).toBe('123 Rizal St, Manila');
    expect(request.paymentMethod).toBe('COD');
    expect(request.customerComment).toBe('Please ring the bell');
  });

  it('defaults an omitted comment to an empty string', () => {
    const body = validOrderBody();
    delete (body as Record<string, unknown>)['customerComment'];
    expect(validateCreateOrderRequest(body).customerComment).toBe('');
  });

  it('rejects a non-object body', () => {
    expect(() => validateCreateOrderRequest('nope')).toThrow(ApiError);
    expect(() => validateCreateOrderRequest(null)).toThrow(ApiError);
  });

  it('rejects empty items', () => {
    const body = validOrderBody();
    (body as { items: unknown[] }).items = [];
    expectFieldIssues(() => validateCreateOrderRequest(body), /items/);
  });

  it('rejects an invalid size', () => {
    const body = validOrderBody();
    (body.items[0] as { size: string }).size = 'gigantic';
    expect(() => validateCreateOrderRequest(body)).toThrow(ApiError);
  });

  it('rejects quantity outside 1..99', () => {
    const body = validOrderBody();
    (body.items[0] as { quantity: number }).quantity = 0;
    expect(() => validateCreateOrderRequest(body)).toThrow(ApiError);

    const body2 = validOrderBody();
    (body2.items[0] as { quantity: number }).quantity = 100;
    expect(() => validateCreateOrderRequest(body2)).toThrow(ApiError);
  });

  it('rejects an invalid phone number', () => {
    const body = validOrderBody();
    body.customer.phone = 'abc';
    expect(() => validateCreateOrderRequest(body)).toThrow(ApiError);
  });

  it('rejects an unknown payment method', () => {
    const body = validOrderBody();
    (body as { paymentMethod: string }).paymentMethod = 'BITCOIN';
    expect(() => validateCreateOrderRequest(body)).toThrow(ApiError);
  });
});

describe('validateProductInput', () => {
  const fullProduct = () => ({
    name: 'House Latte',
    description: 'Creamy latte',
    category: 'Hot',
    imageUrl: 'assets/products/hot/x.png',
    cloudinaryPublicId: '',
    smallPrice: 99,
    mediumPrice: 119,
    largePrice: 139,
    sugarOptions: ['No Sugar', 'Regular'],
    available: true,
  });

  it('accepts a full create payload', () => {
    const result = validateProductInput(fullProduct(), { partial: false });
    expect(result.name).toBe('House Latte');
    expect(result.smallPrice).toBe(99);
    expect(result.sugarOptions).toEqual(['No Sugar', 'Regular']);
    expect(result.available).toBe(true);
  });

  it('rejects a create payload without a name', () => {
    const body = fullProduct() as Record<string, unknown>;
    delete body['name'];
    expect(() => validateProductInput(body, { partial: false })).toThrow(
      ApiError
    );
  });

  it('keeps the three canonical size prices distinct (100/120/150)', () => {
    const result = validateProductInput(
      { ...fullProduct(), smallPrice: 100, mediumPrice: 120, largePrice: 150 },
      { partial: false }
    );
    expect(result.smallPrice).toBe(100);
    expect(result.mediumPrice).toBe(120);
    expect(result.largePrice).toBe(150);
    // The three tiers are never flattened into one another.
    expect(new Set([result.smallPrice, result.mediumPrice, result.largePrice]).size).toBe(3);
  });

  it('accepts the three size prices alongside a legacy price without flattening', () => {
    const result = validateProductInput(
      {
        ...fullProduct(),
        price: 100,
        smallPrice: 100,
        mediumPrice: 120,
        largePrice: 150,
      },
      { partial: false }
    );
    expect(result.price).toBe(100);
    expect(result.smallPrice).toBe(100);
    expect(result.mediumPrice).toBe(120);
    expect(result.largePrice).toBe(150);
  });

  it('rejects non-positive prices', () => {
    const body = fullProduct();
    body.smallPrice = 0;
    expectFieldIssues(
      () => validateProductInput(body, { partial: false }),
      /greater than 0/
    );
  });

  it('rejects a non-positive medium price', () => {
    const body = fullProduct();
    body.mediumPrice = -1;
    expectFieldIssues(
      () => validateProductInput(body, { partial: false }),
      /mediumPrice/
    );
  });

  it('rejects a non-positive large price', () => {
    const body = fullProduct();
    body.largePrice = 0;
    expectFieldIssues(
      () => validateProductInput(body, { partial: false }),
      /largePrice/
    );
  });

  it('normalizes size prices to two-decimal precision', () => {
    const result = validateProductInput(
      { ...fullProduct(), smallPrice: 99.999, mediumPrice: 120.001, largePrice: 149.995 },
      { partial: false }
    );
    expect(result.smallPrice).toBe(100);
    expect(result.mediumPrice).toBe(120);
    expect(result.largePrice).toBe(150);
  });

  it('rejects a price that rounds below one centavo', () => {
    expectFieldIssues(
      () =>
        validateProductInput({ ...fullProduct(), smallPrice: 0.001 }, { partial: false }),
      /at least 0.01/
    );
  });

  it('rejects sugar options outside the documented choices', () => {
    const body = fullProduct();
    body.sugarOptions = ['Keto'];
    expectFieldIssues(
      () => validateProductInput(body, { partial: false }),
      /sugarOptions/
    );
  });

  it('accepts the canonical price alongside the size tiers', () => {
    const result = validateProductInput(
      { ...fullProduct(), price: 100 },
      { partial: false }
    );
    expect(result.price).toBe(100);
    expect(result.mediumPrice).toBe(119);
  });

  it('allows a create payload that only supplies the canonical price', () => {
    const body = fullProduct() as Record<string, unknown>;
    delete body['smallPrice'];
    delete body['mediumPrice'];
    delete body['largePrice'];
    body['price'] = 88;
    const result = validateProductInput(body, { partial: false });
    expect(result.price).toBe(88);
    expect(result.smallPrice).toBeUndefined();
  });

  it('requires the size tiers when no canonical price is provided', () => {
    const body = fullProduct() as Record<string, unknown>;
    delete body['largePrice'];
    expectFieldIssues(
      () => validateProductInput(body, { partial: false }),
      /largePrice/
    );
  });

  it('rejects a non-positive canonical price', () => {
    expectFieldIssues(
      () => validateProductInput({ ...fullProduct(), price: 0 }, { partial: false }),
      /price/
    );
  });

  it('accepts a partial update that only changes the canonical price', () => {
    const result = validateProductInput({ price: 50 }, { partial: true });
    expect(result).toEqual({ price: 50 });
  });

  it('accepts a partial update that only changes the three size prices', () => {
    const result = validateProductInput(
      { smallPrice: 100, mediumPrice: 120, largePrice: 150 },
      { partial: true }
    );
    expect(result).toEqual({
      smallPrice: 100,
      mediumPrice: 120,
      largePrice: 150,
    });
  });

  it('never accepts a client-supplied currency field', () => {
    expect(() =>
      validateProductInput({ currency: 'USD' }, { partial: true })
    ).toThrow(ApiError);
  });

  it('accepts a partial update with only provided fields', () => {
    const result = validateProductInput({ available: false }, { partial: true });
    expect(result).toEqual({ available: false });
  });

  it('rejects an update with no known fields', () => {
    expect(() => validateProductInput({ bogus: 1 }, { partial: true })).toThrow(
      ApiError
    );
  });
});

describe('order status transitions', () => {
  it('validates known statuses', () => {
    expect(validateOrderStatus({ orderStatus: 'CONFIRMED' })).toBe('CONFIRMED');
    expect(() => validateOrderStatus({ orderStatus: 'BOGUS' })).toThrow(
      ApiError
    );
  });

  it('allows the documented forward path', () => {
    expect(allowedNextStatuses('PENDING')).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(allowedNextStatuses('CONFIRMED')).toContain('PREPARING');
    expect(allowedNextStatuses('PREPARING')).toContain('READY');
    expect(allowedNextStatuses('READY')).toContain('COMPLETED');
  });

  it('blocks backward and terminal transitions', () => {
    expect(allowedNextStatuses('COMPLETED')).toEqual([]);
    expect(allowedNextStatuses('CANCELLED')).toEqual([]);
    expect(allowedNextStatuses('CONFIRMED')).not.toContain('PENDING');
  });
});
