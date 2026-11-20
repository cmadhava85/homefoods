# MVP-3 — Party & bulk catering

Source: homemaker / tier-2 town growth ideas. Parent roadmap: [ROADMAP.md](./ROADMAP.md).

**Do not start** until the lunch pin has stable cooks, cut-offs, and payouts. MVP-3 is additive — lunch/week cart stays the default mode.

## Goals

- Let LIVE kitchens sell **small function** plates (≈20–100) at better margins than daily lunch boxes  
- Give cooks time to source bulk ingredients and packaging  
- Reduce pay friction on large tickets (₹10k-class) with a two-step UPI flow  

## Product shape

### Catering mode (cook desk)

- New mode or menu type: **Party / bulk** (alongside lunch day + week)  
- Cook creates **combos** with name, plate contents, **per-plate price**, **MOQ** (e.g. 15 or 20)  
- Examples: Seemantham Feast, Birthday Mini Tiffin, Housewarming Breakfast  
- Customer picks combo + plate count ≥ MOQ + event date  

### Cut-offs

- Default catering cut-off **48–72 hours** before event (cook-configurable within platform bounds)  
- Separate from daily lunch cut-off  

### Payments

- **50% advance** Payment Link to lock the date  
- **50% balance** Payment Link (or reminder) for delivery / pickup day  
- Platform fee: decide at build time (likely still one ₹7 per *payment*, or a single checkout fee — document in PRODUCT_DECISIONS when implementing)  
- Cook food share: keep **100% of food** until monetization policy changes  

### Fulfillment

- Reuse MVP-2 fulfillment toggles: pickup, cook’s own delivery, customer-arranges auto  
- Partner delivery only if contracted and flagged  

## Out of scope for first catering slice

- Open-ended RFQ marketplace (can follow once fixed combos work)  
- Multi-kitchen bid wars  
- Full banquet / 200+ plate logistics  

## Engineering notes (when building)

- New order kind / meal type + MOQ validation in domain  
- Payment state: `ADVANCE_PAID` → `BALANCE_DUE` → `PAID` (names TBD) with Razorpay links + webhooks idempotent per phase  
- WA: advance confirm + balance reminder templates  
- Migrations separate from lunch paths; feature flag `catering_enabled` (default OFF)  
- Admin: see advance/balance and Mark paid edge cases  

## Related later

- Pantry shipping, tiffin loop (same MVP-3/era bucket in TDD)  
- PostGIS radius discovery when pin expansion needs distance, not only pin match  
