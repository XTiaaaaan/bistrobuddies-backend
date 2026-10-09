# PROJECT_CONTEXT.md — BistroBuddies Backend (trusted API)

> Generated from a read-only audit of the existing repository. No application code, Firebase settings,
> or data were changed. Secrets are intentionally not reproduced in this file.

---

## 1. What this repository is

**BistroBuddies Backend** — the trusted server-side API for the BistroBuddies system. It performs the
privileged operations that must never be trusted to a browser: order price calculation, admin-authorized
product writes, and (planned) payment/image handling.

| Attribute | Verified value |
|---|---|
| Framework | Express 4 (locked 4.22.3) + TypeScript 5.9 (CommonJS) |
| Firebase | `firebase-admin` 13.10.0 (server SDK) |
| Other deps | `cors`, `helmet`, `serverless-http` |
| Test runner | Vitest 4.1.11 (no config file; default glob picks up `*.test.ts`) |
| Package manager | npm (`package-lock.json` lockfileVersion 3) |
| Node engine | `>=20.12` |
| Firebase project | `bistrobuddies-4f179` (default in `src/config.ts:80-83`, `.firebaserc`) |
| Git | 1 commit (`611d3d4 Initial commit: BistroBuddies backend API`), working tree clean, remote `github.com/XTiaaaaan/bistrobuddies-backend` |

**Not present (verified):** no `paymongo` package, no `multer`/file-upload package, no `dotenv`
(uses native `process.loadEnvFile`), no `vercel.json`, no `.env` file, no `dist/` before this audit.

---

## 2. Entry points

Two entry points build the **same** Express app via `createApp()` (`src/app.ts:22`):

| Entry | Purpose | Command |
|---|---|---|
| `src/server.ts` | Long-running Node server, listens on `config.port` (default **3001**) | `npm run dev` / `npm start` |
| `api/index.ts` | Vercel-style serverless function: `serverless(createApp())` | Vercel auto-detects `api/` |

`api/index.ts` imports `../src/app` directly; both are compiled by one `tsc -p tsconfig.json`
(`rootDir: "."`, `outDir: "dist"`) into `dist/src/server.js` and `dist/api/index.js`.

**Dual path mounting** (`src/app.ts:55-56`): the router is mounted at **both** `/api` and `/`, so every
endpoint works whether the host forwards the full `/api/...` path (local dev) or a stripped path
(some serverless configurations).

---

## 3. API contract (verified route table)

Every route exists at both `/api/<path>` and `/<path>` (see §2).

