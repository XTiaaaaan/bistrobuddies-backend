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
| Errors | `{ "error": { "code": "…", "message": "…", "details?": … } }` with status 400/401/403/404/409/413/422/429/500/503 |
| Currency | **PHP only.** Every price/amount field is returned with `currency: "PHP"` |
| Prices | Clients **never** send prices. Totals are computed server-side from Firestore product records |

Rate limits (per IP, fixed window): `POST /api/orders` 20/min;
`GET /api/products*` 120/min; `/api/admin/*` 60/min. Rate-limited responses
are `429` with a `Retry-After` header.

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
  "price": 119,              // canonical PHP list price (derived from the size tiers)
  "currency": "PHP",         // always "PHP" — clients format it as ₱
  "available": true,
  "createdAt": "2026-10-09T12:00:00.000Z",  // null when never set
  "updatedAt": "2026-10-09T12:00:00.000Z",
  // Size-tiered prices kept for the existing size selector / cart logic:
  "smallPrice": 99,
  "mediumPrice": 119,
  "largePrice": 139,
  "sugarOptions": ["No Sugar", "Less Sugar", "Regular", "Extra Sugar"],
  "cloudinaryPublicId": ""   // legacy, unused
}
```

### Write payloads (admin API)

- **Create** (`POST`): `name`, `category`, `description`, `imageUrl`,
  `sugarOptions`, `available` required as before, **plus price input — either**
  the canonical `price` **or** all three size prices (`smallPrice`,
  `mediumPrice`, `largePrice`). Sending `price` alone makes the server
  backfill all three tiers with that amount (flat pricing).
- **Update** (`PATCH`): any subset of the same fields + `price`.
  - size tier(s) provided → canonical `price` is re-derived
    (medium → small → large),
  - only `price` provided → all three tiers are backfilled to it,
  - `currency` is **never** accepted from clients (server always writes `PHP`).
- Legacy documents without `price` are normalized (`price` + `currency`
  written back) the first time they are edited. **No migration is run and no
  stored product or historical order is rewritten by reads.**

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

## 6. Not implemented (out of scope)

- Image uploads (no upload endpoint, no multipart parsing, no storage bucket).
- PayMongo payments (no payment endpoint/webhook; `paymentMethod: "ONLINE"`
  is stored but inert; `paymentStatus` only changes through admin status
  updates).
- Admin order list endpoint (`GET /api/admin/orders` does not exist; use
  Firestore reads, which are admin-allowed, until it does).
