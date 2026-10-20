# BistroBuddies Backend (trusted API)

Express + TypeScript API that performs privileged Firebase Admin operations
for the customer app and the admin site. It listens on `PORT`, runs as a
long-lived Node server, and can be deployed to any Node host. A
`render.yaml` Blueprint is included for Render (see "Render deployment");
a serverless entry (`api/index.ts`, `serverless-http`) is also prepared for
Vercel-style hosts but has **not** been deployment-tested.

## Prerequisites

- Node.js >= 20.12 (developed with Node 24)
- A service account for Firebase project `bistrobuddies-4f179`
  (needed only for authenticated/admin endpoints — see below)

## Setup

```bash
npm install
cp .env.example .env      # then edit values
```

### Firebase Admin credentials (required for anything beyond /api/health)

Provide either:

- `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccount.json`, or
- `FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'` (JSON as a
  single-line string)

Without credentials the server still starts: `GET /api/health` returns
`"firebaseConfigured": false` and every authenticated/admin endpoint returns
`503 server_not_configured` with a clear message. **Never commit the
service-account file or the `.env` file** (both are `.gitignore`d).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with reload (`tsx watch src/server.ts`, :3001) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`node dist/src/server.js`) |
| `npm test` | Unit + HTTP integration tests (Vitest, no network/credentials needed) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |

## API surface

Base path: `/api` (also mounted at `/` for stripped-path serverless hosts).
Full contract for the mobile and admin clients: **`docs/API_CONTRACT.md`**.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | — | Liveness + `firebaseConfigured` flag |
| GET | `/api/products` | — (public) | Standardized catalog, newest first. 120 req/min/IP |
| GET | `/api/products/:id` | — (public) | Single product |
| POST | `/api/orders` | Bearer (customer) | Creates an order; prices/totals computed server-side. 20 req/min/IP |
| GET | `/api/orders/:id` | Bearer (owner/admin) | Others get 404 (no order id probing). 120 req/min/IP |
| POST | `/api/orders/:id/cancel` | Bearer (owner) | Cancels a `PENDING` order (`orderStatus: CANCELLED`, never deletes). 20 req/min/IP |
| POST | `/api/orders/:id/gcash-details` | Bearer (owner) | Submits GCash name/number for manual verification → `{ id, paymentStatus }`. 20 req/min/IP |
| POST | `/api/orders/:id/payment-proof` | Bearer (owner) | Uploads mandatory GCash proof (multipart `file`, JPEG/PNG/WebP, ≤5 MB) to Cloudinary → `{ id, paymentStatus: "VERIFYING", paymentProof }`. Alias: `/gcash-proof`. 20 req/min/IP |
| POST | `/api/contact-messages` | Bearer (customer) | Stores a "Contact Us" submission in Firestore → `{ id, status }`. 10 req/min/IP |
| GET | `/api/contact-messages/mine` | Bearer (customer) | The caller's own messages, newest first. 60 req/min/IP |
| POST | `/api/admin/products` | Bearer (admin) | Creates a product. 60 req/min/IP |
| PATCH | `/api/admin/products/:id` | Bearer (admin) | Partial product update |
| DELETE | `/api/admin/products/:id` | Bearer (admin) | Deletes a product |
| POST | `/api/admin/uploads` | Bearer (admin) | Stores a product image in Cloudinary → `{ imageUrl, publicId, … }`. 30 req/min/IP (see below) |
| POST | `/api/profile/photo` | Bearer (customer) | Stores the caller's profile picture in Cloudinary. 30 req/min/IP |
| GET | `/uploads/:file` | — (public read) | Serves **legacy** local images read-only (new uploads go to Cloudinary) |
| POST | `/api/admin/orders/:id/status` | Bearer (admin) | Validated status transition (idempotent on same status); `COMPLETED` settles COD to `PAID` |
| POST | `/api/admin/orders/:id/payment` | Bearer (admin) | Confirm/reject a GCash payment (proof required for PAID) or confirm legacy COD collection (completed orders only) → `{ id, paymentStatus }` |
| POST | `/api/admin/orders/:id/payment-proof` | Bearer (admin) | Alias of `/payment` for reviewing submitted proof |
| POST | `/api/admin/orders/:id/cod-payment` | Bearer (admin) | Confirm legacy COD cash collection on a completed order → `{ id, paymentStatus: "PAID" }` |
| POST | `/api/admin/orders/:id/refund` | Bearer (admin) | Record a manual refund on a cancelled paid order → full order incl. `refund` |
| GET | `/api/admin/contact-messages` | Bearer (admin) | Lists customer "Contact Us" messages, newest first (`?status=NEW\|READ\|RESOLVED`, `?page`, `?pageSize`). 60 req/min/IP |
| PATCH | `/api/admin/contact-messages/:id/status` | Bearer (admin) | Sets `status` to `READ` or `RESOLVED` → `{ id, status }` |
| POST | `/api/admin/contact-messages/:id/replies` | Bearer (admin) | Appends an admin reply → `201 { id, status, reply }` |

