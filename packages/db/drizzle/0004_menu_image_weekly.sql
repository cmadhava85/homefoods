ALTER TABLE "daily_menus"
  ADD COLUMN IF NOT EXISTS "image_url" text;

CREATE INDEX IF NOT EXISTS "daily_menus_cook_dow_idx"
  ON "daily_menus" ("cook_id", "day_of_week");
