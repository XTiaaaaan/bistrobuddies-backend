import { Router } from 'express';
import { notFound } from '../errors';
import { parseMultipartImage } from '../lib/image-upload';
import {
  validateCreateOrderRequest,
  validateGcashDetails,
} from '../lib/validation';
import {
  getAuth,
  hasAdminRole,
  requireAuth,
} from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import {
  cancelOrder,
  createOrder,
  getOrder,
  submitGcashDetails,
  submitGcashProof,
} from '../services/orders.service';

export const ordersRouter = Router();

/**
 * POST /api/orders — create an order (authenticated customers only).
 *
 * The customer identity is derived from the verified Firebase ID token and
 * all prices/totals are computed server-side from authoritative product data.
 */
ordersRouter.post(
  '/orders',
  rateLimit({ name: 'orders-create', limit: 20, windowMs: 60_000 }),
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    const request = validateCreateOrderRequest(req.body);
    const summary = await createOrder(user, request);
    res.status(201).json(summary);
  })
);

/**
 * GET /api/orders/:id — read a single order (authenticated).
 *
 * Owners and administrators only; other users receive 404 so order ids
 * cannot be enumerated. Stored prices are returned exactly as recorded at
 * purchase time and are never recomputed.
 */
ordersRouter.get(
  '/orders/:id',
  rateLimit({ name: 'orders-read', limit: 120, windowMs: 60_000 }),
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const order = await getOrder(user, orderId, {
      isAdmin: await hasAdminRole(user.uid),
    });
    res.json(order);
  })
);

/**
 * POST /api/orders/:id/cancel — cancel an order (owner only).
 *
 * Only the order owner may cancel, and only while the order is still awaiting
 * confirmation (`PENDING`). The document is never deleted: `orderStatus` is set
 * to `CANCELLED` and the independent `paymentStatus` is left untouched. The
 * updated order is returned in the same shape as GET /api/orders/:id.
 */
ordersRouter.post(
  '/orders/:id/cancel',
  rateLimit({ name: 'orders-cancel', limit: 20, windowMs: 60_000 }),
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const order = await cancelOrder(user, orderId);
    res.json(order);
  })
);

/**
 * POST /api/orders/:id/gcash-details — submit GCash payment details (owner only).
 *
 * The caller must own the order, the order must use paymentMethod GCASH, and
 * its payment must not already be confirmed. Only the GCash account name and
 * mobile number are read from the body — totals, statuses and credentials are
 * never accepted. A successful submission moves paymentStatus to VERIFYING;
 * repeating it (including after an admin REJECTED it) is safe and returns the
 * order to VERIFYING with the latest details.
 */
ordersRouter.post(
  '/orders/:id/gcash-details',
  rateLimit({ name: 'orders-gcash', limit: 20, windowMs: 60_000 }),
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }
    const input = validateGcashDetails(req.body);
    const result = await submitGcashDetails(user, orderId, input);
    res.json(result);
  })
);

const paymentProofHandler = asyncHandler(async (req, res) => {
  const user = getAuth(req);
  const orderId = (req.params['id'] ?? '').trim();
  if (!orderId || orderId.length > 128) {
    throw notFound('order_not_found', 'This order no longer exists.');
  }
  const result = await submitGcashProof(user, orderId, req.file);
  res.status(201).json(result);
});

/**
 * POST /api/orders/:id/payment-proof — upload GCash payment proof (owner only).
 *
 * `multipart/form-data` with exactly one image in the field named `file`:
 * JPEG/PNG/WebP by magic bytes, at most `UPLOAD_MAX_BYTES` (default 5 MB).
 * The customer identity comes from the verified token and the order must
 * belong to that customer, use GCASH, and not already be PAID. On success the
 * image is stored in Cloudinary and only its HTTPS URL/metadata are written to
 * the order; `paymentStatus` moves to VERIFYING (never PAID automatically).
 * Proof may be replaced while VERIFYING or after a REJECTED decision.
 *
 * `/gcash-proof` is an equivalent alias for clients using that name.
 */
ordersRouter.post(
  '/orders/:id/payment-proof',
  rateLimit({ name: 'orders-gcash-proof', limit: 20, windowMs: 60_000 }),
  requireAuth,
  parseMultipartImage,
  paymentProofHandler
);

ordersRouter.post(
  '/orders/:id/gcash-proof',
  rateLimit({ name: 'orders-gcash-proof', limit: 20, windowMs: 60_000 }),
  requireAuth,
  parseMultipartImage,
  paymentProofHandler
);
