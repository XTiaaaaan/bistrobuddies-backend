import { Router } from 'express';
import { validateCreateOrderRequest } from '../lib/validation';
import { getAuth, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { createOrder } from '../services/orders.service';

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
