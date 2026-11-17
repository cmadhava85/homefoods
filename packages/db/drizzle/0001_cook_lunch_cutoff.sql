ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "lunch_cutoff_hour" integer DEFAULT 8 NOT NULL;
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "lunch_cutoff_minute" integer DEFAULT 0 NOT NULL;
