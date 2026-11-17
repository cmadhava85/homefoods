-- Manual cook payout ops (until Razorpay Route is enabled)
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "payout_upi_id" varchar(80),
  ADD COLUMN IF NOT EXISTS "payout_account_note" text;

ALTER TABLE "settlements"
  ADD COLUMN IF NOT EXISTS "manual_paid_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "manual_utr" varchar(80),
  ADD COLUMN IF NOT EXISTS "manual_note" text;
