import { FieldValue } from 'firebase-admin/firestore';
import { notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { timestampMs, toIso } from '../lib/serialize';
import { ContactMessageInput, ContactMessageStatus } from '../lib/validation';
import { logger } from '../logger';

export interface ContactMessageConfirmation {
  id: string;
  status: string;
}

/** Initial workflow status for a freshly submitted contact message. */
export const CONTACT_MESSAGE_INITIAL_STATUS = 'NEW';

/** Firestore collection that stores customer Contact Us submissions. */
export const CONTACT_MESSAGES_COLLECTION = 'contactMessages';

/**
 * Stores a Contact Us submission in Firestore.
 *
 * - The sender identity (`userId`) always comes from the verified Firebase
 *   ID token, never from the request body.
 * - The document id, `status` and timestamps are generated server-side; any
 *   client-supplied values for those fields are ignored by request
 *   validation. Clients have no write access to this collection (see
 *   `firestore.rules`) — only the Admin SDK writes here.
 * - Resolves only after Firestore confirms the write. A rejected write
 *   propagates as an error so the client never receives a false success.
 *
 * Email notification to `bistrobuddies@gmail.com` is intentionally not
 * implemented: no email provider is configured in this repository. Firestore
 * storage is the reliable submission mechanism; wiring a real email provider
 * (with its own env configuration and failure handling that does not undo a
 * successful store) is a separate setup step.
 */
export async function createContactMessage(
  user: { uid: string },
  input: ContactMessageInput
): Promise<ContactMessageConfirmation> {
  const { db } = requireFirebase();

  const messageRef = db.collection(CONTACT_MESSAGES_COLLECTION).doc();
  await messageRef.set({
    id: messageRef.id,
    name: input.name,
    email: input.email,
    subject: input.subject,
    message: input.message,
    userId: user.uid,
    status: CONTACT_MESSAGE_INITIAL_STATUS,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('Contact message stored.', {
    id: messageRef.id,
    userId: user.uid,
  });

  return {
    id: messageRef.id,
    status: CONTACT_MESSAGE_INITIAL_STATUS,
  };
}

/** Message payload returned by the admin list endpoint. */
export interface ContactMessageResponse {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ContactMessagePage {
  messages: ContactMessageResponse[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Maps a stored contact message document to its admin API payload. Only the
 * customer's submission fields plus the workflow status and timestamps are
 * exposed — `userId` (and anything else stored on the document) stays on the
 * server, so the endpoint cannot leak unrelated identity data.
 */
export function serializeContactMessage(
  messageId: string,
  data: Record<string, unknown>
): ContactMessageResponse {
  return {
    id: messageId,
    name: typeof data['name'] === 'string' ? data['name'] : '',
    email: typeof data['email'] === 'string' ? data['email'] : '',
    subject: typeof data['subject'] === 'string' ? data['subject'] : '',
    message: typeof data['message'] === 'string' ? data['message'] : '',
    status:
      typeof data['status'] === 'string'
        ? data['status']
        : CONTACT_MESSAGE_INITIAL_STATUS,
    createdAt: toIso(data['createdAt']),
    updatedAt: toIso(data['updatedAt']),
  };
}

/**
 * Lists stored contact messages for administrators, newest first.
 *
 * Filtering (`status`) and pagination are applied in memory after reading the
 * `contactMessages` collection, matching the existing `listProducts`
 * convention. That also means no Firestore composite index is required (a
 * `where('status').orderBy('createdAt')` query would need one that is not
 * deployed), and documents missing an `createdAt` value cannot be silently
 * dropped by a server-side `orderBy`. Only callers that already passed
 * requireAuth + requireAdmin reach this function.
 */
export async function listContactMessages(options: {
  page: number;
  pageSize: number;
  status?: ContactMessageStatus;
}): Promise<ContactMessagePage> {
  const { db } = requireFirebase();
  const snapshot = await db.collection(CONTACT_MESSAGES_COLLECTION).get();

  const rows = snapshot.docs.map((doc) => ({
    id: doc.id,
    data: (doc.data() ?? {}) as Record<string, unknown>,
  }));

  rows.sort(
    (a, b) =>
      (timestampMs(b.data['createdAt']) ?? Number.NEGATIVE_INFINITY) -
      (timestampMs(a.data['createdAt']) ?? Number.NEGATIVE_INFINITY)
  );

  const filtered =
    options.status === undefined
      ? rows
      : rows.filter((row) => row.data['status'] === options.status);

  const total = filtered.length;
  const totalPages = Math.ceil(total / options.pageSize);
  const start = (options.page - 1) * options.pageSize;

  return {
    messages: filtered
      .slice(start, start + options.pageSize)
      .map((row) => serializeContactMessage(row.id, row.data)),
    page: options.page,
    pageSize: options.pageSize,
    total,
    totalPages,
  };
}

/**
 * Updates a contact message's workflow status (admin only).
 *
 * Only `status` and `updatedAt` are written — the customer's original
 * submission (name, email, subject, message, userId) and `createdAt` can
 * never be changed through this endpoint. A missing document is reported as
 * 404 so message ids cannot be probed for existence differences. Callers must
 * already have passed requireAuth + requireAdmin; the status value itself is
 * validated against READ/RESOLVED by request validation before this runs.
 */
export async function updateContactMessageStatus(
  messageId: string,
  status: ContactMessageStatus
): Promise<{ id: string; status: ContactMessageStatus }> {
  const { db } = requireFirebase();

  const messageRef = db.doc(`${CONTACT_MESSAGES_COLLECTION}/${messageId}`);
  const snapshot = await messageRef.get();
  if (!snapshot.exists) {
    throw notFound(
      'contact_message_not_found',
      'This message no longer exists.'
    );
  }

  await messageRef.update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info('Contact message status updated.', { id: messageId, status });

  return { id: messageId, status };
}
