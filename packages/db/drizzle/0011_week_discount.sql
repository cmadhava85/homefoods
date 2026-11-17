-- MVP-2: cook-controlled week cart food discount (no coupon stacks)
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "week_discount_percent" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "week_discount_min_days" integer DEFAULT 3 NOT NULL;

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "food_discount_paise" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "week_discount_percent" integer;