| Method | Path | Handler | Auth | Rate limit |
|---|---|---|---|---|
| GET | `/api/health` | `src/routes/health.ts:7` | public | — |
| POST | `/api/orders` | `src/routes/orders.ts:16` | Bearer (any signed-in user) | 20/min/IP |
| POST | `/api/admin/products` | `src/routes/admin-products.ts:32` | Bearer + admin | 60/min/IP |
| PATCH | `/api/admin/products/:id` | `src/routes/admin-products.ts:43` | Bearer + admin | 60/min/IP |
| DELETE | `/api/admin/products/:id` | `src/routes/admin-products.ts:55` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/orders/:id/status` | `src/routes/admin-orders.ts:29` | Bearer + admin | 60/min/IP |

**Endpoints that DO NOT exist:** `GET /api/products`, `GET /api/products/:id`,
`GET /api/admin/orders`, `GET /api/orders`, any webhook, any payment endpoint.
CORS allows only `GET, POST, PATCH, DELETE, OPTIONS` (`src/app.ts:42`) — there are no `PUT` routes.
*(A `POST /api/admin/uploads` image-upload endpoint and `GET /uploads/:file`
static route were added after this audit — see §12.)*

### POST /api/orders — request/response

Request (`src/lib/validation.ts:185-321`):
```jsonc
{
  "items": [{ "productId": "…", "size": "small|medium|large", "sugar": "…", "quantity": 1 }],
  "customer":  { "name": "…", "phone": "…" },
  "address":   { "recipientName": "…", "phone": "…", "address": "…", "city": "?", "postalCode": "?" },
  "customerComment": "…",
  "paymentMethod": "COD" | "ONLINE"
}
```
**No prices are accepted from the client.** Limits: ≤50 items, quantity 1–99.

Response **201** (`OrderSummary`, `src/services/orders.service.ts:11-18`):
```json
{ "id": "…", "subtotal": 0, "deliveryFee": 0, "total": 0, "orderStatus": "PENDING", "paymentStatus": "PENDING" }
```

### Error envelope

`{ "error": { "code": "…", "message": "…", "details": ["…"] } }` —
`src/middleware/error-handler.ts:29-38`. Statuses used: 400, 401, 403, 404, 409, 413, 422, 429, 500, 503.

### Order status graph (`src/lib/validation.ts:33-40`)

`PENDING → CONFIRMED → PREPARING → READY → COMPLETED`; `CANCELLED` reachable from every non-terminal state.
Transitions are validated and idempotent on the current status.

---

## 4. Data model (Firestore collections)

Collections: **`users`**, **`products`**, **`orders`**, **`payments`** (all in `bistrobuddies-4f179`).

### products/{id} — `src/services/products.service.ts:18-33`
```
id, name, description, category, imageUrl, cloudinaryPublicId (legacy, unused),
smallPrice, mediumPrice, largePrice,   // PHP, finite, > 0
sugarOptions[], available: boolean, createdAt, updatedAt
```

### orders/{id} — `src/services/orders.service.ts:74-94`
```
id, customerId,
customerSnapshot{uid,name,email,phone},
addressSnapshot{recipientName,phone,address,city?,postalCode?},
items[{productId,productName,imageUrl,size,sugar,quantity,unitPrice,subtotal}],
subtotal, deliveryFee, total, customerComment,
paymentMethod: 'COD'|'ONLINE', paymentStatus: 'PENDING', orderStatus: 'PENDING',
createdAt, updatedAt
```

### users/{uid}
```
uid, name, email, phone, address, role: 'customer'|'admin', createdAt, updatedAt
```

### Pricing (server-authoritative)
- `src/services/orders.service.ts:55,65-67` — prices read from Firestore product docs; client prices ignored.
- `:69-71` — `subtotal = Σ item.subtotal`, `deliveryFee = config.deliveryFee` (env `DELIVERY_FEE`, default 0),
  `total = subtotal + deliveryFee`, all rounded to 2 dp (`:171-173`).
- Unavailable product → 409; unknown product → 404; sugar not offered → 422; invalid price → 422.

---

## 5. Firestore security rules (`firestore.rules`, 73 lines)

| Collection | Read | Write |
|---|---|---|
| `users/{uid}` | self or admin; `list`: admin only | create: self, `role` **forced `'customer'`**, email must match token; update: admin, or self while preserving `uid` **and `role`**; delete: admin |
| `products/{id}` | **signed-in users only** | admin only |
| `orders/{id}` | own (`customerId == uid`) or admin | create: signed-in, own `customerId`, `orderStatus`/`paymentStatus` must be `'PENDING'`, `total == subtotal + deliveryFee`; update/delete: admin |
| `payments/{id}` | own or admin | create: own, `status == 'PENDING'`; update/delete: admin |

Admin is enforced **twice**: rules `isAdmin()` (`firestore.rules:18-22`) and API `requireAdmin`
(`src/middleware/auth.ts:60-79`).

`firestore.indexes.json`: one composite index — collectionGroup `orders` on `customerId ASC, createdAt DESC`.
`firebase.json`: Firestore rules + indexes only (no functions/hosting/emulators).

**Known gap:** the `orders.create` rule checks arithmetic only. Rules cannot verify unit prices, so a
client writing orders **directly to Firestore** could still supply arbitrary `subtotal`/`deliveryFee`
that satisfy the equation. The trusted API exists precisely to close this; see remaining work §9.

---

## 6. Environment variables (names only — no values)

Loaded by `src/config.ts` from `.env` (via `process.loadEnvFile`, non-fatal if absent) and `process.env`.
Template: `.env.example`. **No `.env` file exists in the repository.**

| Name | Non-secret default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `DELIVERY_FEE` | `0` | Delivery fee in PHP added to every order |
| `FIREBASE_PROJECT_ID` | `bistrobuddies-4f179` | Target Firebase project |
| `GOOGLE_APPLICATION_CREDENTIALS` | *(empty)* | **Path** to service-account JSON |
| `FIREBASE_SERVICE_ACCOUNT` | *(empty)* | **Inline** service-account JSON (alternative to the above) |
| `ALLOWED_ORIGINS` | localhost:4200/8100, `capacitor://localhost`, `https://localhost` | CORS allowlist |
| `TRUST_PROXY` | `0` | Set `1` behind Vercel so `req.ip` is correct for rate limiting |
| `UPLOAD_DIR` | `uploads` | Local image-upload directory (added after this audit, §12) |
| `API_BASE_URL` | `http://localhost:<PORT>` | Base URL for returned image `imageUrl`s (added after this audit, §12) |
| `UPLOAD_MAX_BYTES` | `5242880` (5 MB) | Maximum image upload size (added after this audit, §12) |

