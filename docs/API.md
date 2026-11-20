# LocalMeals API (MVP-1)

Base: `http://127.0.0.1:4000`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| POST | `/auth/otp/request` | Send OTP `{ mobile, role: CUSTOMER\|COOK\|ADMIN }` |
| POST | `/auth/otp/verify` | Verify OTP → `{ token, user }` |
| GET | `/auth/me` | Current session (Bearer) |
| POST | `/auth/logout` | End session |
| GET | `/kitchens?pin=` | LIVE kitchens |
| GET | `/kitchens/:slug/menu` | Today's menu |
| POST | `/orders` | Create order + payment link (optional `Idempotency-Key` header) |
| POST | `/orders/batch` | Multi-day cart, one payment (optional `Idempotency-Key`) |
| GET | `/me/orders` | Customer order history (Bearer CUSTOMER; `?limit=&offset=`) |
| GET | `/orders/:publicId` | Order detail (address/mobiles redacted unless owner/staff) |
| POST | `/orders/:publicId/cancel` | Before cut-off: cancel (unpaid) or **auto full refund** (paid). After cut-off if `PAID`: request cancel |
| POST | `/orders/:publicId/cancel-accept` | Cook: accept cancel → full refund |
| POST | `/orders/:publicId/cancel-decline` | Cook: decline → back to `PAID` |
| POST | `/orders/:publicId/refund` | Admin: `{ mode: FULL\|FOOD_ONLY, reason, ticketId? }` — Razorpay partial refund of that day-line |
| GET | `/cooks/:slug/cancel-pending` | Cook desk cancel asks |
| POST | `/payments/mock-confirm` | Simulate UPI capture |
| POST | `/webhooks/payments` | Payment provider webhook |
| GET/POST | `/webhooks/whatsapp` | WA verify + inbound |
| POST | `/webhooks/logistics` | Partner shipment status (secret / HMAC) — [LOGISTICS.md](./LOGISTICS.md) |
| GET | `/cooks/:slug/manifest` | Cut-off manifest + orders (+ cook lunchCutoff) |
| GET | `/cooks/:slug/menu?date=&view=day\|week` | Cook desk menu (dated + weekly templates) |
| POST | `/cooks/:slug/menu` | Add plate `{ itemName, priceRupees, serviceDate?, weekly?, dayOfWeek?, imageUrl?, saveToLibrary? }` |
| GET | `/cooks/:slug/saved-plates?meal=` | Cook dish library for quick re-post |
| POST | `/cooks/:slug/saved-plates` | Save plate (fields or `{ fromMenuId }`) |
| POST | `/cooks/:slug/saved-plates/:id/post` | One-tap post saved plate to date / weekly |
| DELETE | `/cooks/:slug/saved-plates/:id` | Remove from library |
| POST | `/cooks/:slug/menu/photo` | Upload food photo (multipart) → `{ url }` |
| PATCH | `/cooks/:slug/menu/:id` | Update / show-hide / attach `imageUrl` |
| GET | `/uploads/:file` | Menu/concern photos (local disk or GCS proxy via `GCS_UPLOADS_BUCKET`) |
| GET | `/cooks/:slug/meal-settings` | Per-meal cut-off/ETA + `weekDiscount` + `pickup` |
| PATCH | `/cooks/:slug/meal-settings/:mealType` | Update cut-off / window / enabled for a meal |
| PATCH | `/cooks/:slug/week-discount` | Cook week cart % off food `{ percent 0–15, minDays }` |
| PATCH | `/cooks/:slug/pickup` | Cook pickup `{ pickupEnabled?, pickupLandmark? }` (landmark required when enabling) |
| GET | `/cooks/:slug/reviews` | Desk reviews + soft-launch summary |
| POST | `/cooks/:slug/reviews/:id/reply` | Cook reply (overwrite allowed) |
| POST | `/orders/:publicId/late-approve` | Cook: accept late → pay link |
| POST | `/cooks/:slug/pack` | COOKING → PACKED |
| POST | `/cooks/:slug/dispatch` | PACKED → DISPATCHED |
| POST | `/orders/:publicId/delivered` | → DELIVERED |
| POST | `/internal/cutoffs/LUNCH` | Freeze cooks at/past their cut-off (`force: true` skips clock) |
| POST | `/internal/settlements/eod` | Mock EOD payouts |
| GET | `/admin/tickets` | Ticket inbox |
| GET | `/admin/tickets/:id` | Ticket detail |
| GET | `/admin/orders/:key` | Ops support: LM-… / checkoutId / trc_… / gatewayTxnId → order, payments, outbox, activity, Cloud Logging hint |
| GET | `/admin/cooks` | Cook list |
| GET | `/admin/analytics/turnover?period=week\|month\|year\|custom&from=&to=&cookId=` | Route/RBI turnover by cook (food GMV, fees, settlements) |
| POST | `/internal/ops/holds` | settlement_hold=true |
| POST | `/internal/ops/refunds` | Admin: `{ orderId, mode, reason }` (numeric id; prefer `/orders/:publicId/refund`) |
| POST | `/internal/ops/cooks/:id/pause` | is_active=false |

## WhatsApp inbound contract

**Local UI:** http://localhost:3000/wa (chat simulator). Real Meta WABA is stubbed until `MOCK_WHATSAPP=false` + secrets.

Mock body (local):

```json
{ "from": "+9198…", "text": "Menu" }
```

Response includes `replies[]` (mock outbound) so the simulator can show the bot.

**Order path**

1. `Menu` → kitchens + buttons (`csk-homemade-delights`, …)
2. `Order csk-homemade-delights` or tap `csk-homemade-delights` (optional `Order csk-homemade-delights 2` for item #)
3. `Pay` → payment URL + `gatewayTxnId`
4. Simulator: **Confirm mock pay** → `POST /payments/mock-confirm`

**Cook menu path** (from cook mobile)

1. `Add Sambar rice 80` / `Add Chicken biryani 120 nonveg` → today’s lunch plate  
2. Send image (or mock `{ imageBase64, mimeType }` / `{ imageUrl: "/uploads/…" }`) to attach photo, or `Skip`  
3. `My menu` → list today’s plates  

Meta Cloud API shape is also accepted (`entry[0].changes[0].value.messages[0]`, including `type: image`).

Verify challenge: `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
