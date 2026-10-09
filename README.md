# BistroBuddies Backend (trusted API)

Express + TypeScript API that performs privileged Firebase Admin operations
for the customer app and the admin site. Deployable to any Node host; a
serverless entry (`api/index.ts`, `serverless-http`) is prepared for Vercel
but has **not** been deployment-tested.

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
| POST | `/api/admin/products` | Bearer (admin) | Creates a product. 60 req/min/IP |
| PATCH | `/api/admin/products/:id` | Bearer (admin) | Partial product update |
| DELETE | `/api/admin/products/:id` | Bearer (admin) | Deletes a product |
| POST | `/api/admin/uploads` | Bearer (admin) | Stores a product image locally → `{ imageUrl, … }`. 30 req/min/IP (see below) |
| GET | `/uploads/:file` | — (public read) | Serves locally uploaded images (development only) |
| POST | `/api/admin/orders/:id/status` | Bearer (admin) | Validated status transition (idempotent on same status) |

All responses use `{ "error": { "code", "message", "details?" } }` on failure.

### Product schema and currency

Products follow the standardized schema — `name`, `category`, `description`,
`imageUrl`, `price` (canonical PHP list price), `currency` (always `PHP`),
`available`, `createdAt`, `updatedAt` — plus the size-tiered
`smallPrice`/`mediumPrice`/`largePrice` and `sugarOptions` that the existing
clients' size selector depends on. The canonical `price` is derived from the
size tiers (or the tiers are backfilled from it) so the two can never drift.
Clients format amounts with `₱` (`Intl.NumberFormat('en-PH', { style:
'currency', currency: 'PHP' })`). Historical order prices are snapshots and
are never rewritten.

## Local image uploads (development only)

> ⚠️ Uploaded images are stored on **this machine's local disk**. That is a
> development convenience only: the files are not persistent, not backed up,
> not replicated and disappear with the container/machine. **Never treat
> local disk as production storage** — production needs Firebase Storage,
> which is intentionally not implemented here.

### Configure the local API URL

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:<PORT>` | Public base URL of the backend (no trailing slash). Used to build the absolute `imageUrl` returned by the upload endpoint. Set it to whatever a browser can reach — e.g. `http://localhost:3001` when the admin site runs on `http://localhost:4200`. |
| `UPLOAD_DIR` | `uploads` | Directory images are written to (created automatically, git-ignored). Relative paths resolve against the directory the backend is started from. |
| `UPLOAD_MAX_BYTES` | `5242880` (5 MB) | Maximum accepted upload size. |

The admin site already points at `environment.apiBaseUrl =
'http://localhost:3001/api'` (`../bistrobuddies-admin/src/environments/environment.ts`),
so leave `API_BASE_URL` at its default for local development.

### Start the backend

```bash
npm install
cp .env.example .env        # fill in Firebase credentials (see above)
npm run dev                 # http://localhost:3001 (tsx watch, reload on change)
# or, compiled:
npm run build && npm start
```

### Upload a product image

`POST /api/admin/uploads` — `Authorization: Bearer <admin token>`,
`multipart/form-data` with **one file field named `file`**, JPEG/PNG/WebP only
(detected from magic bytes), max 5 MB, 30 requests/min/IP.

```ts
const form = new FormData();
form.append('file', file, file.name);
const { imageUrl } = await (
  await fetch(`${environment.apiBaseUrl}/admin/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await admin.getIdToken()}` },
    body: form,
  })
).json(); // 201 → imageUrl
```

Then store the URL with the product
(`POST/PATCH /api/admin/products` with `{ ..., "imageUrl": imageUrl }`).
**Firestore stores only the URL string and product metadata — never image
bytes or base64.**

Response `201`:

```json
{ "imageUrl": "http://localhost:3001/uploads/1760000000000-<uuid>.png",
  "path": "/uploads/1760000000000-<uuid>.png",
  "fileName": "1760000000000-<uuid>.png",
  "mimeType": "image/png", "size": 48213,
  "uploadedAt": "2026-10-09T12:00:00.000Z" }
```

Images are served read-only at `GET http://localhost:3001/uploads/<fileName>`
(no directory listing, 1 h cache, `Cross-Origin-Resource-Policy: cross-origin`
so cross-origin `<img>` tags work). File names are generated server-side
(`<epochMs>-<uuid>.<ext>`); the client's file name is discarded, so path
traversal is impossible. Full contract: **`docs/API_CONTRACT.md` §6**.

Errors: `400 invalid_request`, `401 unauthorized`, `403 forbidden`,
`413 file_too_large`, `415 unsupported_media_type`, `429 rate_limited`,
`503 server_not_configured`.

## Security posture

- `helmet` security headers, `x-powered-by` disabled
- CORS allowlist (`ALLOWED_ORIGINS`); requests without an Origin (native
  apps, curl) are allowed
- JSON body limit 200 kB
- Firebase ID token verification + server-side admin role check on every
  privileged route (never trusts client-provided uid/role/price)
- Local uploads: admin-only, type decided by magic bytes (JPEG/PNG/WebP),
  `UPLOAD_MAX_BYTES` (5 MB) cap, exactly one form field, server-generated
  `<uuid>` names with a path-traversal guard, flat git-ignored `uploads/`
  directory served read-only with no directory listing
- Fixed-window in-memory rate limits (per instance)
- Firestore rules (`firestore.rules`) enforce the same policy for direct
  client access: public reads on `products` only; `users`/`orders`/`payments`
  are private; clients cannot create orders/payments or change any status —
  those writes happen only through this API (Admin SDK). Rules are **not**
  deployed from this repo; deploy them deliberately with the Firebase CLI.

## Deployment (untested)

- Any Node host: `npm run build && npm start` (set `PORT`).
- Vercel: `api/index.ts` wraps `createApp()` with `serverless-http`.
  This path compiles but has not been tested against Vercel.

## Environment variables

See `.env.example` (names, defaults, and purpose). No secrets are stored in
this repository; service-account credentials stay in `.env` (git-ignored) or
in the hosting provider's environment.
