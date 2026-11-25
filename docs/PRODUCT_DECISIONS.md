# Product decisions (keep these)

Decided for LocalMeals launch and near-term roadmap. Do not reverse without an explicit product change.

## Monetization

| Decision | Rule |
|----------|------|
| Customer platform fee | **Admin-set, once per checkout / payment** (Admin → Features → Pricing; seed ₹7, ₹0 on first boot in solo mode; max ₹50) — multi-day week cart = one fee, not per day |
| Cook commission | **Admin-set % of food net** (seed **5%**, max **10%**), optional **per-cook override** (Admin → Cooks). Deducted at EOD settlement (`settlements.fees_paise`) — never added to the customer bill |
| Rate changes | Fee and commission are **snapshotted on each order / booking** (`platform_fee_paise`, `commission_bps`) — changes apply to **new orders only**. Orders placed before the migration keep 0% commission |
| Delivery fee | Platform keeps delivery + platform fee + commission; food − commission → cook at EOD |
| Refund after payout | Recovery (`CLAWBACK_PENDING`) = what the cook was paid for the line (food net − commission) |
| Ads / kitchen boosts | Scaffolded behind `ads_enabled` (**default OFF**). Flat boost packages later — **not** a % of food. Turn on only when pin volume is healthy |

## Trust & reviews (MVP-2)

| Decision | Rule |
|----------|------|
| Public kitchen reviews | **Yes** — customers need trust signals |
| Cook opt-in | **No** — reviews are platform-standard for every LIVE kitchen |
| Who can review | Customer with a **completed paid** order only |
| Cook control | **Reply** allowed; cannot hide the feature or delete reviews |
| Soft launch | Optionally show aggregate only after **N** orders so new kitchens aren’t killed by one bad day |
| MVP-1 | Use FSSAI, photos, menu clarity, “orders this week” — **no** star ratings yet |

## Multi-day / week cart discounts

| Decision | Rule |
|----------|------|
| Idea | Good for customer happiness + week lock-in |
| Who sets it | **Cook-controlled** optional rule (e.g. % off food when ≥ N days) |
| Platform promos | No mega-sale / coupon stack in early versions |
| Cap | Soft max (~15%) so cooks don’t underprice themselves |
| MVP-2 | Cook-controlled week % (cap 15%, min days) — see `docs/MVP2.md` |

## Explicitly out of MVP-1

Shadowfax / partner delivery, IVR, public ratings/reviews, multi-day discount engine → **MVP-2+**.

## Roadmap (town growth)

Full table: [ROADMAP.md](./ROADMAP.md). Placement:

| Theme | When |
|-------|------|
| Pilot: one pin, 5–8 cooks, shareable `/kitchen/:slug` | Now (ops) |
| Cook sold-out toggle, fulfillment toggles, weekly templates, FSSAI enroll help, opt-in lean WA status | **MVP-2** polish |
| Party / bulk catering (MOQ, 48–72h cut-off, 50% advance UPI) | **MVP-3 — built, OFF** (`catering_enabled`) — [MVP3.md](./MVP3.md) |
| Radius / PostGIS, catering RFQ, pantry, tiffin | MVP-3+ |

Do not switch party mode on until the lunch pin is stable. Keep customer WA lean by default (status spam stays opt-in).

### Party / bulk catering rules (locked for the first slice)

- **Fee:** one platform fee per booking (the admin-set value), charged with the advance. The cook commission is snapshotted on the booking; admin pays the cook food − commission (`cookPayoutPaise`).
- **Split:** advance = 50% of food (rounded up) + fee; balance = remaining food, due before the event.
- **Bounds:** MOQ ≥ 10, ≤ 150 plates per booking, cook cut-off 48–72 h, events ≤ 60 days ahead, per-day party-plate cap per kitchen.
- **Cancellation:** customer free before the advance, full refund until the cut-off, support after; cook-cancel = full refund; admin may refund partially.
- **Payout:** manual (admin marks cook paid with UTR) — not part of lunch EOD batches.

## Channels

- Razorpay Payment Links + webhooks; Meta WhatsApp Cloud API
- Lean customer WA (no cooking/packed spam); cook Status anytime
- Flip `MOCK_PAYMENTS` / `MOCK_WHATSAPP` only after public webhooks work
