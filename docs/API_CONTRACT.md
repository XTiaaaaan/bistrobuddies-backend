# BistroBuddies API Contract

Contract for the mobile customer app (`../bistrobuddies-mobile`) and the admin
site (`../bistrobuddies-admin`). Every path works with and without the `/api`
prefix (the router is mounted at both `/api` and `/` for serverless hosts);
**use the `/api/...` paths shown here**.

> Companions: `.env.example` (environment variables), `README.md` (setup),
> `PROJECT_CONTEXT.md` (read-only audit of the original repository).

---

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Base URL | dev `http://localhost:3001/api` (`environment.apiBaseUrl`) |
| Auth | `Authorization: Bearer <Firebase ID token>` — token verified server-side; identity **never** taken from the request body |
| Admin | Server reads `users/{uid}.role == 'admin'` from Firestore on every `/admin/*` request |
| Errors | `{ "error": { "code": "…", "message": "…", "details?": … } }` with status 400/401/403/404/409/413/415/422/429/500/503 |
| Currency | **PHP only.** Every price/amount field is returned with `currency: "PHP"` |
| Prices | Clients **never** send prices. Totals are computed server-side from Firestore product records |

Rate limits (per IP, fixed window): `POST /api/orders` 20/min;
`POST /api/orders/:id/cancel` 20/min;
`POST /api/orders/:id/gcash-details` 20/min;
`POST /api/contact-messages` 10/min; `GET /api/contact-messages/mine` 60/min;
`GET /api/products*` 120/min;
`/api/admin/*` 60/min; `POST /api/admin/uploads`
and `POST /api/profile/photo` 30/min. Rate-limited responses are `429` with a
`Retry-After` header.

---

## 2. Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status, service, firebaseConfigured, timestamp }` |
| GET | `/api/products` | — (public) | Catalog list, newest first |
| GET | `/api/products/:id` | — (public) | Single product or `404 product_not_found` |
| POST | `/api/orders` | Bearer (any signed-in user) | Creates an order; prices computed server-side |
| GET | `/api/orders/:id` | Bearer (owner or admin) | Others get `404 order_not_found` (no id probing) |
| POST | `/api/orders/:id/cancel` | Bearer (order owner) | Cancel a `PENDING` order (sets `orderStatus: CANCELLED`, never deletes) → full order (§4) |
| POST | `/api/orders/:id/gcash-details` | Bearer (order owner) | Submit GCash details for manual verification → `{ id, paymentStatus }` (§4) |
| POST | `/api/admin/orders/:id/payment` | Bearer (admin) | Confirm/reject a GCash payment → `{ id, paymentStatus }` (§4) |
| POST | `/api/admin/orders/:id/refund` | Bearer (admin) | Record a manual refund on a cancelled paid order → full order incl. `refund` (§4) |
| POST | `/api/contact-messages` | Bearer (any signed-in user) | Stores a "Contact Us" submission → `201 { id, status }` (§4) |
| GET | `/api/contact-messages/mine` | Bearer (any signed-in user) | The caller's own messages, newest first → `{ messages: [...] }` (§4) |
| POST | `/api/admin/products` | Bearer (admin) | Create product → `201 { id }` |
| PATCH | `/api/admin/products/:id` | Bearer (admin) | Partial update → `{ id }` |
| DELETE | `/api/admin/products/:id` | Bearer (admin) | Delete → `{ id }` |
| POST | `/api/admin/uploads` | Bearer (admin) | Store a product image in Cloudinary → `201 { imageUrl, publicId, … }` (§6) |
| POST | `/api/profile/photo` | Bearer (any signed-in user) | Store the caller's profile picture in Cloudinary → `201 { imageUrl, publicId, … }` (§6) |
| POST | `/api/admin/orders/:id/status` | Bearer (admin) | Status transition → `{ id, orderStatus }` |
| GET | `/api/admin/contact-messages` | Bearer (admin) | Customer "Contact Us" messages, newest first; `?status`, `?page`, `?pageSize` (§4) |
| PATCH | `/api/admin/contact-messages/:id/status` | Bearer (admin) | `{ status: "READ" \| "RESOLVED" }` → `{ id, status }` (§4) |
| POST | `/api/admin/contact-messages/:id/replies` | Bearer (admin) | `{ reply }` → `201 { id, status, reply }` — appends an admin reply (§4) |

