import { FieldValue } from 'firebase-admin/firestore';
import { Router } from 'express';
import { ApiError, notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import {
  allowedNextStatuses,
  validateOrderStatus,
  validatePaymentDecision,
  validateRefundAction,
} from '../lib/validation';
import { getAuth, requireAdmin, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import { decideGcashPayment, recordRefundAction } from '../services/orders.service';

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

/**
 * POST /api/admin/orders/:id/payment — confirm or reject a GCash payment (admin only).
 *
 * Body: `{ "decision": "PAID" | "REJECTED" }`. The order must use paymentMethod
 * GCASH and currently be VERIFYING with submitted customer details. Repeating
 * the recorded decision is an idempotent no-op; a confirmed (PAID) payment can
 * never be overwritten, and REJECTED can only become PAID after the customer
 * resubmits details. Recording a decision never changes `orderStatus`.
 */
adminOrdersRouter.post(
  '/orders/:id/payment',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid order id is required.');
    }

    const decision = validatePaymentDecision(req.body);
    const admin = getAuth(req);
    const result = await decideGcashPayment(admin, orderId, decision);
    res.json(result);
  })
);

/**
 * POST /api/admin/orders/:id/refund — record a manual refund (admin only).
 *
 * The admin returns the money out-of-band (e.g. via the GCash app) and records
 * the actual outcome here:
 *
 * - `{ "action": "PENDING" }` opens a pending refund on a CANCELLED order
 *   whose payment is PAID; it never marks the refund completed.
 * - `{ "action": "COMPLETE", "confirmed": true }` marks it REFUNDED, only
 *   after the explicit confirmation that the money was actually sent back.
 *
 * The refunded amount is derived from the stored order snapshot, never from
 * the request body. `orderStatus` and `paymentStatus` are never changed. A
 * completed refund cannot be repeated. Returns the updated order.
 */
adminOrdersRouter.post(
  '/orders/:id/refund',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid order id is required.');
    }

    const { action, confirmed } = validateRefundAction(req.body);
    const admin = getAuth(req);
    const result = await recordRefundAction(admin, orderId, action, confirmed);
    res.json(result);
  })
);
