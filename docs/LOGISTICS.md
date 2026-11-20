# Partner delivery (logistics) guide

How LocalMeals talks to a delivery partner (Shadowfax, Porter, or your own gateway).

**Product rules:** platform flag `partner_delivery_enabled` + cook **Delivery mode = PARTNER**. Customers do not choose the partner — they only choose delivery vs pickup.

## Architecture

```
Cook desk Dispatch
    → API dispatchViaPartner()
    → LogisticsProvider.createShipment()
    → order status ASSIGNING_RIDER (+ partnerShipmentId, partnerTrackingUrl)

Partner webhook / cook “Rider assigned”
    → ASSIGNED / PICKED_UP → DISPATCHED
    → DELIVERED → DELIVERED
    → FAILED → LOGISTICS_EXCEPTION
```

| Piece | Path |
|-------|------|
| Provider interface + HTTP/mock | `packages/adapters/src/logistics.ts` |
| Dispatch + status apply | `apps/api/src/services/partnerLogistics.ts` |
| Webhook | `POST /webhooks/logistics` (`apps/api/src/plugins/logisticsWebhook.ts`) |
| Admin flag + cook mode | Admin → Features / Cooks |
| Cook / customer UI | Desk partner card; confirm “How delivered” |

## Providers

| `LOGISTICS_PROVIDER` / env | Behaviour |
|----------------------------|-----------|
| `MOCK_LOGISTICS=true` (default outside prod) | In-memory mock shipment ids |
| `LOGISTICS_API_BASE_URL` set | **HTTP gateway** (`HttpLogisticsProvider`) |
| Production + no base URL | `unconfigured` (dispatch throws until configured) |

Named values like `shadowfax` / `porter` only set the provider **name**; they still use the same HTTP contract against `LOGISTICS_API_BASE_URL` (usually your thin adapter service that talks to the vendor).

## Environment

```bash
# Local / staging demos
MOCK_LOGISTICS=true

# Real (or staging) partner gateway
MOCK_LOGISTICS=false
LOGISTICS_PROVIDER=shadowfax          # or http | porter
LOGISTICS_API_BASE_URL=https://your-gateway.example.com
LOGISTICS_API_KEY=…                   # Bearer + X-Api-Key
# Optional path overrides (defaults below)
# LOGISTICS_CREATE_PATH=/v1/shipments
# LOGISTICS_GET_PATH=/v1/shipments/{id}
# LOGISTICS_CANCEL_PATH=/v1/shipments/{id}/cancel
# LOGISTICS_API_TIMEOUT_MS=15000
# LOGISTICS_API_EXTRA_HEADERS={"X-Vendor":"shadowfax"}

# Webhook auth (required in production)
LOGISTICS_WEBHOOK_SECRET=…            # also accepted as X-Logistics-Secret
# Optional dedicated HMAC key (defaults to WEBHOOK_SECRET if unset)
# LOGISTICS_WEBHOOK_HMAC_SECRET=…
```

Cloud Run: put secrets in Secret Manager; set repo/env vars in the deploy workflow like other channels. Redeploy **api** (and migrate `0026_partner_tracking_url`) after enabling.

## HTTP gateway contract (what we call)

Your gateway (or vendor API if compatible) must implement:

### `POST /v1/shipments`

Request:

```json
{
  "externalOrderId": "LM-ABC123",
  "pickup": {
    "address": "CSK Homemade Delights, Blue gate, PIN 600119",
    "contactPhone": "+919876543210",
    "lat": null,
    "lng": null
  },
  "drop": {
    "address": "Tower 1, OMR",
    "contactPhone": "+919840111111",
    "lat": null,
    "lng": null
  },
  "notes": "2× Sambar rice",
  "amountPaise": null
}
```

Response:

```json
{
  "shipmentId": "SF-…",
  "status": "CREATED",
  "trackingUrl": "https://…"
}
```

Aliases accepted: `partnerShipmentId` / `id`, `tracking_url`, status aliases (`rider_assigned`, `ofd`, …).

### `GET /v1/shipments/{id}`

Same response shape.

### `POST /v1/shipments/{id}/cancel`

```json
{ "reason": "cancelled_by_platform" }
```

## Webhook: `POST /webhooks/logistics`

