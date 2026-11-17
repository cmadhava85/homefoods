-- Staging/prod may have skipped 0005 or lost columns; drizzle findMany selects these.
-- Idempotent: safe if columns already exist.
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "delivery_window_start_hour" integer DEFAULT 12 NOT NULL;
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "delivery_window_start_minute" integer DEFAULT 0 NOT NULL;
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "delivery_window_end_hour" integer DEFAULT 13 NOT NULL;
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "delivery_window_end_minute" integer DEFAULT 0 NOT NULL;
