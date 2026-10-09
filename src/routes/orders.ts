import { Router } from 'express';
import { notFound } from '../errors';
import { validateCreateOrderRequest } from '../lib/validation';
import {
  getAuth,
  hasAdminRole,
  requireAuth,
} from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { createOrder, getOrder } from '../services/orders.service';

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
