# Pending items (LocalMeals)

Last updated with admin feature flags (`0012_feature_flags.sql`).

## Block launch / staging ops

| Item | Notes |
|------|--------|
| Migrate Cloud SQL `0009`–`0013` | Manual payouts, reviews, week discount, feature flags, pickup columns |
| Deploy api + web + worker | After migrate; refresh `WHATSAPP_ACCESS_TOKEN` on Run |
| `terraform apply` uploads bucket | Sets `GCS_UPLOADS_BUCKET` on API; needed for multi-instance Cloud Run |
| Sync local `.env` WA token | SM has permanent System User token; `.env` may still be expired |
| WhatsApp phone test | Add your number as test recipient; message business/test number |
| WA utility templates | Optional until outside-24h outbound needed |
| Staging smoke after deploy | `SMOKE_API_URL=$API_URL node scripts/smoke-staging.mjs` |

## In repo, not vendor-ready

| Item | Notes |
|------|--------|
| Shadowfax / partner delivery | Scaffold + mock done (`partner_delivery_enabled`); real vendor adapter + HMAC still needed |
| IVR (Exotel/Twilio) | Stub `getIvrProvider()` — wire after vendor |

## Already built (toggle via Admin → Features)

- Customer ordering (master)
- Late orders
- Child Pays / Family
- Week cart discounts
- Reviews
- WhatsApp outbound
- Kitchen follow alerts
- EOD settlement job
- **Kitchen pickup** (default **OFF**) — landmark after pay, restricted window, ₹0 delivery; cook desk Menu & settings → enable + landmark (`PATCH /cooks/:slug/pickup`)

## Ops ritual

1. Admin → **Features** — flip off if incident  
2. Admin → **Payouts** — Mark paid + UTR after EOD  
3. Admin → **Cooks** — keep UPI filled for LIVE kitchens  
4. Admin → **Analytics** — week/month/year turnover CSV for Route / RBI reviews  

## Built for Route filings

- `GET /admin/analytics/turnover` aggregates paid-order food GMV, platform/delivery fees, refunds, and settlement nets per cook for week / month / year (or custom `from`–`to`).  
 
