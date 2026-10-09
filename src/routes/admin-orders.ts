import { FieldValue } from 'firebase-admin/firestore';
import { Router } from 'express';
import { ApiError, notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import {
  allowedNextStatuses,
  validateOrderStatus,
} from '../lib/validation';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';

export const adminOrdersRouter = Router();

const adminGuard = [
  rateLimit({ name: 'admin-orders', limit: 60, windowMs: 60_000 }),
  requireAuth,
  requireAdmin,
];

/**
 * POST /api/admin/orders/:id/status — transition an order's status (admin only).
 *
 * Transitions are validated against the allowed status graph; re-sending the
 * current status is treated as an idempotent no-op. The order status is never
 * taken from anywhere but this validated request body, and only after the
 * caller has been verified as an administrator server-side.
 */
adminOrdersRouter.post(
  '/orders/:id/status',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid order id is required.');
    }

    const nextStatus = validateOrderStatus(req.body);
    const { db } = requireFirebase();

    const orderRef = db.doc(`orders/${orderId}`);
    const snapshot = await orderRef.get();
    if (!snapshot.exists) {
      throw notFound('order_not_found', 'This order no longer exists.');
    }

    const currentStatus = snapshot.data()?.['orderStatus'];
    if (currentStatus === nextStatus) {
      // Idempotent: repeating the current status is a successful no-op.
      res.json({ id: orderId, orderStatus: currentStatus });
      return;
    }

    const allowed = allowedNextStatuses(
      currentStatus as Parameters<typeof allowedNextStatuses>[0]
    );
    if (!allowed.includes(nextStatus)) {
      throw new ApiError(
        400,
        'invalid_status_transition',
        `Cannot change order status from ${String(currentStatus)} to ${nextStatus}.`,
        { current: currentStatus, allowed }
      );
    }

    await orderRef.update({
      orderStatus: nextStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.json({ id: orderId, orderStatus: nextStatus });
  })
);
