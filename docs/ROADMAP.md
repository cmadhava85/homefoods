# LocalMeals roadmap

Living product roadmap. Locked rules stay in [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md). Shipped MVP-2 slices: [MVP2.md](./MVP2.md). Party/bulk detail: [MVP3.md](./MVP3.md).

## Pilot launch (first town — ops + light product)

| Item | Intent | Status |
|------|--------|--------|
| One pin / apartment cluster | Start with one active residential area; onboard **5–8** reliable home cooks before expanding | **In play** — pin focus `600119` |
| Personal share links | Each cook gets a public kitchen URL to share on WA Status / apartment groups | **Done** — `/kitchen/:slug` (+ desk `/cook/:slug`) |
| FSSAI stays mandatory | Trust signal for LIVE kitchens | **Done** — LIVE gate |
| FSSAI enroll help | Guide / assisted path for ₹100 basic registration on “Want to enroll as a cook” | **Done** — `/cook/onboard` FoSCoS checklist |

## MVP-2 — cook desk + town logistics (next build)

Builds on lunch/week cart. Prefer toggles and reuse of pickup / SELF / partner scaffold.

### Simplify cook desk (busy homemakers)

| Item | Status |
|------|--------|
| One-tap weekly / party templates | **Done** — named `cook_menu_templates` (party packs still MVP-3) |
| Instant sold-out / pause toggle | **Done** — desk intake pause for today |
| FSSAI onboarding help | **Done** — FoSCoS checklist on `/cook/onboard` |

### Town logistics without full-time riders

| Item | Status |
|------|--------|
| Keep hyper-local pin rules | Stay inside current pin / ~2–3 km neighbour trust; radius search only when volume needs it |
| Cook fulfillment toggles | **Done** — cook delivery · pickup · customer arranges (+ partner scaffold) |
| Lean WA status (opt-in) | **Done** — Admin flag + My orders opt-in; Cooking / Ready pings |

### Already shipped (do not rebuild)

Kitchen pickup, SELF Maps delivery, partner delivery **scaffold**, saved plates library, week discount, reviews, Child Pays, post–cut-off cancel.

## MVP-3 — party & bulk catering

Higher-margin small functions (≈20–100 plates). See [MVP3.md](./MVP3.md). **First slice built and dark-launched** behind `catering_enabled` (OFF).

| Item | Notes |
|------|--------|
| Catering combos + MOQ | Cook-defined packs (e.g. Seemantham Feast, Birthday Mini Tiffin) with min plates (15/20+) |
| 48–72h advance cut-off | Longer booking window for bulk veg / leaves / packaging |
| 50% advance + 50% balance UPI | Lock date with half pay; reminder link for balance on delivery day |
| Catering RFQ (optional later) | Quote/request flow if fixed combos are not enough |
| Radius / PostGIS discovery | When multi-pin or true distance filter is needed |

## Ads & kitchen boosts (scaffolded, OFF)

| Item | Notes | Status |
|------|--------|--------|
| `ads_enabled` flag | Kill switch — default **OFF** (Admin → Features) | **Done** |
| `ad_campaigns` | KITCHEN_BOOST + EXTERNAL per pin; Discover sponsored badge + external strip | **Done** (gated) |
| Cook boost request | Desk creates DRAFT; admin activates | **Done** (gated) |
| Monetization | Flat / package pricing later — **not** a % of food | Later when pin volume is healthy |

Turn on only after the lunch pin has steady supply. Until then leave `ads_enabled` off.

## Explicitly later / not near-term

- Pantry shipping, steel tiffin loop  
- Full-time rider fleet / city-wide dark-store ops  
- Cook platform surcharge before pin has healthy supply  
- Live ads / kitchen boosts (code ready; flag off)

## Suggested build order

1. ~~Cook sold-out / pause-today toggle~~  
2. ~~Fulfillment toggles~~  
3. ~~Named weekly templates~~  
4. ~~FSSAI enroll help~~  
5. ~~Opt-in lean WA status~~  
6. Party mode (MOQ + long cut-off + split UPI) when lunch pin is stable — [MVP3.md](./MVP3.md)  