Every path also works without the `/api` prefix (the router is mounted at both
`/api` and `/`); **use the `/api/...` paths**. All responses use
`{ "error": { "code", "message", "details?" } }` on failure. Full request and
response shapes: **`docs/API_CONTRACT.md`**.

### Payment status and GCash proof

`orderStatus` (fulfilment) and `paymentStatus` (money) are independent. Moving
a COD order to `COMPLETED` marks it `PAID` in the same write, because cash is
collected on delivery. GCash becomes `PAID` only when an administrator confirms
it after reviewing the customer's submitted details **and proof**.

The explicit admin actions `POST /api/admin/orders/:id/cod-payment` (or
`/payment` with `{ "decision": "PAID" }`) remain available for legacy completed
COD orders that are still `PENDING`; they require the order to be `COMPLETED`
and never change `orderStatus`.

The mandatory GCash proof is uploaded by the order owner via
`POST /api/orders/:id/payment-proof` (alias `/gcash-proof`) as
`multipart/form-data` with one `file` field. JPEG/PNG/WebP are detected from
magic bytes, the 5 MB limit is enforced, and the image is stored in Cloudinary
(never in Firestore). Only the HTTPS URL and metadata are written to the order;
the payment moves to `VERIFYING` and can be replaced while verifying or after a
rejection. Proof cannot be changed once the payment is `PAID`, and a successful
upload whose Firestore write fails has its Cloudinary asset cleaned up
best-effort. Administrators see the proof URL in the normal order data and
approve/reject it through the admin payment endpoint (admin role required).

### Product schema and currency

Products follow the standardized schema — `name`, `category`, `description`,
`imageUrl`, `price` (canonical PHP list price), `currency` (always `PHP`),
`available`, `createdAt`, `updatedAt` — plus the size-tiered
`smallPrice`/`mediumPrice`/`largePrice` and `sugarOptions` that the existing
clients' size selector depends on. The three size prices are canonical: they
are stored exactly as the admin sends them (100/120/150 stay distinct), and
the canonical `price` is derived from them (medium → small → large) so the two
can never drift. The legacy single `price` field is still accepted, but it only
fills in size tiers for products that have none — it never overwrites existing
size prices. Customers never send prices: order totals are recomputed
server-side from these records. Clients format amounts with `₱`
(`Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' })`).
Historical order prices are snapshots and are never rewritten; legacy flat
products are migrated by PATCHing the three size prices explicitly (see
`docs/API_CONTRACT.md` § "Migrating legacy products").

## Contact Us messages

`POST /api/contact-messages` (Bearer token, any signed-in user) stores the
mobile app's Contact Us form in the Firestore `contactMessages` collection:
`name`, `email`, `subject`, `message` (trimmed, validated and length-capped
server-side), plus `userId` from the verified token, `status: 'NEW'` and
server timestamps. The document id and all server-controlled fields are
generated by the backend; client-supplied `userId`/`status`/timestamps are
ignored. The `201 { id, status }` confirmation is returned only after
Firestore confirms the write. Customers have exactly one read path — their
own messages via `GET /api/contact-messages/mine` (owner-scoped server-side)
— and no per-message GET/PATCH/DELETE, so they can never read or edit another
customer's message; `firestore.rules` denies all direct client access to the
collection. Administrators list messages
(`GET /api/admin/contact-messages`, with `?status` filtering and
`?page`/`?pageSize` pagination), mark them `READ`/`RESOLVED`
(`PATCH /api/admin/contact-messages/:id/status`) and append replies
(`POST /api/admin/contact-messages/:id/replies`) through the admin-guarded
API; only `status`/`updatedAt` (and append-only `replies`) are ever written
there. **Email notifications are not configured** (no email provider in this
repo): Firestore storage is the submission mechanism, and forwarding to
`bistrobuddies@gmail.com` needs a separate email-provider setup. Full
contract: **`docs/API_CONTRACT.md` § "Contact messages"**.

