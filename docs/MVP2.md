# MVP-2

Product scope from [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md) and [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md).

## In progress / shipped in repo

| Slice | Status |
|-------|--------|
| **Public kitchen reviews** | **Complete** — web + WA `Review LM-… 5 …`; cook desk reply/edit; soft-launch ★ after 3 |
| **Week discount engine** | **Complete** — cook settings + web cart + WA week preview/checkout messaging |
| **Kitchen pickup** | **Complete** — cook desk + customer web (instant/late/week) + WA `… PICKUP`; Admin flag default OFF |
| **Child Pays** | **Complete** — `/family` web + WA `Family` / `Accept family` + `PAY <mobile>` on Order/Week/Late |
| **Post–cut-off cancel request** | **Complete** — paid order after cut-off → `CANCEL_REQUESTED`; cook Accept (full refund) / Decline (back to `PAID`); WA + desk |
| **Cook WA menu post** | **Complete** — `Add <dish> <₹> [nonveg]` + optional photo; `My menu`; desk remains fallback |
| Shadowfax / partner delivery | **Mock + HTTP provider** — Admin flag + cook PARTNER mode; desk/customer UI; `HttpLogisticsProvider` via `LOGISTICS_API_BASE_URL`; webhook HMAC/secret. Thin gateway — [Shadowfax](./LOGISTICS.md#shadowfax-hyperlocal-marketplace--step-by-step) · backup [Porter](./LOGISTICS.md#porter-backup-partner--step-by-step) |
| IVR (Exotel/Twilio) | Adapter stub only (`packages/adapters/src/ivr.ts`) — needs vendor |

## Reviews behaviour

- Eligibility: customer who owns the order; status `DELIVERED`; one review per order
- Soft launch: discover/kitchen hide ★ average until `REVIEW_PUBLIC_MIN_COUNT` (3)
- Cook desk → **Reviews** tab: see all, reply once (updates allowed by re-posting overwrites)
- Migration: `packages/db/drizzle/0010_reviews_mvp2.sql`

## Child Pays

1. Senior → **Family** → invite payer mobile → payer accepts  
2. Kitchen cart → **Who pays?** → family number  
3. Pay link / WA goes to payer; senior sees waiting-for-family  
4. Requires `ACTIVE` row in `family_links`

## Week discount

- Cook desk → Menu & settings → **Week cart discount** (`PATCH /cooks/:slug/week-discount`)
- Applies only on week cart (`/orders/batch`) when day count ≥ min days
- Food only — delivery + platform fee never discounted; no coupon stacks
- Platform fee (admin-set) is charged **once per week checkout** (stored on the earliest day-line); delivery still per day
- On pay: cook/customer WA per day-line with service date + day N of M (`formatOrderPaidCookWa` / domain)
- Migration: `0011_week_discount.sql`

## Status vocabulary

| Status | Meaning |
|--------|---------|
| `PENDING_APPROVAL` | **Late request only** — waiting for cook accept/decline (not Child Pays) |
| `AWAITING_PAYMENT` + `payerMobile` | **Child Pays** — family settles UPI |
| `AWAITING_PAYMENT` (no payer) | Customer pays themselves |
| `AWAITING_MANUAL_PAY` (settlement) | EOD batch ready for Admin UPI Mark paid |

## Launch polish (in repo)

- LIVE gate: FSSAI + UPI/bank note (Route optional)
- Discover: pin confirm + menu cover photo + plates this week
- WA: review nudge on DELIVERED; family invite notify
- Cart: food / delivery / platform fee once per checkout
- Admin: unpaid &gt;1 day highlight

## Admin feature toggles

Migration `0012_feature_flags.sql` · Admin → **Features**.

Kill switches: ordering, late orders, Child Pays, week discount, reviews, WA outbound, kitchen follow, EOD.

See [PENDING.md](./PENDING.md) for full backlog.

## Partner delivery (how to try locally)

Full guide: [LOGISTICS.md](./LOGISTICS.md).

1. Migrate through `0024_partner_delivery` + `0026_partner_tracking_url`  
2. Admin → Features → enable **Partner delivery**  
3. Admin → Cooks → **Delivery mode** = Partner rider → Save  
4. Cook desk → Pack → **Dispatched** → order shows **Finding rider** + shipment id  
5. Cook taps **Rider assigned** (or `POST /webhooks/logistics`) → on the way  
6. Customer: order confirmed / My orders shows partner logistics card  
7. Local: `MOCK_LOGISTICS=true`. Real: `MOCK_LOGISTICS=false` + `LOGISTICS_API_BASE_URL` + webhook secret  


## Cook desk polish (shipped)

| Slice | Notes |
|-------|--------|
| Pause today’s intake | Desk green/red toggle → `PATCH /cooks/:slug/intake-pause`; date-scoped; auto-clears next day |
| Fulfillment offers | Cook delivery · pickup · customer arranges (`PATCH /cooks/:slug/fulfillment`); checkout modes `DELIVERY` / `PICKUP` / `CUSTOMER_ARRANGE` |
| Named meal plans | `cook_menu_templates` + desk one-tap post (`/cooks/:slug/menu-templates`) |
| FSSAI enroll help | Checklist + FoSCoS link on `/cook/onboard` |
| Lean WA status (opt-in) | Admin flag `lean_wa_status_enabled` (default OFF) + My orders preference; COOKING / Ready pings only when opted in |

Migration: `0027_mvp2_polish.sql`.

## Next recommended

1. Deploy api/web/worker with polish + migrate `0027`  
2. Turn on Admin → Features `pickup_enabled` / `lean_wa_status_enabled` when ready  
3. Wire real Shadowfax (or Porter) behind `LogisticsProvider` when contracted; then IVR after volume  
4. **MVP-3** party / bulk catering when lunch pin is stable — [MVP3.md](./MVP3.md)
 
