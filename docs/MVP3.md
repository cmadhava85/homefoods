# MVP-3 — Party & bulk catering

Source: homemaker / tier-2 town growth ideas. Parent roadmap: [ROADMAP.md](./ROADMAP.md).

**Status: built, dark-launched.** The first slice (below) ships behind the platform flag `catering_enabled` (Admin → Features, **default OFF**) plus a per-cook opt-in. Do not switch it on until the lunch pin has stable cooks, cut-offs, and payouts. MVP-3 is additive — lunch/week cart stays the default mode and no lunch table, column, or state changed.

## Implemented (first slice)

| Area | What shipped |
|------|--------------|
| Flag | `catering_enabled` (OFF) gates new commitments only: cook settings + combos, public `/kitchens/:slug/catering`, new bookings, fresh advance links. Existing bookings keep working when it is switched off (balance pay, cancel, refunds, admin, webhooks) — no stranded money. |
| Cook opt-in | Desk → **Party orders** tab (visible only when the flag is on): enable, cut-off **48–72 h**, daily party-plate cap (default 100). LIVE kitchens only. |
| Combos | Name, plate contents, per-plate price, MOQ (≥ 10), max plates (≤ 150), veg flag; hide instead of delete (bookings keep a snapshot). |
| Booking | Customer picks combo + plates (MOQ … max) + event date/time (06:00–22:59 IST, ≤ 60 days ahead) + fulfillment (cook delivery / pickup / customer arranges — same cook toggles as lunch; pickup also needs `pickup_enabled` + landmark). |
| Capacity | Per kitchen per event date, serialised with a Postgres advisory lock. Unpaid holds count only while their advance link is live (same 25-min window as lunch). |
| Payments | Two Razorpay Payment Links per booking: **advance = 50% of food (rounded up) + platform fee**, **balance = remaining food** (link valid 3 days, reissued on demand). States: `AWAITING_ADVANCE → ADVANCE_PAID → PAID → COMPLETED`, or `CANCELLED`. Captures are idempotent; a capture on a cancelled booking or an already-paid phase is **auto-refunded**. |
| Cancellation | Customer: free before the advance; **full refund until the cut-off**; after that → support. Cook: cancel any open booking → customer fully refunded. Admin: cancel with full or partial refund. |
| Privacy | Cook sees customer address + mobile only after the advance is paid (same rule as lunch pickup landmark). Account deletion blocks while a party order is open and anonymises finished ones. |
| WhatsApp | Worker events `CateringAdvancePaid` (customer + cook), `CateringBalancePaid`, `CateringBalanceDue` (customer, once, ≤ 48 h before the event), `CateringCancelled`. |
| Payout | Cook gets food − commission (rate snapshotted on the booking; admin view shows `cookPayoutPaise`). Catering is **not** in lunch EOD batches: admin → **Party orders** → *Mark cook paid* (UTR) after completion. |
| Admin | Party orders tab (always visible): payment rows per phase, *Record cash/UPI* for a due phase, *Cancel + refund*, *Mark cook paid*. |

Code: domain rules `packages/domain/src/catering.ts`; migration `packages/db/drizzle/0035_catering.sql` (tables `cook_catering_settings`, `catering_combos`, `catering_bookings`, `catering_payments`); service `apps/api/src/services/catering.ts`; routes `apps/api/src/plugins/cateringRoutes.ts`; web `/kitchen/[slug]/party`, `/catering/bookings/[publicId]`, cook desk `CateringDeskPanel`, admin `CateringAdminPanel`.

### Before switching the flag on

1. Add a Cloud Scheduler job (e.g. hourly) → `POST /internal/catering/balance-reminders` with `X-Internal-Token`. Without it, customers only get the balance link on the advance-paid WhatsApp + booking page.
2. Review the cancellation copy in Terms / Refunds (`/legal/refunds`) — add the party-order rule above.
3. Turn on for one cook first (cook opt-in) and keep manual payouts until volume justifies automating.

### Deferred (by design)

- Lunch-vs-party capacity coupling (a big booking does not yet block that cook's lunch plates — cook manages via intake pause / daily cap).
- Headcount changes after booking (cancel + rebook for now).
- Automatic cook payout for catering in EOD settlement.
- Delivery fee / distance limits for party orders (price the plate to include delivery).


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
- Platform fee: **decided** — one admin-set platform fee per booking, charged with the advance; nothing extra on the balance  
- Cook food share: food − admin-set commission (same rate as lunch, per-cook override applies)  

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
