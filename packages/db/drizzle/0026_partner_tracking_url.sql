-- Persist vendor tracking URL on partner shipments.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "partner_tracking_url" text;
