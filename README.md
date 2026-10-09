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

## Security posture

- `helmet` security headers, `x-powered-by` disabled
- CORS allowlist (`ALLOWED_ORIGINS`); requests without an Origin (native
  apps, curl) are allowed
- JSON body limit 200 kB
- Firebase ID token verification + server-side admin role check on every
  privileged route (never trusts client-provided uid/role/price)
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
