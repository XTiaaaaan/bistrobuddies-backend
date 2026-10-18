import { FieldValue } from 'firebase-admin/firestore';
import { notFound } from '../errors';
import { requireFirebase } from '../firebase/admin';
import { timestampMs, toIso } from '../lib/serialize';
import {
  ContactMessageInput,
  ContactMessageStatus,
  ContactReplySenderRole,
} from '../lib/validation';
import { logger } from '../logger';

export interface ContactMessageConfirmation {
  id: string;
  status: string;
}

/** Initial workflow status for a freshly submitted contact message. */
export const CONTACT_MESSAGE_INITIAL_STATUS = 'NEW';

/**
 * Sender roles stored on a reply. `CUSTOMER` is reserved for a future
 * customer-reply flow — only `ADMIN` is ever written today.
 */
export const CONTACT_REPLY_SENDER_ADMIN: ContactReplySenderRole = 'ADMIN';
export const CONTACT_REPLY_SENDER_CUSTOMER: ContactReplySenderRole = 'CUSTOMER';

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

/** A reply stored on a contact-message document, as exposed by the API. */
export interface ContactMessageReplyResponse {
  id: string;
  senderRole: ContactReplySenderRole;
  reply: string;
  /** ISO-8601 string from the server serializer, or null when missing. */
  createdAt: string | null;
}

/**
 * Maps a single stored reply to its API payload. Malformed entries (wrong
 * shape or missing id/senderRole/reply) are dropped rather than guessed at —
 * the writer is the backend itself, so anything else is corrupt data.
 * Only the reply text, server-assigned role and server timestamp are
 * exposed; no identity fields ever ride along on a reply.
 */
export function serializeContactMessageReply(
  raw: unknown
): ContactMessageReplyResponse | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  const senderRole = record['senderRole'];
  const reply = typeof record['reply'] === 'string' ? record['reply'] : '';
  if (
    !id ||
    !reply ||
    (senderRole !== CONTACT_REPLY_SENDER_ADMIN &&
      senderRole !== CONTACT_REPLY_SENDER_CUSTOMER)
  ) {
    return null;
  }
  return {
    id,
    senderRole: senderRole as ContactReplySenderRole,
    reply,
    createdAt: toIso(record['createdAt']),
  };
}

/** Serializes a stored `replies` array, oldest first. */
export function serializeContactMessageReplies(
  raw: unknown
): ContactMessageReplyResponse[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => serializeContactMessageReply(entry))
    .filter((entry): entry is ContactMessageReplyResponse => entry !== null)
    .sort((a, b) => replyCreatedAtMs(a) - replyCreatedAtMs(b));
}

function replyCreatedAtMs(reply: ContactMessageReplyResponse): number {
  if (reply.createdAt === null) {
    return Number.POSITIVE_INFINITY;
  }
  const millis = Date.parse(reply.createdAt);
  return Number.isNaN(millis) ? Number.POSITIVE_INFINITY : millis;
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
  replies: ContactMessageReplyResponse[];
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
    replies: serializeContactMessageReplies(data['replies']),
  };
}

/** Message payload returned to the signed-in customer who owns it. */
export interface CustomerContactMessageResponse {
  id: string;
  subject: string;
  message: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  replies: ContactMessageReplyResponse[];
}

/**
 * Maps a stored contact message to the customer "My Messages" payload.
 *
 * Only the fields that screen renders are exposed — the sender's `name`,
 * `email` and the internal `userId` never leave the server, so the endpoint
 * cannot leak identity data the customer did not ask for.
 */
export function serializeCustomerContactMessage(
  messageId: string,
  data: Record<string, unknown>
): CustomerContactMessageResponse {
  return {
    id: messageId,
    subject: typeof data['subject'] === 'string' ? data['subject'] : '',
    message: typeof data['message'] === 'string' ? data['message'] : '',
    status:
      typeof data['status'] === 'string'
        ? data['status']
        : CONTACT_MESSAGE_INITIAL_STATUS,
    createdAt: toIso(data['createdAt']),
    updatedAt: toIso(data['updatedAt']),
    replies: serializeContactMessageReplies(data['replies']),
  };
}

