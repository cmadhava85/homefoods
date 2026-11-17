-- Kitchen pickup (feature-flagged). Landmark is ops/post-pay only — never public Discover.
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "pickup_landmark" text,
  ADD COLUMN IF NOT EXISTS "pickup_enabled" boolean DEFAULT false NOT NULL;

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "fulfillment_mode" varchar(16) DEFAULT 'DELIVERY' NOT NULL;
