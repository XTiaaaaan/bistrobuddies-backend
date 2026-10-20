import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import { config } from '../config';
import { requireFirebase } from '../firebase/admin';
import {
  orderStatusLabel,
  type DevicePlatform,
  type DeviceTokenInput,
  type OrderStatus,
  type PaymentDecision,
} from '../lib/validation';
import { logger } from '../logger';

const DEVICE_TOKENS = 'deviceTokens';
const NOTIFICATION_EVENTS = 'notifications';
const USERS = 'users';
const FCM_MAX_TOKENS_PER_REQUEST = 500;

export type NotificationEventType =
  | 'ORDER_STATUS'
  | 'PAYMENT_DECISION'
  | 'ADMIN_NEW_ORDER'
  | 'ADMIN_PAYMENT_PROOF';

interface NotificationPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

type NotificationEventStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

interface SendResult {
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}

interface Runtime {
  db: Firestore;
  messaging: Messaging;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deviceTokenDocId(token: string): string {
  return hash(token);
}

function eventDocId(eventKey: string): string {
  return hash(eventKey);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function notificationRuntime(): Runtime | null {
  if (!config.notificationsEnabled) {
    return null;
  }
  const runtime = requireFirebase();
  // Test doubles and older runtimes may not expose Messaging. Notifications
  // are best-effort: skipping them must never fail the business operation.
  if (!runtime.messaging) {
    logger.warn('Firebase Cloud Messaging is unavailable; skipping notification.', {
      reason: 'messaging_unavailable',
    });
    return null;
  }
  return { db: runtime.db, messaging: runtime.messaging };
}

/**
 * Registers or refreshes an FCM device token for the authenticated user.
 *
 * The token is stored exactly once per device (document id is a SHA-256 hash
 * of the token). Re-registering the same token from another account moves the
 * token to that account, which is the expected behaviour when a shared device
 * switches users. A user may register any number of device tokens.
 */
export async function registerDeviceToken(
  user: { uid: string },
  input: DeviceTokenInput
): Promise<{ id: string; platform: DevicePlatform }> {
  const { db } = requireFirebase();
  const id = deviceTokenDocId(input.token);
  const ref = db.doc(`${DEVICE_TOKENS}/${id}`);
  const existing = await ref.get();
  const exists = existing.exists;

  await ref.set(
    {
      uid: user.uid,
      token: input.token,
      platform: input.platform,
      ...(exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { id, platform: input.platform };
}

/**
 * Removes a device token owned by the authenticated user.
 *
 * Removing a token that belongs to another user is a safe no-op: the caller
 * cannot revoke someone else's device, and the response does not reveal which
 * user owns the token.
 */
export async function removeDeviceToken(
  user: { uid: string },
  token: string
): Promise<{ removed: boolean }> {
  const { db } = requireFirebase();
  const ref = db.doc(`${DEVICE_TOKENS}/${deviceTokenDocId(token)}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    return { removed: false };
  }
  const data = asRecord(snapshot.data());
  if (data?.['uid'] !== user.uid) {
    return { removed: false };
  }
  await ref.delete();
  return { removed: true };
}

async function tokensForUser(db: Firestore, uid: string): Promise<string[]> {
  const snapshot = await db
    .collection(DEVICE_TOKENS)
    .where('uid', '==', uid)
    .get();
  const tokens: string[] = [];
  for (const doc of snapshot.docs) {
    const data = asRecord(doc.data());
    const token = data?.['token'];
    if (typeof token === 'string' && token !== '' && !tokens.includes(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

async function adminUids(db: Firestore): Promise<string[]> {
  const snapshot = await db
    .collection(USERS)
    .where('role', '==', 'admin')
    .get();
  const uids: string[] = [];
  for (const doc of snapshot.docs) {
    const data = asRecord(doc.data());
    const uid =
      typeof data?.['uid'] === 'string' && data['uid'] !== ''
        ? data['uid']
        : doc.id;
    if (uid && !uids.includes(uid)) {
      uids.push(uid);
    }
  }
  return uids;
}

async function claimEvent(
  db: Firestore,
  eventKey: string,
  uid: string,
  type: NotificationEventType,
  orderId: string
): Promise<boolean> {
  const ref = db.doc(`${NOTIFICATION_EVENTS}/${eventDocId(eventKey)}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        return false;
      }
      tx.set(ref, {
        eventKey,
        uid,
        type,
        orderId,
        status: 'PENDING' as NotificationEventStatus,
        createdAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
  } catch (error) {
    // Failing closed prevents duplicate pushes when the idempotency store is
    // unavailable, while still letting the business operation succeed.
    logger.warn('Notification event could not be claimed; skipping send.', {
      type,
      orderId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

async function markEvent(
  db: Firestore,
  eventKey: string,
  patch: {
    status: NotificationEventStatus;
    successCount?: number;
    failureCount?: number;
    reason?: string;
  }
): Promise<void> {
  try {
    await db.doc(`${NOTIFICATION_EVENTS}/${eventDocId(eventKey)}`).update({
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    logger.warn('Notification event status could not be recorded.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

function isInvalidTokenError(code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-argument'
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function sendToTokens(
  messaging: Messaging,
  tokens: string[],
  payload: NotificationPayload
): Promise<SendResult> {
  let successCount = 0;
  let failureCount = 0;
  const invalidTokens: string[] = [];

  for (const batch of chunk(tokens, FCM_MAX_TOKENS_PER_REQUEST)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: { priority: 'high' },
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
    response.responses.forEach((result, index) => {
      if (!result.success && isInvalidTokenError(result.error?.code)) {
        const token = batch[index];
        if (token && !invalidTokens.includes(token)) {
          invalidTokens.push(token);
        }
      }
    });
  }

  return { successCount, failureCount, invalidTokens };
}

async function deleteInvalidTokens(
  db: Firestore,
  uid: string,
  tokens: string[]
): Promise<void> {
  for (const token of tokens) {
    try {
      const ref = db.doc(`${DEVICE_TOKENS}/${deviceTokenDocId(token)}`);
      const snapshot = await ref.get();
      const data = asRecord(snapshot.data());
      // Re-check ownership so a token re-registered by another account is
      // never deleted based on a stale FCM failure response.
      if (
        snapshot.exists &&
        data?.['uid'] === uid &&
        data?.['token'] === token
      ) {
        await ref.delete();
      }
    } catch (error) {
      logger.warn('Invalid device token could not be removed.', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

async function sendToRecipients(
  runtime: Runtime,
  eventKey: string,
  type: NotificationEventType,
  orderId: string,
  recipients: string[],
  payload: NotificationPayload
): Promise<void> {
  const unique = [...new Set(recipients.filter((uid) => uid !== ''))];

  for (const uid of unique) {
    const recipientEventKey = `${eventKey}:${uid}`;
    if (
      !(await claimEvent(
        runtime.db,
        recipientEventKey,
        uid,
        type,
        orderId
      ))
    ) {
      continue;
    }

    try {
      const tokens = await tokensForUser(runtime.db, uid);
      if (tokens.length === 0) {
        await markEvent(runtime.db, recipientEventKey, {
          status: 'SKIPPED',
          reason: 'no_tokens',
          successCount: 0,
          failureCount: 0,
        });
        continue;
      }

      const result = await sendToTokens(runtime.messaging, tokens, payload);
      if (result.invalidTokens.length > 0) {
        await deleteInvalidTokens(runtime.db, uid, result.invalidTokens);
      }

      await markEvent(runtime.db, recipientEventKey, {
        status: result.successCount > 0 ? 'SENT' : 'FAILED',
        successCount: result.successCount,
        failureCount: result.failureCount,
        ...(result.successCount === 0 && result.failureCount === 0
          ? { reason: 'no_delivery' }
          : {}),
      });
    } catch (error) {
      await markEvent(runtime.db, recipientEventKey, {
        status: 'FAILED',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      logger.warn('Push notification delivery failed.', {
        type,
        orderId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

async function notifyRecipients(
  eventKey: string,
  type: NotificationEventType,
  orderId: string,
  recipients: string[],
  payload: NotificationPayload
): Promise<void> {
  try {
    const runtime = notificationRuntime();
    if (!runtime || recipients.length === 0) {
      return;
    }
    await sendToRecipients(
      runtime,
      eventKey,
      type,
      orderId,
      recipients,
      payload
    );
  } catch (error) {
    // Notifications are best-effort and must never break the caller.
    logger.warn('Notification dispatch failed.', {
      type,
      orderId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function notifyAdmins(
  eventKey: string,
  type: NotificationEventType,
  orderId: string,
  payload: NotificationPayload
): Promise<void> {
  try {
    const runtime = notificationRuntime();
    if (!runtime) {
      return;
    }
    const recipients = await adminUids(runtime.db);
    if (recipients.length === 0) {
      return;
    }
    await sendToRecipients(
      runtime,
      eventKey,
      type,
      orderId,
      recipients,
      payload
    );
  } catch (error) {
    logger.warn('Admin notification dispatch failed.', {
      type,
      orderId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

const NOTIFIABLE_ORDER_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'PREPARING',
  'READY',
  'OUT_FOR_DELIVERY',
  'COMPLETED',
];

function orderStatusMessage(
  orderId: string,
  status: OrderStatus
): NotificationPayload {
  switch (status) {
    case 'CONFIRMED':
      return {
        title: 'Order confirmed',
        body: `Your order ${orderId} has been confirmed.`,
        data: {
          type: 'ORDER_STATUS',
          orderId,
          orderStatus: status,
          orderStatusLabel: orderStatusLabel(status),
        },
      };
    case 'PREPARING':
      return {
        title: 'Preparing your order',
        body: `We are preparing your order ${orderId}.`,
        data: {
          type: 'ORDER_STATUS',
          orderId,
          orderStatus: status,
          orderStatusLabel: orderStatusLabel(status),
        },
      };
    case 'READY':
      return {
        title: 'Order ready',
        body: `Your order ${orderId} is ready.`,
        data: {
          type: 'ORDER_STATUS',
          orderId,
          orderStatus: status,
          orderStatusLabel: orderStatusLabel(status),
        },
      };
    case 'OUT_FOR_DELIVERY':
      return {
        title: 'On the Way',
        body: 'Your coffee order is on the way!',
        data: {
          type: 'ORDER_STATUS',
          orderId,
          orderStatus: status,
          orderStatusLabel: orderStatusLabel(status),
        },
      };
    case 'COMPLETED':
      return {
        title: 'Order completed',
        body: `Your order ${orderId} is complete. Thank you!`,
        data: {
          type: 'ORDER_STATUS',
          orderId,
          orderStatus: status,
          orderStatusLabel: orderStatusLabel(status),
        },
      };
    default:
      return {
        title: 'Order updated',
        body: `Your order ${orderId} was updated.`,
        data: {
          type: 'ORDER_STATUS',
          orderId,
          orderStatus: status,
          orderStatusLabel: orderStatusLabel(status),
        },
      };
  }
}

/**
 * Notifies the order's customer of a genuine fulfilment state change.
 * Cancellation/other statuses are deliberately not announced here.
 */
export async function notifyOrderStatusChanged(
  orderId: string,
  customerId: string,
  status: string
): Promise<void> {
  if (
    customerId === '' ||
    !NOTIFIABLE_ORDER_STATUSES.includes(status as OrderStatus)
  ) {
    return;
  }
  await notifyRecipients(
    `order-status:${orderId}:${status}`,
    'ORDER_STATUS',
    orderId,
    [customerId],
    orderStatusMessage(orderId, status as OrderStatus)
  );
}

/** Notifies every administrator with a registered device about a new order. */
export async function notifyAdminsNewOrder(orderId: string): Promise<void> {
  await notifyAdmins(
    `admin-new-order:${orderId}`,
    'ADMIN_NEW_ORDER',
    orderId,
    {
      title: 'New order',
      body: `New order ${orderId} was placed.`,
      data: { type: 'ADMIN_NEW_ORDER', orderId },
    }
  );
}

/**
 * Notifies every administrator that GCash proof is waiting for review.
 * The proof id makes resubmissions (new Cloudinary asset) distinct events,
 * while retries of the same submission stay idempotent.
 */
export async function notifyAdminsPaymentProofSubmitted(
  orderId: string,
  proofId: string
): Promise<void> {
  await notifyAdmins(
    `admin-payment-proof:${orderId}:${proofId}`,
    'ADMIN_PAYMENT_PROOF',
    orderId,
    {
      title: 'Payment proof submitted',
      body: `Payment proof for order ${orderId} needs review.`,
      data: { type: 'ADMIN_PAYMENT_PROOF', orderId },
    }
  );
}

/**
 * Notifies the customer of an admin GCash payment decision. `revision` is the
 * payment audit length at the time of the decision, so a rejection followed by
 * a resubmission and a later decision is announced again.
 */
export async function notifyPaymentDecision(
  orderId: string,
  customerId: string,
  decision: PaymentDecision,
  revision: number
): Promise<void> {
  if (customerId === '') {
    return;
  }
  const approved = decision === 'PAID';
  await notifyRecipients(
    `payment-decision:${orderId}:${decision}:${revision}`,
    'PAYMENT_DECISION',
    orderId,
    [customerId],
    {
      title: approved ? 'Payment approved' : 'Payment rejected',
      body: approved
        ? `Your GCash payment for order ${orderId} was approved.`
        : `Your GCash payment for order ${orderId} was rejected. Please review your proof and resubmit.`,
      data: {
        type: 'PAYMENT_DECISION',
        orderId,
        paymentStatus: decision,
      },
    }
  );
}