/**
 * Lists the signed-in customer's own contact messages, newest first.
 *
 * The Firestore query is scoped to `userId == <verified uid>` so the database
 * itself can only return the caller's documents — an id supplied by the client
 * is never consulted. Sorting happens in memory (matching `listProducts` and
 * `listContactMessages`) which also avoids requiring a composite index and
 * keeps documents missing a `createdAt` from being silently dropped.
 */
export async function listCustomerContactMessages(
  userId: string
): Promise<CustomerContactMessageResponse[]> {
  const { db } = requireFirebase();
  const snapshot = await db
    .collection(CONTACT_MESSAGES_COLLECTION)
    .where('userId', '==', userId)
    .get();

  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      data: (doc.data() ?? {}) as Record<string, unknown>,
    }))
    .sort(
      (a, b) =>
        (timestampMs(b.data['createdAt']) ?? Number.NEGATIVE_INFINITY) -
        (timestampMs(a.data['createdAt']) ?? Number.NEGATIVE_INFINITY)
    )
    .map((row) => serializeCustomerContactMessage(row.id, row.data));
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

/** Result of POST /api/admin/contact-messages/:id/replies. */
export interface ContactMessageReplyResult {
  id: string;
  /** Workflow status of the message after the reply was stored. */
  status: ContactMessageStatus | string;
  reply: ContactMessageReplyResponse;
}

/**
 * Appends an administrator's reply to a customer contact message (admin
 * only — callers must already have passed requireAuth + requireAdmin).
 *
 * - The sender role (`ADMIN`) and the reply timestamp are generated
 *   server-side; nothing from the request body decides who sent the reply
 *   or when it was sent.
 * - The reply is appended inside the same `update()` that refreshes
 *   `updatedAt` (and may bump `status`), so a failed write leaves the
 *   message untouched and the client never sees a partial success.
 * - Firestore rejects server-timestamp transforms inside array elements, so
 *   the reply's `createdAt` is the server clock read at write time — a value
 *   no client ever supplies.
 * - Replying proves the message was handled: `NEW` becomes `READ`. The
 *   status is never auto-advanced to `RESOLVED` — that stays an explicit
 *   admin decision via the status endpoint.
 * - A missing document is reported as 404 so reply ids cannot be probed for
 *   existence differences.
 */
export async function addContactMessageReply(
  messageId: string,
  replyText: string
): Promise<ContactMessageReplyResult> {
  const { db } = requireFirebase();

  const messageRef = db.doc(`${CONTACT_MESSAGES_COLLECTION}/${messageId}`);
  const snapshot = await messageRef.get();
  if (!snapshot.exists) {
    throw notFound(
      'contact_message_not_found',
      'This message no longer exists.'
    );
  }

  const stored = (snapshot.data() ?? {}) as Record<string, unknown>;
  // The reply id is generated with Firestore's allocator without writing;
  // the role and timestamp are decided here, never by the client.
  const replyId = db.collection(CONTACT_MESSAGES_COLLECTION).doc().id;
  const createdAt = new Date();
  const reply: Record<string, unknown> = {
    id: replyId,
    senderRole: CONTACT_REPLY_SENDER_ADMIN,
    reply: replyText,
    createdAt,
  };

  const currentStatus =
    typeof stored['status'] === 'string'
      ? stored['status']
      : CONTACT_MESSAGE_INITIAL_STATUS;
  const nextStatus: ContactMessageStatus | string =
    currentStatus === CONTACT_MESSAGE_INITIAL_STATUS
      ? 'READ'
      : currentStatus;

  const patch: Record<string, unknown> = {
    replies: FieldValue.arrayUnion(reply),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (nextStatus !== currentStatus) {
    patch['status'] = nextStatus;
  }

  await messageRef.update(patch);

  logger.info('Contact message reply stored.', {
    id: messageId,
    replyId,
  });

  return {
    id: messageId,
    status: nextStatus,
    reply: {
      id: replyId,
      senderRole: CONTACT_REPLY_SENDER_ADMIN,
      reply: replyText,
      createdAt: createdAt.toISOString(),
    },
  };
}