Public HTTPS URL on the API, e.g. `https://<api>/webhooks/logistics`.

### Auth (production)

1. Header `X-Logistics-Secret: <LOGISTICS_WEBHOOK_SECRET>` **or**
2. Header `X-Logistics-Signature: <hex hmac-sha256 of raw body>` using `LOGISTICS_WEBHOOK_HMAC_SECRET` (or the shared secret).

### Body (either style)

LocalMeals:

```json
{ "partnerShipmentId": "SF-…", "status": "ASSIGNED" }
```

Vendor-ish aliases:

```json
{ "shipment_id": "SF-…", "event": "picked_up" }
```

Statuses we understand: `CREATED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED`, `FAILED` (+ aliases in `mapPartnerShipmentStatus`).

### Curl smoke

```bash
curl -sS -X POST "$API_URL/webhooks/logistics" \
  -H "Content-Type: application/json" \
  -H "X-Logistics-Secret: $LOGISTICS_WEBHOOK_SECRET" \
  -d '{"partnerShipmentId":"shp_mock_demo","status":"ASSIGNED"}'
```

## Enable in product (checklist)

1. Migrate: `0026_partner_tracking_url` (+ `0024` if needed).  
2. Admin → Features → **Partner delivery** ON.  
3. Admin → Cooks → kitchen **Delivery mode = Partner rider**.  
4. Set env: mock **or** `LOGISTICS_API_BASE_URL` + webhook secret.  
5. Redeploy API.  
6. Paid **delivery** order → Pack → Dispatch → **Finding rider**.  
7. Vendor webhook (or cook **Rider assigned**) → on the way → Delivered.

## Wiring a real vendor (Shadowfax / Porter)

LocalMeals does **not** call vendor JSON shapes directly. Prefer a **thin gateway** that translates vendor APIs ↔ the `/v1/shipments` contract above (keeps `HttpLogisticsProvider` stable when the vendor changes). Webhooks should be normalized into `POST /webhooks/logistics` (+ secret/HMAC).

Public Shadowfax docs do **not** list a setup/API-access fee. Staging credentials come by email; staging orders do not trigger real pickups. You pay on **live** deliveries under commercial rates (not published on the developer site).

### Shadowfax Hyperlocal Marketplace — step by step