CORS allows `GET, POST, PATCH, DELETE, OPTIONS` from `ALLOWED_ORIGINS`.

---

## 3. Product schema (standardized)

Canonical fields — returned by `GET /api/products[/:id]`:

```jsonc
{
  "id": "p1",
  "name": "House Latte",
  "category": "Hot",
  "description": "Creamy latte",
  "imageUrl": "assets/products/latte.png",
  "price": 119,              // canonical PHP list price, derived from the size tiers
  "currency": "PHP",         // always "PHP" — clients format it as ₱
  "available": true,
  "createdAt": "2026-10-09T12:00:00.000Z",  // null when never set
  "updatedAt": "2026-10-09T12:00:00.000Z",
  // Canonical size prices — what each size actually costs:
  "smallPrice": 99,
  "mediumPrice": 119,
  "largePrice": 139,
  "sugarOptions": ["No Sugar", "Less Sugar", "Regular", "Extra Sugar"],
  "cloudinaryPublicId": ""   // legacy, unused
}
```

### Write payloads (admin API)

**Size prices are canonical.** `smallPrice`, `mediumPrice` and `largePrice`
are the source of truth for what a customer pays per size; the legacy `price`
is still accepted for older clients, but it can never replace the three size
prices. Every price must be a finite PHP amount **greater than 0** with at
most two decimals (values are normalized to centavos, e.g. `99.999` → `100`,
`0.001` → `400`).

- **Create** (`POST`): `name`, `category`, `description`, `imageUrl`,
  `sugarOptions`, `available` required as before, **plus price input — either**
  the three size prices (recommended) **or** the legacy `price`.
  - three size prices supplied → stored exactly as sent (100/120/150 stay
    distinct even when a legacy `price` is present); canonical `price` is
    re-derived from the medium tier,
  - only `price` supplied → flat pricing: that amount is written to all three
    tiers so size-selector clients keep working.
- **Update** (`PATCH`): any subset of the same fields + `price`.
  - size tier(s) provided → those tiers are written and canonical `price` is
    re-derived (medium → small → large),
  - only `price` provided on a product that **already has size tiers** → the
    stored tiers are left untouched (a single legacy price can no longer
    flatten a tiered product) and `price` is re-derived from them,
  - only `price` provided on a legacy record with **no size tiers** → the
    tiers are materialized from that price so the mobile size selector keeps
    working,
  - `currency` is **never** accepted from clients (server always writes `PHP`).
- Legacy documents are normalized (`price` + `currency`, plus materialized
  tiers for flat records) the first time they are edited. **No migration is
  run and no stored product or historical order is rewritten by reads.**

### Migrating legacy products to the standard size prices

Older records that only carry a flat `price` are never rewritten by reads and
are never flattened by an admin save. To put a product on the standard coffee
prices, PATCH the three tiers explicitly:

```bash
curl -X PATCH http://localhost:3001/api/admin/products/<id> \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "smallPrice": 100, "mediumPrice": 120, "largePrice": 150 }'
```

The canonical `price` is then re-derived server-side (medium → `120`).
Existing orders are historical snapshots and are never touched.

### ₱ formatting (clients)

`currency` is an ISO code, not a symbol — format it in the UI:

```ts
formatPhp(amount: number): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency', currency: 'PHP',
  }).format(amount); // "₱1,119.00"
}
```

(Both apps already hard-code the `₱` prefix with `en-PH`; keep doing that or
switch to the snippet above.)

---

## 4. Orders

### POST /api/orders — request

```jsonc
{
  "items": [{ "productId": "p1", "size": "small", "sugar": "Regular", "quantity": 1 }],
  "customer":  { "name": "Juan dela Cruz", "phone": "09171234567" },
  "address":   { "recipientName": "…", "phone": "…", "address": "…", "city": "?", "postalCode": "?" },
  "customerComment": "…",
  "paymentMethod": "COD" | "GCASH"
}
```

- `COD` — cash on delivery (unchanged behaviour; never needs payment details).
- `GCASH` — manual GCash verification by an admin (this section below).
  There is no payment gateway, QR storage, webhook, or automatic
  processing — an admin confirms the payment by hand in the backend.
  Unknown values are rejected (`400 invalid_request`) and are
  never silently treated as COD.

