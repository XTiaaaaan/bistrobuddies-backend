# PROJECT_CONTEXT.md — BistroBuddies Backend (trusted API)

> Originally generated from a read-only audit of an early version of this repository. No application
> code, Firebase settings, or data were changed by that audit, and secrets are intentionally not
> reproduced in this file. Sections §12–§14 are later addenda; **§14 is the current state** (Cloudinary
> image storage + Render deployment). Where an earlier section contradicts an addendum, the addendum wins.

> **Current state at a glance (verified by running the code):** 13 test files / 264 tests pass;
> `npm run typecheck`, `npm run lint`, `npm run build` pass; `node dist/src/server.js` serves
> `GET /api/health` on `PORT`. Images (product + profile) are stored in Cloudinary, not local disk.
> A `render.yaml` Blueprint is included. The in-memory rate limiter is still single-instance only.

---

## 1. What this repository is

**BistroBuddies Backend** — the trusted server-side API for the BistroBuddies system. It performs the
privileged operations that must never be trusted to a browser: order price calculation, admin-authorized
product writes, and (planned) payment/image handling.

| Attribute | Verified value |
|---|---|
| Framework | Express 4 + TypeScript 5.9 (CommonJS) |
| Firebase | `firebase-admin` 13.4.0 (server SDK) |
| Other deps | `cors`, `helmet`, `multer`, `cloudinary`, `serverless-http` |
| Test runner | Vitest 4 (no config file; default glob picks up `*.test.ts`) |
| Package manager | npm (`package-lock.json` lockfileVersion 3) |
| Node engine | `>=20.12` |
| Firebase project | `bistrobuddies-4f179` (default in `src/config.ts`, `.firebaserc`) |
| Git | Branch `BACKEND-BEFORE-DEPLOYMENT` (default branch is `main`), remote `github.com/XTiaaaaan/bistrobuddies-backend` |

