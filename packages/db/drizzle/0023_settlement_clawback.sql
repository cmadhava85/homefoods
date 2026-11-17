-- Next-EOD cook clawback: amount deducted from gross when settling after a
-- customer refund on an already-paid-out plate (see cook_ledger CLAWBACK_*).
ALTER TABLE "settlements"
  ADD COLUMN IF NOT EXISTS "clawback_paise" integer DEFAULT 0 NOT NULL;
