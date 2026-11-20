# Product decisions (keep these)

Decided for LocalMeals launch and near-term roadmap. Do not reverse without an explicit product change.

## Monetization

| Decision | Rule |
|----------|------|
| Customer platform fee | **₹7 once per checkout / payment** (`PLATFORM_FEE_PAISE=700`) — multi-day week cart = one ₹7, not per day |
| Cook take at launch | **100% of food** — no cook surcharge / % fee in MVP-1 |
| Delivery fee | Platform keeps delivery + platform fee; food → cook at EOD |
| Later cook monetization | Only after pin has volume: small % of food, weekly listing fee, or payout fee — never block supply at launch |

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
| Party / bulk catering (MOQ, 48–72h cut-off, 50% advance UPI) | **MVP-3** — [MVP3.md](./MVP3.md) |
| Radius / PostGIS, catering RFQ, pantry, tiffin | MVP-3+ |

Do not start party mode until the lunch pin is stable. Keep customer WA lean by default (status spam stays opt-in).

## Channels

- Razorpay Payment Links + webhooks; Meta WhatsApp Cloud API
- Lean customer WA (no cooking/packed spam); cook Status anytime
- Flip `MOCK_PAYMENTS` / `MOCK_WHATSAPP` only after public webhooks work