- **No price fields are accepted** — send `productId`/`size`/`sugar`/`quantity` only.
- Limits: 1–50 items, quantity integer 1–99.

### Response — `201`

```json
{ "id": "…", "subtotal": 200, "deliveryFee": 0, "total": 200,
  "currency": "PHP", "orderStatus": "PENDING", "paymentStatus": "PENDING" }
```

### Server-side pricing rules

| Case | Result |
| --- | --- |
| Size price present on the product doc | used as `unitPrice` |
| No valid size price, canonical `price` present | `price` used as `unitPrice` |
| Neither valid | `422 invalid_product_price` |
| `available == false` | `409 product_unavailable` |
| Unknown `productId` | `404 product_not_found` |
| Sugar not in the product's `sugarOptions` | `422 invalid_sugar_option` |
| Invalid quantity (bypassing validation) | `400 invalid_quantity` |

`subtotal = Σ(item.unitPrice × quantity)`, `deliveryFee = DELIVERY_FEE`,
`total = subtotal + deliveryFee`, rounded to 2 dp.

### GET /api/orders/:id — response

Full stored order: `id`, `customerId`, `customerSnapshot`, `addressSnapshot`,
`items` (with purchase-time `unitPrice`/`subtotal` snapshots), `subtotal`,
`deliveryFee`, `total`, `currency`, `customerComment`, `paymentMethod`,
`paymentStatus`, `gcashDetails` (`null` when none submitted yet),
`refund` (`{ status, amount, requestedAt, completedAt }` refund facts — see
"Manual refunds"; `NOT_REFUNDED` unless a refund was recorded),
`orderStatus`, `createdAt`, `updatedAt`.
Historical orders are returned **exactly as stored** — prices are never
recomputed or rewritten, and orders without the newer GCash/refund fields come
back with `gcashDetails: null` and `refund: NOT_REFUNDED`.
Administrators additionally receive `paymentDecision` (latest admin decision
with `decidedBy`/`decidedAt`), `paymentAudit` (append-only status trail) and
`refundAudit` (append-only refund trail); these fields are omitted from
customer responses.

### Status graph (admin only)

`PENDING → CONFIRMED → PREPARING → READY → COMPLETED`; `CANCELLED` reachable
from every non-terminal state. Re-sending the current status is an
idempotent no-op; anything else → `400 invalid_status_transition`.

### Customer order cancellation

**POST /api/orders/:id/cancel** (order owner only, 20/min/IP, no request body).

A customer may cancel only while the order is still awaiting confirmation
(`orderStatus: PENDING`). The order document is **never deleted**: the server
sets `orderStatus` to `CANCELLED` and leaves the independent `paymentStatus`
(and any submitted `gcashDetails`) untouched. The updated order is returned in
the same shape as `GET /api/orders/:id`.

```jsonc
// response 200 — same shape as GET /api/orders/:id
{ "id": "…", "orderStatus": "CANCELLED", "paymentStatus": "PENDING", /* … */ }
```

- Cancelling an order that is already `CANCELLED` is an idempotent no-op that
  returns the order unchanged.
- Errors: `401 unauthorized` (no/bad token); `404 order_not_found` (missing
  order, or owned by someone else — administrators are not owners and cancel
  via `POST /api/admin/orders/:id/status` instead, so they also get `404` here);
  `409 order_not_cancellable` (order already `CONFIRMED`/`PREPARING`/`READY`/
  `COMPLETED`).
- Runs in a Firestore transaction, so a cancellation racing an admin
  confirmation cannot overwrite the confirmed state.

### Manual GCash verification (no gateway)

The GCash QR image lives in the mobile app assets (not in this backend).
The flow is: customer pays via their own GCash app → submits their GCash
account name + mobile number here for reference → an admin verifies the
payment out-of-band and records the decision here. The submitted name never
proves payment; only an admin decision marks an order `PAID`.

**Payment-status transitions** (`paymentStatus` is independent of the
fulfilment field `orderStatus`; confirming payment never completes an order):

