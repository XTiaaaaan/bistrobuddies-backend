import { Router } from 'express';
import { validateContactMessageRequest } from '../lib/validation';
import { getAuth, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';
import { rateLimit } from '../middleware/rate-limit';
import {
  createContactMessage,
  listCustomerContactMessages,
} from '../services/contact-messages.service';

export const contactMessagesRouter = Router();

/**
 * POST /api/contact-messages — customer "Contact Us" form submission.
 *
 * Requires a valid Firebase ID token like the app's other customer-facing
 * write endpoints (`POST /api/orders`, `POST /api/profile/photo`); the
 * sender's `userId` is derived from the verified token, never from the
 * body. Abuse protection: 10 requests/min/IP plus server-side validation
 * (trimmed, length-capped fields and a valid email format).
 *
 * Customers have exactly one read path — their own messages via
 * `GET /api/contact-messages/mine` below. There is deliberately **no**
 * per-message GET and no PATCH/DELETE endpoint, so a customer can never
 * read, edit or delete another customer's message through this API.
 * Administrators list messages and update their workflow status through the
 * separate, admin-guarded `/api/admin/contact-messages` routes (see
 * `routes/admin-contact-messages.ts`). Messages are stored in the
 * `contactMessages` Firestore collection (Admin SDK only; clients are
 * denied by `firestore.rules`).
 *
 * Email notifications are not configured in this repository — Firestore
 * storage is the submission mechanism (see docs/API_CONTRACT.md).
 */
contactMessagesRouter.post(
  '/contact-messages',
  rateLimit({ name: 'contact-messages', limit: 10, windowMs: 60_000 }),
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    const input = validateContactMessageRequest(req.body);
    const confirmation = await createContactMessage(user, input);
    res.status(201).json(confirmation);
  })
);

/**
 * GET /api/contact-messages/mine — list the signed-in customer's own
 * "Contact Us" messages, newest first (My Messages screen).
 *
 * Ownership is enforced server-side: the Firestore query is scoped to the
 * `userId` taken from the verified Firebase ID token, so a client can never
 * request another customer's messages (no user id is accepted from the
 * request). The response exposes only the subject, message, workflow status
 * and timestamps — never the sender identity or the internal `userId`.
 */
contactMessagesRouter.get(
  '/contact-messages/mine',
  rateLimit({ name: 'contact-messages-mine', limit: 60, windowMs: 60_000 }),
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuth(req);
    res.json({ messages: await listCustomerContactMessages(user.uid) });
  })
);
