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
| Shadowfax / partner delivery | **Scaffolded** — `ASSIGNING_RIDER`, `orders.partner_shipment_id`, flag `partner_delivery_enabled` (default OFF), mock provider (`MOCK_LOGISTICS`), `POST /webhooks/logistics`. Real Shadowfax adapter still needs vendor contract |
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
- Food only — delivery + ₹7 platform fee never discounted; no coupon stacks
- Platform fee is **₹7 once per week checkout** (stored on the earliest day-line); delivery still per day
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
- Cart: food / delivery / ₹7 fee once per checkout
- Admin: unpaid &gt;1 day highlight

## Admin feature toggles

Migration `0012_feature_flags.sql` · Admin → **Features**.

Kill switches: ordering, late orders, Child Pays, week discount, reviews, WA outbound, kitchen follow, EOD.

See [PENDING.md](./PENDING.md) for full backlog.

## Partner delivery (how to try locally)

1. Migrate through `0024_partner_delivery`  
2. Admin → Features → enable **Partner delivery**  
3. Set cook `delivery_type = PARTNER` (DB or Admin cooks tooling)  
4. Keep `MOCK_LOGISTICS` unset/true → dispatch creates `shp_mock_…` and moves PACKED → ASSIGNING_RIDER → DISPATCHED  
5. Webhook: `POST /webhooks/logistics` `{ partnerShipmentId, status }` (+ `X-Logistics-Secret` when set)

## Next recommended

1. Migrate Cloud SQL through latest (`0024+`) and deploy api/web/worker  
2. Turn on Admin → Features `pickup_enabled` when cooks have landmarks  
3. Wire real Shadowfax (or Porter) behind `LogisticsProvider` when contracted; then IVR after volume
 