## Image uploads (Cloudinary)

New product images (`POST /api/admin/uploads`, admin) and profile photos
(`POST /api/profile/photo`, any signed-in user) are stored in **Cloudinary**
and the HTTPS `secure_url` is returned as `imageUrl`. There is deliberately
**no local-disk fallback** (local disk is not durable on hosts like Render):
when Cloudinary is not configured the endpoints return
`503 server_not_configured` instead of pretending the upload succeeded.

Both endpoints accept `multipart/form-data` with exactly **one** file field
named `file`, JPEG/PNG/WebP only (detected from magic bytes, never from the
client's file name or `Content-Type`), at most `UPLOAD_MAX_BYTES`
(default 5 MB), and no other form fields. Both are limited to 30 req/min/IP.

```ts
const form = new FormData();
form.append('file', file, file.name);
const { imageUrl } = await (
  await fetch(`${environment.apiBaseUrl}/admin/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await admin.getIdToken()}` },
    body: form,
  })
).json(); // 201 → imageUrl (Cloudinary HTTPS URL)
```

Response `201` (same shape for both endpoints):

```json
{ "imageUrl": "https://res.cloudinary.com/<cloud-name>/image/upload/v1760000000/bistrobuddies/abc123.png",
  "publicId": "bistrobuddies/abc123",
  "fileName": "bistrobuddies/abc123",
  "mimeType": "image/png", "size": 48213,
  "uploadedAt": "2026-10-09T12:00:00.000Z" }
```

Store the returned URL with the product (`POST/PATCH /api/admin/products`
with `{ ..., "imageUrl": imageUrl }`). **Firestore stores only the URL string
and product metadata — never image bytes or base64.**

Required server-side credentials (never returned to clients): see
`CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` in
`.env.example`.

### Legacy local files

The flat, git-ignored `uploads/` directory is only used to serve **historical**
files read-only at `GET /uploads/<fileName>` (no directory listing, 1 h cache,
`Cross-Origin-Resource-Policy: cross-origin`). New uploads never write there.
`API_BASE_URL` (default `http://localhost:<PORT>`) is only used to build URLs
for those legacy local files; Cloudinary uploads return absolute HTTPS URLs
and ignore it. Full contract: **`docs/API_CONTRACT.md` §6**.

### Legacy tracked uploads

44 files under `uploads/` are still **tracked in Git** even though `.gitignore`
ignores `uploads/` (they were committed before the ignore rule was added). New
uploads never use local disk, so these files are obsolete and should be removed
from Git tracking while keeping them on local disk. This is a manual step — no
repository-mutating command is run by the deployment change:

```bash
# 1. Stop tracking the files but keep them on disk (do not use plain `git rm`)
git rm --cached -r uploads

# 2. Inspect: the files must still exist locally, only the index changes
git status
git diff --cached --stat

# 3. Commit the removal-from-tracking (the working copies stay on disk)
git commit -m "Stop tracking legacy uploads/ (uploads now use Cloudinary)"
```

After this, `uploads/` stays ignored and any local files remain servable by the
running process's `GET /uploads/<file>` route. Note that on a fresh host like
Render there is no local `uploads/` directory, so any historical product
`imageUrl` that still points at `/uploads/<file>` will 404 in production —
check Firestore for such URLs before relying on them. New product/profile
uploads return Cloudinary HTTPS URLs and are unaffected.

## Security posture

- `helmet` security headers, `x-powered-by` disabled
- CORS allowlist (`ALLOWED_ORIGINS`); requests without an Origin (native
  apps, curl) are allowed
- JSON body limit 200 kB
- Firebase ID token verification + server-side admin role check on every
  privileged route (never trusts client-provided uid/role/price)
- Uploads: product images admin-only, profile photos any signed-in user;
  type decided by magic bytes (JPEG/PNG/WebP), `UPLOAD_MAX_BYTES` (5 MB) cap,
  exactly one form field; bytes go to Cloudinary server-side (credentials
  never leave the backend); only the URL string is written to Firestore
- `TRUST_PROXY=1` sets Express `trust proxy` to one hop behind Render's proxy
  so rate limiting sees the real client IP
- Fixed-window in-memory rate limits (per instance — see "Rate limiting")
- Firestore rules (`firestore.rules`) enforce the same policy for direct
  client access: public reads on `products` only; `users`/`orders`/`payments`
  are private; clients cannot create orders/payments or change any status —
  those writes happen only through this API (Admin SDK); `contactMessages`
  is fully denied to clients (backend-only, no customer read access).
  Rules are **not** deployed from this repo; deploy them deliberately with
  the Firebase CLI.