| From | To | By | Notes |
| --- | --- | --- | --- |
| `PENDING` | `VERIFYING` | customer (`POST …/gcash-details`) | first submission |
| `VERIFYING` | `VERIFYING` | customer | safe resubmission; latest details win |
| `REJECTED` | `VERIFYING` | customer | resubmission after a rejection |
| `VERIFYING` | `PAID` | admin (`POST …/payment`) | confirmation |
| `VERIFYING` | `REJECTED` | admin | rejection |
| `PAID` | `PAID` | admin | idempotent no-op (writes nothing) |
| `REJECTED` | `REJECTED` | admin | idempotent no-op (writes nothing) |

Anything else is rejected: `PAID` can never be overwritten, `REJECTED` can
only become `PAID` after the customer resubmits (never directly), and an
admin cannot decide before details exist (`409 payment_details_required`).
A customer can never mark an order `PAID` — there is no customer-facing
endpoint that writes `PAID`.

**Customer — POST /api/orders/:id/gcash-details** (owner only, 20/min/IP):

```jsonc
// request — only these two fields are read; totals, statuses and any
// pin/otp/password fields are ignored. Never send account credentials.
{ "accountName": "Juan dela Cruz", "accountNumber": "09171234567" }
// response 200
{ "id": "…", "paymentStatus": "VERIFYING",
  "gcashDetails": { "accountName": "Juan dela Cruz", "accountNumber": "09171234567" } }
```

- `accountName`: trimmed, internal whitespace collapsed, 2–80 chars.
- `accountNumber`: Philippine mobile — `09XXXXXXXXX`, `639XXXXXXXXX` or
  `+639XXXXXXXXX` (spaces/hyphens/parens/dots ignored) — always stored and
  returned normalized to `09XXXXXXXXX`.
- Errors: `401 unauthorized` (no/bad token); `404 order_not_found`
  (missing order, or owned by someone else); `400 invalid_request` (bad
  name/number, per-field `details`); `409 invalid_payment_method`
  (non-GCash order, e.g. COD); `409 payment_already_confirmed` (already
  `PAID`).

**Admin — POST /api/admin/orders/:id/payment** (admin only, 60/min/IP):

```jsonc
// request — only PAID and REJECTED are accepted
{ "decision": "PAID" }
// response 200
{ "id": "…", "paymentStatus": "PAID" }
```

- The order must use `GCASH` and be `VERIFYING` with submitted details.
- The admin UID and decision timestamp are stored (`paymentDecision`) and an
  entry is appended to `paymentAudit`; `orderStatus` is never changed here.
- All writes run in a Firestore transaction, so repeated or concurrent
  identical decisions stay consistent (the repeat is a no-op).
- Errors: `401 unauthorized`; `403 forbidden` (non-admin);
  `404 order_not_found`; `400 invalid_request` (bad `decision`);
  `409 invalid_payment_method` (non-GCash order);
  `409 payment_details_required` (still `PENDING`);
  `409 invalid_payment_transition` (overwriting `PAID`, or `REJECTED → PAID`
  without a customer resubmission).

### Manual refunds (no gateway)

When a **cancelled** order (`orderStatus: CANCELLED`) had an already confirmed
payment (`paymentStatus: PAID`), an administrator returns the money
out-of-band (e.g. through their own GCash app) and records the actual outcome
here. Refund state lives on the order document as `refund.status` and is
independent of `paymentStatus` (which stays `PAID`):

- `NOT_REFUNDED` — default; every legacy/historic order reads as this.
- `REFUND_PENDING` — an admin opened a refund; money not sent yet.
- `REFUNDED` — an admin explicitly confirmed the money was actually sent.

**Refund transitions** (all admin-only, in a Firestore transaction):

| From | To | Action | Notes |
| --- | --- | --- | --- |
| `NOT_REFUNDED` | `REFUND_PENDING` | admin (`POST …/refund` `{ "action": "PENDING" }`) | opens the refund; stores the amount + admin uid + timestamp |
| `REFUND_PENDING` | `REFUND_PENDING` | admin | repeating `PENDING` is an idempotent no-op (writes nothing) |
| `REFUND_PENDING` | `REFUNDED` | admin (`{ "action": "COMPLETE", "confirmed": true }`) | requires the explicit `confirmed` flag — never set by merely clicking again |
| `NOT_REFUNDED` | `REFUNDED` | — | refused: record it as pending first (`409 invalid_refund_transition`) |
| `REFUNDED` | anything | — | refused for good: an order can be refunded exactly once (`409 refund_already_completed`) |

