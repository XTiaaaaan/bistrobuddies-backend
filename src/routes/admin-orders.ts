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
import {
  confirmCodPayment,
  decideOrderPayment,
  recordRefundAction,
} from '../services/orders.service';
import { notifyOrderStatusChanged } from '../services/notifications.service';

export const adminOrdersRouter = Router();

const adminGuard = [
  rateLimit({ name: 'admin-orders', limit: 60, windowMs: 60_000 }),
  requireAuth,
  requireAdmin,
];

type PaymentAuditRecord = {
  from: string;
  to: string;
  actorUid: string;
  actorRole: 'customer' | 'admin';
};

const PAYMENT_STATUSES = new Set(['PENDING', 'VERIFYING', 'PAID', 'REJECTED']);

function storedPaymentStatus(data: Record<string, unknown>): string {
  const raw = data['paymentStatus'];
  return typeof raw === 'string' && PAYMENT_STATUSES.has(raw)
    ? raw
    : 'PENDING';
}

/** Keeps the existing append-only audit entries exactly as they were stored. */
function storedPaymentAudit(data: Record<string, unknown>): PaymentAuditRecord[] {
  const raw = data['paymentAudit'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: PaymentAuditRecord[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record['from'] === 'string' &&
      typeof record['to'] === 'string' &&
      typeof record['actorUid'] === 'string' &&
      (record['actorRole'] === 'customer' || record['actorRole'] === 'admin')
    ) {
      entries.push({
        from: record['from'],
        to: record['to'],
        actorUid: record['actorUid'],
        actorRole: record['actorRole'],
      });
    }
  }
  return entries;
}

/**
 * POST /api/admin/orders/:id/status — transition an order's status (admin only).
 *
 * Transitions are validated against the allowed status graph; re-sending the
 * current status is treated as an idempotent no-op. The order status is never
 * taken from anywhere but this validated request body, and only after the
 * caller has been verified as an administrator server-side.
 *
 * Fulfilment and payment stay separate fields, but a COD order reaching its
 * final delivered state (`COMPLETED`) records the successful cash collection
 * as `PAID` in the same transaction. GCash orders are never marked PAID by a
 * status change — they still require an authorized admin payment decision.
 * Cancelling an order never changes payment. Existing audit history and the
 * existing payment decision/timestamp are preserved; the automatic COD
 * settlement is skipped when the payment is already PAID.
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
    const admin = getAuth(req);
    const { db } = requireFirebase();

    const orderRef = db.doc(`orders/${orderId}`);
    const result = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(orderRef);
      if (!snapshot.exists) {
        throw notFound('order_not_found', 'This order no longer exists.');
      }

      const data = (snapshot.data() ?? {}) as Record<string, unknown>;
      const currentStatus = data['orderStatus'];
      if (currentStatus === nextStatus) {
        // Idempotent: repeating the current status is a successful no-op.
        return {
          id: orderId,
          orderStatus: String(currentStatus),
          changed: false,
          customerId: '',
        };
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

      const patch: Record<string, unknown> = {
        orderStatus: nextStatus,
        updatedAt: FieldValue.serverTimestamp(),
      };

      // A successful COD delivery means the cash was collected. Only the COD
      // method is settled here, and only when it is not already PAID, so a
      // repeated completion can never duplicate the audit entry or rewrite an
      // existing decision/timestamp.
      if (nextStatus === 'COMPLETED' && data['paymentMethod'] === 'COD') {
        const currentPayment = storedPaymentStatus(data);
        if (currentPayment !== 'PAID') {
          patch['paymentStatus'] = 'PAID';
          patch['paymentDecision'] = {
            decision: 'PAID',
            decidedBy: admin.uid,
            decidedAt: FieldValue.serverTimestamp(),
          };
          patch['paymentAudit'] = [
            ...storedPaymentAudit(data),
            {
              from: currentPayment,
              to: 'PAID',
              actorUid: admin.uid,
              actorRole: 'admin',
            },
          ];
        }
      }

      tx.update(orderRef, patch);
      return {
        id: orderId,
        orderStatus: nextStatus,
        changed: true,
        customerId:
          typeof data['customerId'] === 'string' ? data['customerId'] : '',
      };
    });

    // Genuine fulfilment change only: the idempotent same-status branch above
    // returns before this point. Notification failures never fail the update.
    if (result.changed) {
      await notifyOrderStatusChanged(
        orderId,
        result.customerId,
        nextStatus
      );
    }

    res.json({ id: orderId, orderStatus: result.orderStatus });
  })
);

/**
 * POST /api/admin/orders/:id/payment — record a payment decision (admin only).
 *
 * Body: `{ "decision": "PAID" | "REJECTED" }`.
 *
 * - GCash: the order must be VERIFYING with submitted details **and** an
 *   uploaded payment proof before PAID is accepted. Repeating the recorded
 *   decision is an idempotent no-op; a confirmed (PAID) payment can never be
 *   overwritten, and REJECTED can only become PAID after the customer
 *   resubmits proof/details.
 * - COD: only `PAID` is accepted. A COD order is normally settled
 *   automatically when it reaches `COMPLETED`; this endpoint remains the
 *   idempotent explicit confirmation for an already-completed order.
 *
 * Recording a decision never changes `orderStatus`.
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
    const result = await decideOrderPayment(admin, orderId, decision);
    res.json(result);
  })
);

/**
 * POST /api/admin/orders/:id/payment-proof — alias of the payment decision
 * endpoint, provided so clients can name the action they are reviewing.
 */
adminOrdersRouter.post(
  '/orders/:id/payment-proof',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid order id is required.');
    }

    const decision = validatePaymentDecision(req.body);
    const admin = getAuth(req);
    const result = await decideOrderPayment(admin, orderId, decision);
    res.json(result);
  })
);

/**
 * POST /api/admin/orders/:id/cod-payment — confirm COD cash collection.
 *
 * Explicit, authorized action that marks a COD order's independent
 * `paymentStatus` as PAID. An optional `{ "decision": "PAID" }` body is also
 * accepted; REJECTED is not meaningful for COD. Idempotent and never changes
 * `orderStatus`.
 */
adminOrdersRouter.post(
  '/orders/:id/cod-payment',
  ...adminGuard,
  asyncHandler(async (req, res) => {
    const orderId = (req.params['id'] ?? '').trim();
    if (!orderId || orderId.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid order id is required.');
    }
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
      const raw = (req.body as Record<string, unknown>)['decision'];
      if (raw !== undefined && raw !== 'PAID') {
        throw new ApiError(
          409,
          'invalid_payment_method',
          'Cash-on-delivery payments can only be marked as collected (PAID).'
        );
      }
    }

    const admin = getAuth(req);
    const result = await confirmCodPayment(admin, orderId);
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