## Render deployment

`render.yaml` is a Render Blueprint for this service. Verified settings:

| Setting | Value |
| --- | --- |
| Runtime | `node` (uses `package.json` `engines.node >=20.12`) |
| Build command | `npm install && npm run build` |
| Start command | `node dist/src/server.js` |
| Health check path | `/api/health` |
| Auto-deploy | `autoDeployTrigger: 'off'` (deploy manually from the Dashboard) |
| Branch | `BACKEND-BEFORE-DEPLOYMENT` (update when merged into the default branch) |

`npm run build` runs `tsc -p tsconfig.json`, which emits the compiled server to
`dist/src/server.js` (verified). Render injects `PORT` automatically; the
backend reads it in `src/config.ts` and the compiled server listens on it.

The health check is unauthenticated and exposes no secrets:
`GET /api/health` → `{ "status": "ok", "service": "bistrobuddies-backend",
"firebaseConfigured": <boolean>, "timestamp": "…" }` (also available at
`/health`). `firebaseConfigured` only means a credential source is present and
Firebase Admin initialized — it does **not** prove every Firebase operation
succeeds.

To deploy: create a Blueprint in Render from this repository and branch, supply
the `sync: false` environment variables when prompted, then trigger the deploy
manually. No secrets are stored in this repository.

## Rate limiting

Rate limits are a fixed-window counter kept in an in-memory `Map` per route
group (`src/middleware/rate-limit.ts`). It works for a single instance: with
`TRUST_PROXY=1`, `req.ip` is the real client IP from Render's proxy. It is
**not** shared between instances, so if the service is ever scaled to more
than one instance each instance enforces its own counter and the effective
limit becomes `limit × instances`. The map is also per-process, so counters
reset on every deploy/restart. A shared store (e.g. Render Key Value / Redis)
would be required for a single global counter; that adds a paid dependency and
is intentionally **not** added. Authentication and Firestore still enforce
authorization regardless of rate limits.

## Environment variables

See `.env.example` (names, defaults, and purpose). No secrets are stored in
this repository; service-account credentials stay in `.env` (git-ignored) or in
the hosting provider's environment.

| Name | Required | Format / notes |
| --- | --- | --- |
| `PORT` | no | Set automatically by Render. Default `3001` |
| `TRUST_PROXY` | yes (Render) | `1` or `true` behind a proxy so `req.ip` is the real client |
| `ALLOWED_ORIGINS` | yes (production) | Comma-separated exact browser origins. Defaults to localhost + Capacitor only |
| `FIREBASE_SERVICE_ACCOUNT` | one of | Full service-account JSON as a single string |
| `GOOGLE_APPLICATION_CREDENTIALS` | one of | Path to a service-account file (use a Render Secret File path, never a Windows path) |
| `FIREBASE_PROJECT_ID` | no | Default `bistrobuddies-4f179` |
| `DELIVERY_FEE` | no | PHP amount added to every order. Default `0` |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | yes (for uploads) | Server-side only; missing → uploads return `503 server_not_configured` |
| `UPLOAD_MAX_BYTES` | no | Default `5242880` (5 MB) |
| `UPLOAD_DIR` | no | Legacy read-only `GET /uploads/<file>` root. Default `uploads` |
| `API_BASE_URL` | no | Legacy local-file URL base only; Cloudinary returns absolute HTTPS URLs |

### Configuring Firebase securely in Render

- **Preferred:** set `FIREBASE_SERVICE_ACCOUNT` in the Dashboard to the full
  service-account JSON content (multiline is fine). It is stored encrypted and
  used via `cert()` in `src/firebase/admin.ts`; it is never written to disk or
  logged.
- **Alternative:** create a Render **Secret File** containing the JSON (mounted
  read-only, e.g. `/etc/secrets/firebase-service-account.json`) and set
  `GOOGLE_APPLICATION_CREDENTIALS` to that mount path. Do not use a local
  Windows path.
- **Cloudinary:** set the three `CLOUDINARY_*` values in the Dashboard; they
  are read server-side only and never returned to clients.

## Other hosts

- Any Node host: `npm run build && npm start` (set `PORT`).
- Vercel: `api/index.ts` wraps `createApp()` with `serverless-http`.
  This path compiles but has not been tested against Vercel.