Starting a refund never marks it completed, and no client-supplied amount is
trusted: the recorded `refund.amount` equals the order's stored paid `total`
at the time the refund was opened. Refund transitions are appended to a
separate admin-only `refundAudit` trail (`{ from, to, actorUid, actorRole }`)
per order — the existing `paymentAudit` and `paymentDecision` are never
modified, and `orderStatus` / `paymentStatus` are never changed by a refund.

**Admin — POST /api/admin/orders/:id/refund** (admin only, 60/min/IP, same
bucket as the other admin order endpoints):

```jsonc
// request — start a pending refund
{ "action": "PENDING" }
// request — after the money was actually sent back
{ "action": "COMPLETE", "confirmed": true }
// response 200 — the updated order, same shape as GET /api/orders/:id plus
// the admin-only fields
{ "id": "…", "refund": { "status": "REFUND_PENDING", "amount": 215,
                         "requestedAt": "…", "completedAt": null } /* … */ }
```

- Eligibility: the order must be `CANCELLED` **and** `PAID`; anything else →
  `409 order_not_refundable`.
- Errors: `401 unauthorized` (no/bad token); `403 forbidden` (non-admin);
  `404 order_not_found`; `400 invalid_request` (`action` missing/unknown, or
  `COMPLETE` without `confirmed: true`); `409 order_not_refundable`;
  `409 invalid_refund_transition` (completing a refund that was never opened);
  `409 refund_already_completed` (another completed refund already exists).

**Customer visibility:** `GET /api/orders/:id` (and every response that uses
the order shape) now includes a `refund` object — `{ status, amount,
requestedAt, completedAt }` — so mobile clients can show refund progress.
The customer `refund` object is null-amount `NOT_REFUNDED` for orders never
refunded, and never includes admin notes or the admin-only `refundAudit`
trail (which administrators additionally receive).

### Contact messages — POST /api/contact-messages

The mobile app's **Contact Us** form. Like the app's other customer-facing
write endpoints (`POST /api/orders`, `POST /api/profile/photo`) it requires
`Authorization: Bearer <any valid Firebase ID token>`; the sender's `userId`
is taken from the verified token and **never** from the body. 10
requests/min/IP.

**Request:**

```jsonc
{
  "name": "Juan dela Cruz",     // required, trimmed, 1–120 chars
  "email": "juan@example.com",  // required, trimmed, valid email, ≤254 chars
  "subject": "Order question",  // required, trimmed, 1–150 chars
  "message": "…"                // required, trimmed, 1–2000 chars
}
```

- Values are trimmed server-side; empty or whitespace-only values are
  rejected (`400 invalid_request` with per-field `details`).
- Any other properties (`userId`, `status`, `createdAt`, `id`, …) are
  **ignored** — the document id, `userId`, `status` and timestamps are
  always server-generated.

**Response `201`:**

```json
{ "id": "<server-generated id>", "status": "NEW" }
```

The `201` is returned only after Firestore confirms the write; a storage
failure returns `500 internal_error` (never a false success). Missing server
credentials → `503 server_not_configured`.

**Storage:** Firestore collection `contactMessages`, document fields `id`,
`name`, `email`, `subject`, `message`, `userId` (verified token),
`status` (`NEW` initially), `createdAt`/`updatedAt` (server timestamps)
and `replies` (admin replies appended by the endpoint below). Clients have
**no** direct access to this collection (`firestore.rules`
denies all client reads/writes); the only customer read path is the
owner-scoped `GET /api/contact-messages/mine` endpoint below. There is
deliberately **no** per-message GET and no PATCH/DELETE endpoint on
`/api/contact-messages`, so customers can never read, edit or delete another
customer's message through the API. Administrators read messages, change
their workflow status and reply through the separate, admin-guarded
endpoints below.

### Customer — GET /api/contact-messages/mine