There are **no** `PAYMONGO_*`, `*_BUCKET`, or `VERCEL_*` variables anywhere in the code.
These names are read by `src/config.ts` (the three upload-related names were
added after this audit — see §12).

---

## 7. Build / test / run commands (executed during this audit)

| Script | Command | Result |
|---|---|---|
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` | **PASS** (exit 0) |
| `npm run lint` | `eslint .` | **PASS** (0 problems) |
| `npm test` | `vitest run` | **PASS — 3 files, 51/51 tests, exit 0** (see note) |
| `npm run build` | `tsc -p tsconfig.json` | **PASS** (exit 0) → `dist/` |
| `npm run dev` | `tsx watch src/server.ts` | not run (requires optional `.env`) |
| `npm start` | `node dist/src/server.js` | valid after `npm run build` |

> Note: the **first** `npm test` invocation reported `2 passed (3)` files / `30 passed (51)` tests plus a
> `Worker forks emitted error` unhandled error. Two subsequent runs (including `--reporter=verbose`) were
> clean 51/51. The suite is passing but shows an **intermittent worker-crash flake** on this machine.

Tests need no network or credentials (Firebase is mocked in `src/app.test.ts:5-103`).

---

## 8. Security requirements (must hold for any future change)

1. **Secrets stay server-side.** Service-account JSON only via `FIREBASE_SERVICE_ACCOUNT` or
   `GOOGLE_APPLICATION_CREDENTIALS`; `.gitignore:8-17` covers `.env*`, `serviceAccount*.json`, `*.pem`, `*.key`.
   Never commit `.env`, and never print service-account or payment-secret values.
2. **Identity comes only from the verified Firebase ID token**, never from the request body
   (`src/middleware/auth.ts:17-18,44-48`).
3. **Every `/admin/*` route keeps `[rateLimit, requireAuth, requireAdmin]`**
   (`src/routes/admin-products.ts:15-19`, `src/routes/admin-orders.ts:15-19`). `src/services/products.service.ts`
   explicitly does **not** re-check roles — safety depends on the route layer.
4. **Prices and totals are computed only on the server.** Never accept `unitPrice`/`subtotal` from a client.
5. **Firestore rules remain defence-in-depth**, not the only control; deploy them with the Firebase CLI
   against `bistrobuddies-4f179` (this audit did not deploy anything).
6. **Helmet + CORS allowlist + 200 kB JSON body limit** stay enabled (`src/app.ts:30,32-47`).
7. **The logger never writes tokens or request bodies** (`src/logger.ts:1`); the error handler strips stack traces.
8. Known residual risks to fix deliberately: rate limiter is in-memory/per-instance (ineffective across
   serverless replicas); CORS permits requests with **no** `Origin` header (intentional for Capacitor/curl —
   auth is still required); `POST /api/orders` rate limit runs *before* auth.

---

## 9. Remaining work (requirement status)

| Requirement | Status | Evidence / what is missing |
|---|---|---|
| Trusted API, server-side order calculations | ✅ **WORKS** | `src/services/orders.service.ts:45-106`; proven by `src/app.test.ts:230-255` |
| Product CRUD | ⚠️ **PARTIAL** | C/U/D exist; **no read endpoints** (`GET /api/products[/:id]`) — clients read Firestore directly |
| Admin authorization | ✅ **WORKS** | `requireAuth` + `requireAdmin` on all 4 admin routes; 401/403 tested (`src/app.test.ts:337-353,470-475`) |
| Admin order management | ⚠️ **PARTIAL** | Status transition exists; **no order list/detail endpoint** for admins |
| Localhost image uploads (dev) | ✅ **WORKS** (added after this audit) | `POST /api/admin/uploads` (admin-only, multer, magic-byte type check, 5 MB cap, rate-limited) + `GET /uploads/:file`; storage in `UPLOAD_DIR` (git-ignored). See §12, `README.md`, `docs/API_CONTRACT.md` §6 |
| Firebase Storage (production) | ❌ **MISSING** | No `getStorage`/`bucket()` usage, no bucket env var |
| PayMongo sandbox + webhook verification | ❌ **MISSING** | Zero matches for `paymongo|webhook|signature|Hmac` in `package.json`, `src/`, `api/`. `paymentMethod: 'ONLINE'` is stored but inert (`src/services/orders.service.ts:89`) |
| Secrets server-side | ✅ **WORKS** | No secrets in repo; `.env.example` placeholders empty |
| Vercel deployment readiness | ⚠️ **PARTIAL** | `api/index.ts` serverless wrapper + dual mounting exist; **no `vercel.json`**, self-declared "PREPARED BUT UNVERIFIED" (`api/index.ts:7-10`), never deployed |
| Public product browsing before login | ⚠️ **BLOCKED BY RULES** | `firestore.rules:43` requires `isSignedIn()` for `products` read; there is also no public `GET /api/products`. Enabling guest browsing needs a deliberate rules change or a public endpoint |
| Product price = single PHP price | ⚠️ **DO NOT CHANGE** | See §10 — changing the schema is unsafe |

### 9a. Payment plan (not implemented)
PayMongo work would add: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` env vars (names reserved for
future use — currently absent), a payment-intent endpoint, a webhook route with timing-safe signature
verification, and server-side `paymentStatus` updates. Nothing was implemented in this audit.

---

## 10. Price model decision (single PHP price vs current schema)

**Current schema: three PHP prices per product — `smallPrice`, `mediumPrice`, `largePrice`.**
All are denominated in **PHP only** (there is no multi-currency structure anywhere), so the
"single PHP price" requirement's *currency* intent is already satisfied.

Collapsing to one price **would be unsafe** — these existing dependencies all require size-tiered prices:

1. `src/services/orders.service.ts:30-34` — `PRICE_FIELDS` maps size → price field.
2. `src/lib/validation.ts:416-425` — validates all three prices as required, finite, `> 0`.
3. `src/services/products.service.ts:18-33` and the updatable-field whitelist (`validation.ts:336-347`).
4. Mobile app: size selector, cart re-pricing, checkout totals (`product-details`, `cart.page.ts:92-129`).
5. Admin app: three price inputs labelled `Small/Medium/Large price (₱)` (`admin-product-form.page.html:64-93`).
6. Firestore rules and any existing product documents in production data.

**Recommendation: keep the three size-tiered PHP prices.** No schema change is proposed.

**Old orders are already safe.** Order items snapshot `productName`, `imageUrl`, `unitPrice`, and `subtotal`
at purchase time (`src/services/orders.service.ts:65-67,74-94`), so later price edits never rewrite history.

**Migration required: none** for orders. A migration would only be needed if someone later consolidated to
one price; that would require a one-time backfill writing e.g. `smallPrice` into a new `price` field on all
`products` docs while leaving historical `orders` documents untouched. This audit performed **no** migration
and changed **no** data.

---

## 11. Related repositories

| Repo | Role |
|---|---|
| `../bistrobuddies-mobile` | Customer app (Ionic/Angular/Capacitor) — calls `POST /api/orders`, reads Firestore directly |
| `../bistrobuddies-admin` | Admin site (Ionic/Angular, static) — calls `/api/admin/products`, reads Firestore directly |

⚠️ `README.md:20,48,81` references `../integration-docs/` (`API_CONTRACT.md`, `ENVIRONMENT_VARIABLES.md`).
**That directory does not exist** in `D:\bistrobuddies`. This file supersedes those references until it is created.

---

## 12. Addendum — local image uploads (added after this audit)

Implemented in `bistrobuddies-backend` only; nothing was deployed.

| Piece | Where |
|---|---|
| Upload route | `src/routes/admin-uploads.ts` — `POST /api/admin/uploads`, guards `[rateLimit 30/min, requireAuth, requireAdmin]` then one `multer` (`memoryStorage`) file in field `file` |
| Type/size checks | Magic-byte sniffing of JPEG/PNG/WebP in `src/lib/uploads.ts`; limit `UPLOAD_MAX_BYTES` (default 5 MB) enforced by multer → `415 unsupported_media_type` / `413 file_too_large` |
| Safe names | `<epochMs>-<uuid>.<ext>` generated server-side; `resolveUploadPath()` rejects separators/`..`; the client's file name is discarded |
| Storage | `UPLOAD_DIR` (default `<repo>/uploads`), created at startup; `.gitignore` excludes `uploads/`, `public/uploads/` and `*-firebase-adminsdk-*.json` (added so a Firebase-Console key download can never be committed) — **local disk, development only** |
| Serving | `express.static` at `GET /uploads/:file` (`src/app.ts`) with `Cross-Origin-Resource-Policy: cross-origin`, no directory listing, 1 h cache |
| Returned URL | `imageUrl = API_BASE_URL + /uploads/<file>` (absolute) plus backend-relative `path` |
| Firestore | The upload endpoint writes nothing; the admin site sends `imageUrl` in the product payload, so `products/{id}` stores the **URL string + metadata only** (never bytes/base64) |
| Tests | `src/admin-uploads.test.ts` — 401/403, unsupported type, oversized, missing field, success (JPEG/PNG/WebP), URL shape, path traversal (upload + static), `.gitignore` coverage |
| Docs | `README.md` ("Local image uploads"), `docs/API_CONTRACT.md` §6, `.env.example` |

New env vars (§6): `UPLOAD_DIR`, `API_BASE_URL`, `UPLOAD_MAX_BYTES`.
New dependency: `multer` (+ `@types/multer`).

**Status after implementation:** `npm run typecheck`, `npm run lint`,
`npm run build` and `npm test` all pass (5 files, **97/97 tests**).

**Credentials (configured locally, 2026-10-09):** `.env` (git-ignored) sets
`GOOGLE_APPLICATION_CREDENTIALS` to the Firebase-Console key
`bistrobuddies-4f179-firebase-adminsdk-*.json` in this folder (also
git-ignored). Verified read-only: ADC access token minted, Firestore read,
`auth.getUser()` read, `GET /api/health` → `firebaseConfigured: true`,
`verifyIdToken` successfully fetches Google's public key set.

**Remaining manual action:** live end-to-end upload as the real admin —
sign in on the admin site (`http://localhost:4200`) and upload one image, or
enable the **IAM Credentials API** for project `12668682749`
(`https://console.developers.google.com/apis/api/iamcredentials.googleapis.com/overview?project=12668682749`)
so an automated custom-token sign-in can be minted. The IAM API is **not**
used by this backend — only `createCustomToken` (test tooling) needs it.