**Not present (verified):** no `paymongo` package, no `dotenv` (uses native `process.loadEnvFile`),
no `vercel.json`. A local `.env` and `dist/` build output exist on the development machine but are
**not tracked** (both `.gitignore`d). Image uploads use `multer` + `cloudinary` (see §14).

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
| GET | `/api/health` | `src/routes/health.ts` | public | — |
| GET | `/api/products` | `src/routes/products.ts` | public | 120/min/IP |
| GET | `/api/products/:id` | `src/routes/products.ts` | public | 120/min/IP |
| POST | `/api/orders` | `src/routes/orders.ts` | Bearer (any signed-in user) | 20/min/IP |
| GET | `/api/orders/:id` | `src/routes/orders.ts` | Bearer (owner or admin) | 120/min/IP |
| POST | `/api/orders/:id/cancel` | `src/routes/orders.ts` | Bearer (owner) | 20/min/IP |
| POST | `/api/orders/:id/gcash-details` | `src/routes/orders.ts` | Bearer (owner) | 20/min/IP |
| POST | `/api/orders/:id/payment-proof` (alias `/gcash-proof`) | `src/routes/orders.ts` | Bearer (owner) | 20/min/IP |
| POST | `/api/contact-messages` | `src/routes/contact-messages.ts` | Bearer (any signed-in user) | 10/min/IP |
| GET | `/api/contact-messages/mine` | `src/routes/contact-messages.ts` | Bearer (any signed-in user) | 60/min/IP |
| POST | `/api/admin/products` | `src/routes/admin-products.ts` | Bearer + admin | 60/min/IP |
| PATCH | `/api/admin/products/:id` | `src/routes/admin-products.ts` | Bearer + admin | 60/min/IP |
| DELETE | `/api/admin/products/:id` | `src/routes/admin-products.ts` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/uploads` | `src/routes/admin-uploads.ts` | Bearer + admin | 30/min/IP |
| POST | `/api/profile/photo` | `src/routes/profile-uploads.ts` | Bearer (any signed-in user) | 30/min/IP |
| POST | `/api/admin/orders/:id/status` | `src/routes/admin-orders.ts` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/orders/:id/payment` | `src/routes/admin-orders.ts` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/orders/:id/payment-proof` | `src/routes/admin-orders.ts` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/orders/:id/cod-payment` | `src/routes/admin-orders.ts` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/orders/:id/refund` | `src/routes/admin-orders.ts` | Bearer + admin | 60/min/IP |
| GET | `/api/admin/contact-messages` | `src/routes/admin-contact-messages.ts` | Bearer + admin | 60/min/IP |
| PATCH | `/api/admin/contact-messages/:id/status` | `src/routes/admin-contact-messages.ts` | Bearer + admin | 60/min/IP |
| POST | `/api/admin/contact-messages/:id/replies` | `src/routes/admin-contact-messages.ts` | Bearer + admin | 60/min/IP |
| GET | `/uploads/:file` | `src/app.ts` (`express.static`) | public read | — (legacy files only) |

**Endpoints that DO NOT exist:** `GET /api/admin/orders` (no admin order list),
`GET /api/orders` (no customer order list), any webhook, any real payment
gateway. CORS allows only `GET, POST, PATCH, DELETE, OPTIONS` (`src/app.ts`) —
there are no `PUT` routes. `GET /api/products`/`:id` **do** exist now (<- this
line corrects the original audit). New image uploads go to Cloudinary; see §14.

### POST /api/orders — request/response

Request (`src/lib/validation.ts:185-321`):
```jsonc
{
  "items": [{ "productId": "…", "size": "small|medium|large", "sugar": "…", "quantity": 1 }],
  "customer":  { "name": "…", "phone": "…" },
  "address":   { "recipientName": "…", "phone": "…", "address": "…", "city": "?", "postalCode": "?" },
  "customerComment": "…",
  "paymentMethod": "COD" | "GCASH"
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
paymentMethod: 'COD'|'GCASH', paymentStatus: 'PENDING', orderStatus: 'PENDING',
gcashDetails?{accountName,accountNumber,submittedBy,submittedAt},
paymentProof?{url,publicId,mimeType,size,submittedBy,submittedAt},
paymentDecision?{decision,decidedBy,decidedAt}, paymentAudit[]?,
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
| `PORT` | `3001` | HTTP port (Render injects it automatically) |
| `DELIVERY_FEE` | `0` | Delivery fee in PHP added to every order |
| `FIREBASE_PROJECT_ID` | `bistrobuddies-4f179` | Target Firebase project |
| `GOOGLE_APPLICATION_CREDENTIALS` | *(empty)* | **Path** to service-account JSON (Render: a Secret File path, never a Windows path) |
| `FIREBASE_SERVICE_ACCOUNT` | *(empty)* | **Inline** service-account JSON (alternative to the above; recommended on Render) |
| `ALLOWED_ORIGINS` | localhost:4200/8100/8101, `capacitor://localhost`, `https://localhost` | CORS allowlist — must be set for production |
| `TRUST_PROXY` | `0` | Set `1` behind a proxy (Render/Vercel) so `req.ip` is correct for rate limiting |
| `UPLOAD_DIR` | `uploads` | **Legacy** read-only `GET /uploads/<file>` root only |
| `API_BASE_URL` | `http://localhost:<PORT>` | **Legacy** local-file `imageUrl` base only; Cloudinary returns absolute HTTPS URLs |
| `UPLOAD_MAX_BYTES` | `5242880` (5 MB) | Maximum image upload size |
| `CLOUDINARY_CLOUD_NAME` | *(empty)* | Cloudinary cloud name (server-side only) |
| `CLOUDINARY_API_KEY` | *(empty)* | Cloudinary API key (server-side only) |
| `CLOUDINARY_API_SECRET` | *(empty)* | Cloudinary API secret (server-side only) |

There are **no** `PAYMONGO_*`, `*_BUCKET`, or `VERCEL_*` variables anywhere in the code.
These names are read by `src/config.ts` (the three upload-related names were
added after this audit — see §12).

---

## 7. Build / test / run commands (executed during this audit)

| Script | Command | Result |
|---|---|---|
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` | **PASS** (exit 0) |
| `npm run lint` | `eslint .` | **PASS** (0 problems) |
| `npm test` | `vitest run` | **PASS — 13 files, 264/264 tests, exit 0** |
| `npm run build` | `tsc -p tsconfig.json` | **PASS** (exit 0) → `dist/src/server.js` |
| `npm run dev` | `tsx watch src/server.ts` | not run (requires optional `.env`) |
| `npm start` | `node dist/src/server.js` | **PASS** — verified serving `GET /api/health` (200) |

Tests need no network or credentials (Firebase and Cloudinary are mocked in the test files).

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
| Product CRUD | ✅ **WORKS** | Create/update/delete (admin) plus public reads `GET /api/products[/:id]` (`src/routes/products.ts`) |
| Admin authorization | ✅ **WORKS** | `requireAuth` + `requireAdmin` on all 4 admin routes; 401/403 tested (`src/app.test.ts:337-353,470-475`) |
| Admin order management | ⚠️ **PARTIAL** | Status transition (COD settles to PAID on `COMPLETED`), GCash proof review/payment decisions, legacy COD collection and manual refunds exist; **no admin order list endpoint** |
| Image uploads (Cloudinary) | ✅ **WORKS** | `POST /api/admin/uploads` (admin), `POST /api/profile/photo` (any signed-in user) and GCash `POST /api/orders/:id/payment-proof` (order owner) — multer memory parse, magic-byte type check, 5 MB cap, rate-limited, stored in Cloudinary. See §14, `README.md`, `docs/API_CONTRACT.md` §6 |
| Firebase Storage | ❌ **NOT USED** | Intentional — permanent image hosting is Cloudinary (§14); no `getStorage`/`bucket()` usage |
| PayMongo sandbox + webhook verification | ❌ **MISSING** | Zero matches for `paymongo|webhook|signature|Hmac` in `package.json`, `src/`, `api/`. `paymentMethod: 'GCASH'` is manual verification only (`src/services/orders.service.ts:89`) |
| Secrets server-side | ✅ **WORKS** | No secrets in repo; `.env.example` placeholders empty |
| Vercel deployment readiness | ⚠️ **PARTIAL** | `api/index.ts` serverless wrapper + dual mounting exist; **no `vercel.json`**, self-declared "PREPARED BUT UNVERIFIED" (`api/index.ts:7-10`), never deployed |
| Public product browsing before login | ✅ **WORKS** | Public `GET /api/products[/:id]` via the backend (Admin SDK); the public Firestore read path still depends on `firestore.rules` |
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

## 12. Addendum — local image uploads (historical, superseded by §14)

> **Superseded.** This section describes the original local-disk upload
> implementation. New uploads now go to Cloudinary instead of `UPLOAD_DIR`
> (see §14); the local `uploads/` directory is only served read-only for
> historical files. The validation, route guards and size limits described
> below still hold.

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

---

## 13. Addendum — Contact Us messages (added after this audit)

Implemented in `bistrobuddies-backend` only; nothing was deployed.

| Piece | Where |
|---|---|
| Endpoint | `POST /api/contact-messages` (`src/routes/contact-messages.ts`), guards `[rateLimit 10/min/IP, requireAuth]` — any signed-in customer, matching the app's other customer write endpoints; `userId` from the verified token only |
| Validation | `validateContactMessageRequest` (`src/lib/validation.ts`) — `name` ≤120, `email` ≤254 + format check, `subject` ≤150, `message` ≤2000; all trimmed, empty/whitespace-only rejected with `400 invalid_request` + field details; only these four fields are read |
| Storage | Firestore `contactMessages` (`src/services/contact-messages.service.ts`) — server-generated doc id, `status: 'NEW'`, `createdAt`/`updatedAt` server timestamps; `201 { id, status }` only after the write resolves, `500` on storage failure |
| Firestore rules | New `match /contactMessages/{messageId} { allow read, write: if false; }` — purely restrictive (clients get no access; backend Admin SDK bypasses rules). **Not deployed** |
| Email notifications | **Not configured** — no email provider/dependency exists in the repo; Firestore is the reliable mechanism. Forwarding to `bistrobuddies@gmail.com` is a separate future setup step |
| Tests | `src/contact-messages.test.ts` — success + trimming, ignored client `userId`/`status`/timestamps, missing fields, invalid email, whitespace-only, over-length, 401 missing/invalid token, Firestore failure → `500` (no false success), `503` without credentials, no GET/PATCH/DELETE access, rate limit; plus unit tests in `src/lib/validation.test.ts` |
| Docs | `docs/API_CONTRACT.md` §4 "Contact messages", `README.md` |

No new env vars. Status: `npm run typecheck`, `npm run lint`, `npm run build`
and `npm test` pass (7 files, **149 tests**).

---

## 14. Addendum — current state: Cloudinary storage + Render deployment

> This is the current verified state of the repository on branch
> `BACKEND-BEFORE-DEPLOYMENT`. It supersedes the local-disk storage described
> in §12.

### 14.1 Image storage is Cloudinary (not local disk)

- `POST /api/admin/uploads` (admin) and `POST /api/profile/photo` (any
  signed-in user) parse one `file` field with `multer` (`memoryStorage`) and
  upload the validated buffer to Cloudinary via the official SDK
  (`src/lib/cloudinary.ts`, `src/lib/image-upload.ts`), returning the HTTPS
  `secure_url` as `imageUrl` plus `publicId`.
- Required server-side env vars: `CLOUDINARY_CLOUD_NAME`,
  `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Missing → `503
  server_not_configured`; Cloudinary failure → `500 upload_failed`. There is
  deliberately **no local-disk fallback**.
- The local `uploads/` directory is only served read-only at
  `GET /uploads/<file>` for historical files. **44 files under `uploads/` are
  still tracked in Git** even though `.gitignore` ignores the directory (they
  were committed before the ignore rule). They are obsolete for new uploads
  but not deleted by this change; removal from tracking is a deliberate manual
  step (see README "Legacy tracked uploads").

### 14.2 Render deployment

- `render.yaml` (new) defines a `web` service, `runtime: node`,
  `buildCommand: npm install && npm run build`,
  `startCommand: node dist/src/server.js`, `healthCheckPath: /api/health`,
  `autoDeployTrigger: 'off'`, branch `BACKEND-BEFORE-DEPLOYMENT`.
- `npm run build` emits `dist/src/server.js` (verified); Render injects `PORT`.
- `TRUST_PROXY=1` sets Express `trust proxy` to one hop (Render's proxy) in
  `src/app.ts`; `readBoolean` accepts `1`/`true`.
- `ALLOWED_ORIGINS` is a comma-separated allowlist parsed in `src/config.ts`;
  unset → localhost + Capacitor defaults only, so production origins must be
  set. CORS never reflects arbitrary origins.
- Secrets are supplied as Render env vars / Secret Files. No secrets, no final
  public URL and no local Windows paths are stored in the repository.

### 14.3 Rate limiter (unchanged, documented limitation)

`src/middleware/rate-limit.ts` is a fixed-window counter in an in-memory `Map`
per route group. Correct for a single instance; **not shared** between
instances, so with N instances the effective limit is `limit × N`, and
counters reset on deploy/restart. A shared store (e.g. Render Key Value) is not
added: it would be a new paid dependency and does not affect authentication or
authorization. See README "Rate limiting".

### 14.4 Verified results (this change)

`npm run typecheck` PASS, `npm run lint` PASS (0 problems), `npm test` PASS
(13 files, **264 tests**), `npm run build` PASS, and the compiled
`node dist/src/server.js` served `GET /api/health` with HTTP 200.