The mobile app's **My Messages** screen. Requires `Authorization: Bearer
<any valid Firebase ID token>`; 60/min/IP.

Ownership is enforced server-side: the Firestore query is scoped to the
`userId` from the verified token, so a client can never retrieve another
customer's messages. **No user id is accepted from the request** — a
`?userId=` query string is ignored. Messages are returned newest first.

**Response `200`:**

```json
{
  "messages": [
    {
      "id": "…",
      "subject": "Order question",
      "message": "…",
      "status": "NEW",
      "createdAt": "2026-10-09T12:00:00.000Z",
      "updatedAt": "2026-10-09T12:00:00.000Z",
      "replies": []
    }
  ]
}
```

Only the fields above are returned — the sender `name`, `email` and the
internal `userId` never leave the server. `replies` holds any stored admin
replies, oldest first, with only `{ id, senderRole, reply, createdAt }` per
entry (no identity fields). A customer with no messages gets
`{ "messages": [] }` (not an error). Missing/invalid token → `401
unauthorized`; missing server credentials → `503 server_not_configured`.
Requires no Firestore composite index (single-field `userId` equality, then
in-memory sort).

### Admin — GET /api/admin/contact-messages

Lists stored messages for the admin site, newest first. Guard: Bearer admin
token — `401 unauthorized` without/with a bad token, `403 forbidden` for
non-admin users (role read server-side from `users/{uid}`). Rate limit
60/min/IP.

Query parameters (all optional; invalid values → `400 invalid_request` with
per-field `details`):

| Param | Rule |
| --- | --- |
| `status` | `NEW`, `READ` or `RESOLVED` — filters the list |
| `page` | positive integer, default `1` |
| `pageSize` | integer 1–100, default `25` (hard maximum) |

**Response `200`:**

```json
{
  "messages": [
    {
      "id": "…",
      "name": "Juan dela Cruz",
      "email": "juan@example.com",
      "subject": "Order question",
      "message": "…",
      "status": "NEW",
      "createdAt": "2026-10-09T12:00:00.000Z",
      "updatedAt": "2026-10-09T12:00:00.000Z",
      "replies": []
    }
  ],
  "page": 1,
  "pageSize": 25,
  "total": 1,
  "totalPages": 1
}
```

Only the fields above are returned — the stored `userId` and any other
document properties never leave the server. `replies` holds stored admin
replies oldest first. Messages on a page beyond
`totalPages` return an empty `messages` array (not an error).

### Admin — PATCH /api/admin/contact-messages/:id/status

Changes a message's workflow status. Same admin guard and rate limit as the
list endpoint.

**Request:** `{ "status": "READ" }` — only `READ` and `RESOLVED` are
accepted; `NEW` (the server-assigned initial status) and any other value →
`400 invalid_request`. Unknown id → `404 contact_message_not_found`. Only
`status` and `updatedAt` are written — the customer's submission
(`name`/`email`/`subject`/`message`/`userId`) and `createdAt` can never be
changed through this endpoint.

**Response `200`:**

```json
{ "id": "<message id>", "status": "READ" }
```

### Admin → POST /api/admin/contact-messages/:id/replies

Appends an administrator's reply to a customer message. Same admin guard
and rate limit as the list/status endpoints — `401 unauthorized` without a
valid token, `403 forbidden` for non-admin users.

**Request:** `{ "reply": "We found it — shipping tomorrow." }`. Only `reply`
is read; client-supplied `senderRole`/`id`/timestamps are ignored. The text
is trimmed and must be 1–5000 characters — `400 invalid_request` otherwise.
Unknown id → `404 contact_message_not_found`.

**Response `201`:**

```json
{
  "id": "<message id>",
  "status": "READ",
  "reply": {
    "id": "<server-generated reply id>",
    "senderRole": "ADMIN",
    "reply": "We found it — shipping tomorrow.",
    "createdAt": "2026-10-09T12:30:00.000Z"
  }
}
```

Replies are stored in the message document's `replies` array with a
server-generated id, the server-decided `senderRole` (`ADMIN`; `CUSTOMER`
is reserved for a future flow) and a server-timestamp `createdAt` — only
the Admin SDK writes them, clients remain denied by `firestore.rules`.
The write is atomic: `replies`, `updatedAt` and (when applicable) `status`
are all stored in one update, so a failed write leaves the message
untouched and never reports success. Replying to a `NEW` message marks it
`READ`; `RESOLVED` is never applied automatically — an admin chooses that
explicitly through the status endpoint.

**Email notifications:** not configured in this repository — Firestore
storage is the reliable submission mechanism. Forwarding new messages to
`bistrobuddies@gmail.com` requires wiring a real email provider (env-based
credentials, separate failure handling that does not undo a successful
store) as a future setup step; no email is sent or claimed today.

---

## 5. Firestore access for clients

| Collection | Client reads | Client writes |
| --- | --- | --- |
| `products` | **anyone** (public catalog) | none — use `/api/admin/products` |
| `users/{uid}` | self or admin | self (role preserved), or use the API |
| `orders` | own orders or admin | **denied** — create only via `POST /api/orders`; GCash details only via `POST /api/orders/:id/gcash-details` (owner); status/payment decisions admin-only via the API |
| `payments` | own or admin | **denied** — backend-managed (PayMongo not yet implemented) |
| `contactMessages` | **denied** (everyone, admins included) | **denied** — create only via `POST /api/contact-messages` (Admin SDK) |

Only `products` is publicly readable; `users`, `orders`, `payments` and
`contactMessages` stay private. The Admin SDK (backend) bypasses these rules,
which is how the API creates orders, products and contact messages. **Deploy
`firestore.rules` with the Firebase CLI
against `bistrobuddies-4f179` — this repository does not deploy anything.**

---

## 6. Image uploads (Cloudinary)

> Cloudinary is the permanent image store. Validated images are uploaded
> server-side with the official Cloudinary Node.js SDK and the HTTPS
> `secure_url` is returned as `imageUrl`. Cloudinary credentials
> (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`)
> live **only on the backend** (env vars / hosting provider secrets) and are
> never returned to clients. The local `uploads/` directory is **not** used
> for new uploads — local disk is not durable on hosts like Render — and
> there is deliberately **no local fallback**: when Cloudinary is not
> configured the endpoints fail with `503 server_not_configured` instead of
> pretending the upload succeeded. (There is no reliable
> development-vs-production signal in the current configuration, so a
> dev-only fallback would risk silently storing production images
> ephemerally.)
>
> Existing products and historical orders are untouched: no migration rewrites
> stored `imageUrl` values and no old Cloudinary asset is auto-deleted.

