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
`GET /api/products*` 120/min; `/api/admin/*` 60/min; `POST /api/admin/uploads`
30/min. Rate-limited responses are `429` with a `Retry-After` header.

---

## 2. Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status, service, firebaseConfigured, timestamp }` |
| GET | `/api/products` | — (public) | Catalog list, newest first |
| GET | `/api/products/:id` | — (public) | Single product or `404 product_not_found` |
| POST | `/api/orders` | Bearer (any signed-in user) | Creates an order; prices computed server-side |
| GET | `/api/orders/:id` | Bearer (owner or admin) | Others get `404 order_not_found` (no id probing) |
| POST | `/api/admin/products` | Bearer (admin) | Create product → `201 { id }` |
| PATCH | `/api/admin/products/:id` | Bearer (admin) | Partial update → `{ id }` |
| DELETE | `/api/admin/products/:id` | Bearer (admin) | Delete → `{ id }` |
| POST | `/api/admin/uploads` | Bearer (admin) | Store a product image on the local disk → `201 { imageUrl, … }` (§6, development only) |
| POST | `/api/admin/orders/:id/status` | Bearer (admin) | Status transition → `{ id, orderStatus }` |

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
  "paymentMethod": "COD" | "ONLINE"
}
```

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
`paymentStatus`, `orderStatus`, `createdAt`, `updatedAt`.
Historical orders are returned **exactly as stored** — prices are never
recomputed or rewritten.

### Status graph (admin only)

`PENDING → CONFIRMED → PREPARING → READY → COMPLETED`; `CANCELLED` reachable
from every non-terminal state. Re-sending the current status is an
idempotent no-op; anything else → `400 invalid_status_transition`.

---

## 5. Firestore access for clients

| Collection | Client reads | Client writes |
| --- | --- | --- |
| `products` | **anyone** (public catalog) | none — use `/api/admin/products` |
| `users/{uid}` | self or admin | self (role preserved), or use the API |
| `orders` | own orders or admin | **denied** — create only via `POST /api/orders`; status changes admin-only via the API |
| `payments` | own or admin | **denied** — backend-managed (PayMongo not yet implemented) |

Only `products` is publicly readable; `users`, `orders` and `payments` stay
private. The Admin SDK (backend) bypasses these rules, which is how the API
creates orders and products. **Deploy `firestore.rules` with the Firebase CLI
against `bistrobuddies-4f179` — this repository does not deploy anything.**

---

## 6. Image uploads (local development only)

> ⚠️ **Development only — not production storage.** Files are written to this
> machine's disk in `UPLOAD_DIR` (default `uploads/`, git-ignored) and served
> by the local backend. Local disk is not persistent, not backed up and not
> shared between instances (a restart or redeploy can lose it); **do not rely
> on it outside local development.** The production path is Firebase Storage,
> which is **not implemented** in this repository.

### POST /api/admin/uploads

| Topic | Rule |
| --- | --- |
| Auth | `Authorization: Bearer <admin ID token>` — `401 unauthorized` without/with a bad token, `403 forbidden` for non-admin users |
| Content type | `multipart/form-data` with exactly **one** file field named `file` |
| Accepted images | **JPEG, PNG, WebP** — verified from the file's magic bytes, never from the client's file name or `Content-Type` → otherwise `415 unsupported_media_type` |
| Size limit | `UPLOAD_MAX_BYTES`, default **5 MB** (5 242 880 bytes) → `413 file_too_large` |
| Other fields | none accepted → `400 invalid_request` |
| Missing/empty file | `400 invalid_request` |
| Rate limit | 30 requests/min/IP → `429 rate_limited` |
| Missing server credentials | `503 server_not_configured` |

**Request** (admin site, `environment.apiBaseUrl` = `http://localhost:3001/api`):

```ts
const form = new FormData();
form.append('file', file, file.name); // field name must be "file"

const response = await fetch(`${environment.apiBaseUrl}/admin/uploads`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await admin.getIdToken()}` },
  body: form, // browser sets multipart/form-data + boundary
});
const { imageUrl } = await response.json(); // 201
```

```bash
curl -X POST http://localhost:3001/api/admin/uploads \
  -H "Authorization: Bearer $ID_TOKEN" \
  -F "file=@./latte.png"
```

**Response `201`:**

```json
{
  "imageUrl": "http://localhost:3001/uploads/1760000000000-8f14e45f-ea3b-4d2f-9c1a-2b3c4d5e6f70.png",
  "path": "/uploads/1760000000000-8f14e45f-ea3b-4d2f-9c1a-2b3c4d5e6f70.png",
  "fileName": "1760000000000-8f14e45f-ea3b-4d2f-9c1a-2b3c4d5e6f70.png",
  "mimeType": "image/png",
  "size": 48213,
  "uploadedAt": "2026-10-09T12:00:00.000Z"
}
```

**Error codes:** `400 invalid_request`, `401 unauthorized`, `403 forbidden`,
`413 file_too_large`, `415 unsupported_media_type`, `429 rate_limited`,
`503 server_not_configured`.

### Image URL behaviour

- `imageUrl` is **absolute**, built from `API_BASE_URL` (default
  `http://localhost:<PORT>`) so frontends on other origins
  (`http://localhost:4200`, `http://localhost:8100`, Capacitor) can put it
  straight into `<img src>`; `path` is the backend-relative form of the same
  file.
- Files are served read-only by **`GET /uploads/<fileName>`** — no directory
  listing, no writes, `Cache-Control: max-age=3600`, and
  `Cross-Origin-Resource-Policy: cross-origin` so cross-origin `<img>` tags
  are not blocked. Unknown names return `404 not_found`; `..`/encoded path
  traversal is rejected by the static handler.
- File names are generated **server-side** as `<epochMs>-<uuid>.<ext>`; the
  client's file name is discarded, so no path from the client ever reaches
  the filesystem. The extension comes from the detected image type.
- Reads need no authentication (matching the public product catalog); writes
  are admin-only.

### Storing the URL in Firestore

The upload endpoint writes **nothing** to Firestore. Take the returned
`imageUrl` and send it with the product write — `POST /api/admin/products`
or `PATCH /api/admin/products/:id` with `{ "imageUrl": "http://localhost:3001/uploads/…" }`.
Only that URL string plus the product metadata are stored on `products/{id}`;
**the image bytes and any base64 representation are never written to
Firestore.**

---

## 7. Not implemented (out of scope)

- **Firebase Storage / cloud image hosting** — the upload endpoint above is
  local-disk only and must be replaced by Firebase Storage before production
  use.
- PayMongo payments (no payment endpoint/webhook; `paymentMethod: "ONLINE"`
  is stored but inert; `paymentStatus` only changes through admin status
  updates).
- Admin order list endpoint (`GET /api/admin/orders` does not exist; use
  Firestore reads, which are admin-allowed, until it does).