Official: [Onboarding](https://developer.shadowfax.in/docs/hyperlocal/marketplace/onboarding) · [Quickstart](https://developer.shadowfax.in/docs/hyperlocal/marketplace/quickstart) · [FAQ](https://developer.shadowfax.in/docs/hyperlocal/marketplace/faq)

#### Phase A — Get into onboarding

1. Open the Hyperlocal Marketplace onboarding docs (link above).
2. Trigger the credential email through your Shadowfax partner channel (SFX 360 / integration POC / existing commercial relationship). There is **no** self-serve “Create API key” on the developer site; docs assume the email pipeline.
3. Wait for the **automated email**: staging credentials, Postman collection, docs links.
4. Save from the email:
   - API token **and/or** `client_id` + `client_secret`
   - Staging base URL: `https://hlbackend.staging.shadowfax.in`
   - Any `client_code` they assign

Onboarding does **not** say “contact sales.” Credentials are shared by Shadowfax via automated email / their team. How you enter that pipeline is outside the public docs.

#### Phase B — Prove staging (Postman only)

No LocalMeals changes yet — use their collection / Quickstart:

1. **Auth** — either:
   - `Authorization: Token <api_token>`, or
   - OAuth: `POST /oauth/token/` with `client_id`, `client_secret`, `grant_type=client_credentials` → `Authorization: Bearer <access_token>` (24h).
2. **Serviceability** — `PUT /api/v1/order-serviceability/` with pickup/drop lat-lng for your pin.
3. **Place order** — `POST /api/v2/orders/` within a couple of minutes of a successful serviceability check. Save `sfx_order_id`.
4. **Status** — `GET /api/v2/orders/{sfx_order_id}/status/`.
5. **Callbacks (optional in staging)** — share a staging callback URL with Shadowfax; use Sandbox Testing APIs to simulate status transitions and verify your handler.

#### Phase C — Build the thin gateway

| LocalMeals calls | Gateway does |
|------------------|--------------|
| `POST /v1/shipments` | Map pickup/drop → Shadowfax place-order; return `{ shipmentId, status, trackingUrl }` |
| `GET /v1/shipments/{id}` | Shadowfax get status → our status enum |
| `POST /v1/shipments/{id}/cancel` | Shadowfax cancel |
| Receives Shadowfax callbacks | Forward to LocalMeals `POST /webhooks/logistics` with normalized status + secret/HMAC |

Suggested status map: allotted/assigned → `ASSIGNED`; arrived/picked → `PICKED_UP`; delivered → `DELIVERED`; failed/cancelled → `FAILED`.

#### Phase D — Wire LocalMeals (staging)

1. Migrate DB if needed (`0026_partner_tracking_url`).
2. Set API env (staging Cloud Run / local):

```bash
MOCK_LOGISTICS=false
LOGISTICS_PROVIDER=shadowfax
LOGISTICS_API_BASE_URL=https://your-gateway.example.com
LOGISTICS_API_KEY=<gateway-key-if-any>
LOGISTICS_WEBHOOK_SECRET=<long-random>
```

3. Redeploy **api**.
4. Admin → Features → **Partner delivery** ON.
5. Admin → Cooks → one pilot kitchen → **Delivery mode = Partner rider**.
6. Place a paid **delivery** order → Pack → Dispatch → expect **Finding rider** + `partnerShipmentId`.
7. Fire a test webhook (or real callback via gateway):

```bash
curl -sS -X POST "$API_URL/webhooks/logistics" \
  -H "Content-Type: application/json" \
  -H "X-Logistics-Secret: $LOGISTICS_WEBHOOK_SECRET" \
  -d '{"partnerShipmentId":"<id-from-dispatch>","status":"ASSIGNED"}'
```

Confirm: createShipment → `ASSIGNING_RIDER`; webhook `ASSIGNED` → `DISPATCHED`; `DELIVERED` → `DELIVERED`; `FAILED` → `LOGISTICS_EXCEPTION`.

Until the gateway exists, keep `MOCK_LOGISTICS=true`; cook **Rider assigned** covers ops without a vendor.

#### Phase E — Production

1. Finish staging checklist with Shadowfax.
2. Ask them for **production credentials**.
3. Share with Shadowfax:
   - Callback URL(s) for order status (+ rider location if separate)
   - Custom headers / HTTP method preference (`POST` or `PUT`)
   - **IP whitelist** for production API access
4. Point gateway at production base `https://api.shadowfax.in` with prod keys.
5. Update LocalMeals prod secrets (`LOGISTICS_*`, webhook secret) and redeploy **api**.
6. Smoke one live order on a single PARTNER cook in one pin, then expand.

### Porter (backup partner) — step by step

Use Porter when Shadowfax is delayed, unavailable in a pin, or you want a second carrier behind the same LocalMeals gateway. Same architecture: **thin gateway** ↔ LocalMeals `/v1/shipments`; swap only the vendor client + `LOGISTICS_PROVIDER=porter`.

**Fit for LocalMeals lunch pin**

| Topic | What we know publicly |
|-------|------------------------|
| Product | Porter Enterprise / API integrations — on-demand **2-wheeler** hyperlocal (API is 2W-only today; other vehicles later) |
| Coverage | App ~21+ cities (incl. **Chennai**); API advertised across fewer cities (~16) — confirm your pin with Porter before promising PARTNER |
| Auth / keys | **Not self-serve.** Enterprise account + API key from Porter’s team / relationship manager |
| Ops model | Prepaid wallet on Enterprise; webhooks + live tracking + transport auth |
| Contact | [porter.in/api-integrations](https://porter.in/api-integrations) · [porter.in/enterprise](https://porter.in/enterprise) · `help@porter.in` / `help@theporter.in` · `+91 80 4410 4410` |

Third-party summaries (ClickPost / community SDKs) describe quote → create → track → cancel against `https://api.porter.in` with an `APIKey`. Treat those as hints until Porter emails you official docs/Postman — **do not hardcode paths from unofficial SDKs into production**.

#### Phase A — Enterprise + API access

1. Request **Porter Enterprise** (they quote ~**1 business day** to activate).
2. Ask explicitly for **API / HLD integration** (2-wheeler): sandbox or staging credentials, Postman/OpenAPI, webhook event list, city/pin serviceability rules.
3. Save: `APIKey` (or equivalent), base URL(s), webhook signing details, wallet / billing contact.
4. Confirm your pilot kitchen address is inside **API** coverage (not only app coverage).

#### Phase B — Prove API (outside LocalMeals)

With Porter’s collection / docs:

1. **Auth** — API key header as they specify (often `APIKey` / Bearer — follow their email).
2. **Quote / serviceability** — fare or can-serve check for kitchen → customer lat-lng (lunch-window distances).
3. **Create order** — unique `request_id` / external id = LocalMeals order code later; save Porter order id.
4. **Track** — poll status; note tracking URL if returned.
5. **Cancel** — cancel a test order.
6. **Webhooks** — register a staging URL; confirm events (third parties mention Accepted / Live / Ended / Cancelled — use Porter’s real enum).

#### Phase C — Gateway mapping

| LocalMeals | Porter gateway |
|------------|----------------|
| `POST /v1/shipments` | Quote (optional) → create order; return `{ shipmentId, status, trackingUrl }` |
| `GET /v1/shipments/{id}` | Track → map to `CREATED` / `ASSIGNED` / `PICKED_UP` / `DELIVERED` / `FAILED` |
| `POST /v1/shipments/{id}/cancel` | Porter cancel |
| Porter webhooks | Normalize → `POST /webhooks/logistics` + secret/HMAC |

Suggested map (adjust to Porter’s real statuses): accepted/allotted → `ASSIGNED`; live/picked/out-for-delivery → `PICKED_UP`; ended/completed → `DELIVERED`; cancelled/failed → `FAILED`.

#### Phase D — Wire LocalMeals (staging)

Same as Shadowfax Phase D, with:

```bash
MOCK_LOGISTICS=false
LOGISTICS_PROVIDER=porter
LOGISTICS_API_BASE_URL=https://your-gateway.example.com
LOGISTICS_API_KEY=<gateway-key-if-any>
LOGISTICS_WEBHOOK_SECRET=<long-random>
```

One PARTNER cook → Pack → Dispatch → webhook smoke → confirm state machine.

#### Phase E — Production

1. Porter enables prod API after staging sign-off (and wallet funded if required).
2. Point gateway at prod base URL + prod key; share prod callback URL.
3. Update LocalMeals prod `LOGISTICS_*`; redeploy **api**.
4. One live smoke order in one pin, then expand.

**Fallback while API is pending:** book riders manually in the Porter app / Enterprise dashboard; cook desk **Rider assigned** keeps LocalMeals moving.

### Borzo (optional third option — public test API)

If you want a partner with **published** Business API docs and a self-serve test cabinet: [Borzo Business API (India)](https://borzodelivery.com/in/business-api/doc).

1. Register at `apitest.borzodelivery.com` (SMS issues → `api.in@borzodelivery.com`).
2. Test base: `https://robotapitest-in.borzodelivery.com/api/business/1.8` — header `X-DV-Auth-Token` from personal cabinet.
3. Methods: `calculate-order` → `create-order` → track / cancel; notifications for status changes.
4. After test works, email `api.in@borzodelivery.com` for production (`https://robot-in.borzodelivery.com/api/business/1.8`).
5. Same thin gateway ↔ LocalMeals contract; `LOGISTICS_PROVIDER=borzo` (name only — still HTTP against your gateway).

Confirm Borzo covers your pin and lunch SLA before treating it as a primary backup. Prefer **Porter** first as the named LocalMeals MVP-2 alternative to Shadowfax.

### Multi-vendor ops note

Gateway can route by pin/cook later; LocalMeals stays on one `LOGISTICS_API_BASE_URL`. Until then, pick **one** live vendor per environment.

## Ops notes

- Pickup orders never create partner shipments.  
- Cook **Rider assigned** is for mock/ops when the vendor webhook is late.  
- Failed partner runs → `LOGISTICS_EXCEPTION` (refund / admin ticket as today).  
- Tracking URL is stored on `orders.partner_tracking_url` when the vendor returns one.

## Related

- [MVP2.md](./MVP2.md) — feature status  
- [ROADMAP.md](./ROADMAP.md) — town logistics  
- [API.md](./API.md) — route list  
- [RUNBOOK.md](./RUNBOOK.md) — incidents  