### POST /api/admin/uploads

| Topic | Rule |
| --- | --- |
| Auth | `Authorization: Bearer <admin ID token>` — `401 unauthorized` without/with a bad token, `403 forbidden` for non-admin users (verified Firebase token + server-side `users/{uid}.role == 'admin'` check) |
| Content type | `multipart/form-data` with exactly **one** file field named `file` |
| Accepted images | **JPEG, PNG, WebP** — verified from the file's magic bytes, never from the client's file name or `Content-Type` → otherwise `415 unsupported_media_type` |
| Size limit | `UPLOAD_MAX_BYTES`, default **5 MB** (5 242 880 bytes) → `413 file_too_large` |
| Other fields | none accepted → `400 invalid_request` |
| Missing/empty file | `400 invalid_request` |
| Rate limit | 30 requests/min/IP → `429 rate_limited` |
| Missing Cloudinary config | `503 server_not_configured` (clear message, no false success) |
| Cloudinary failure | `500 upload_failed` |

**Request** (admin site, `environment.apiBaseUrl` = `http://localhost:3001/api`):

```ts
const form = new FormData();
form.append('file', file, file.name); // field name must be "file"

const response = await fetch(`${environment.apiBaseUrl}/admin/uploads`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await admin.getIdToken()}` },
  body: form, // browser sets multipart/form-data + boundary
});
const { imageUrl, publicId } = await response.json(); // 201
```

```bash
curl -X POST http://localhost:3001/api/admin/uploads \
  -H "Authorization: Bearer $ID_TOKEN" \
  -F "file=@./latte.png"
```

**Response `201`:**

```json
{
  "imageUrl": "https://res.cloudinary.com/<cloud-name>/image/upload/v1760000000/bistrobuddies/abc123.png",
  "publicId": "bistrobuddies/abc123",
  "fileName": "bistrobuddies/abc123",
  "mimeType": "image/png",
  "size": 48213,
  "uploadedAt": "2026-10-09T12:00:00.000Z"
}
```

- `imageUrl` is the HTTPS Cloudinary `secure_url` — put it straight into
  `<img src>` and store it as `products/{id}.imageUrl`.
- `publicId` is the Cloudinary `public_id` (also echoed as `fileName` for
  backwards compatibility with the old local-disk response). There is no
  `path` field anymore: the old backend-relative `/uploads/<file>` path only
  applied to local-disk storage.
- The legacy local response (`imageUrl: http://…/uploads/<file>`,
  `path: /uploads/<file>`) no longer applies to new uploads.

**Error codes:** `400 invalid_request`, `401 unauthorized`, `403 forbidden`,
`413 file_too_large`, `415 unsupported_media_type`, `429 rate_limited`,
`500 upload_failed`, `503 server_not_configured`.

### POST /api/profile/photo

Customer profile picture upload — identical rules to
`POST /api/admin/uploads` (multipart field `file`, JPEG/PNG/WebP by magic
bytes, `UPLOAD_MAX_BYTES` default 5 MB, no other form fields, Cloudinary
storage, same error codes) with two differences:

| Topic | Rule |
| --- | --- |
| Auth | `Authorization: Bearer <any valid ID token>` — `401 unauthorized` without/with a bad token; **no admin role required**, because the picture always belongs to the verified token's uid |
| Rate limit | 30 requests/min/IP → `429 rate_limited` |

```ts
const form = new FormData();
form.append('file', file, file.name); // field name must be "file"

const response = await fetch(`${environment.apiBaseUrl}/profile/photo`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await user.getIdToken()}` },
  body: form,
});
const { imageUrl } = await response.json(); // 201
```

The response body has the same shape as the admin upload (`201` with
`imageUrl`, `publicId`, `fileName`, `mimeType`, `size`, `uploadedAt`). The
endpoint writes nothing to Firestore: the mobile app stores the returned
**URL string** as `users/{uid}.photoUrl` (and mirrors it into the Firebase
Auth `photoURL`); the image bytes and any base64 representation are never
written to Firestore.

### Image URL behaviour

- `imageUrl` is the absolute HTTPS Cloudinary `secure_url`, so frontends on
  any origin (`http://localhost:4200`, `http://localhost:8100`, Capacitor,
  production domains) can put it straight into `<img src>` with no extra
  host configuration.
- Historical local files are still served read-only by
  **`GET /uploads/<fileName>`** — no directory listing, no writes,
  `Cache-Control: max-age=3600`, and `Cross-Origin-Resource-Policy:
  cross-origin` so cross-origin `<img>` tags are not blocked. Unknown names
  return `404 not_found`; `..`/encoded path traversal is rejected by the
  static handler. **New uploads never create files here.**
- The client's file name is discarded for storage (Cloudinary assigns the
  `public_id` under the `bistrobuddies/` folder), so no path from the client
  ever reaches the filesystem or the storage identifier.
- Reads need no authentication (matching the public product catalog); writes
  require a Bearer token — admin for product images, any signed-in user for
  profile photos.

### Storing the URL in Firestore

The upload endpoint writes **nothing** to Firestore. Take the returned
`imageUrl` and send it with the product write — `POST /api/admin/products`
or `PATCH /api/admin/products/:id` with
`{ "imageUrl": "https://res.cloudinary.com/…", "cloudinaryPublicId": "bistrobuddies/…" }`.
Only those URL/identifier strings plus the product metadata are stored on
`products/{id}`; **the image bytes and any base64 representation are never
written to Firestore.** Existing `imageUrl` values (Cloudinary HTTPS URLs,
old local `/uploads/…` URLs, or bundled `assets/…` paths) keep working as-is
and are never rewritten by reads or by new uploads.

---

## 7. Not implemented (out of scope)

- **Firebase Storage** — not used. Permanent image hosting is Cloudinary
  (§6); the remaining local-disk surface is read-only legacy serving of
  historical `GET /uploads/<file>` files only.
- Payment gateways (no PayMongo/Adyen/Ezypay/GCash APIs, webhooks, automated
  checks, or real payment processing). GCash is manual verification only
  (§4): `paymentMethod: "GCASH"` with customer-submitted details and an admin
  `PAID`/`REJECTED` decision. There is no
  QR display or QR storage in this backend.
- Admin order list endpoint (`GET /api/admin/orders` does not exist; use
  Firestore reads, which are admin-allowed, until it does).
- Email notifications for contact messages (no email provider is configured;
  submissions are stored in Firestore only — see §4 "Contact messages").
  Admin listing/status updates are implemented (§4 "Admin — GET
  /api/admin/contact-messages"), but no email is sent when a message
  arrives.
