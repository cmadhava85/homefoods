CREATE TABLE IF NOT EXISTS "cook_meal_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE cascade,
  "meal_type" "meal_period" NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "cutoff_hour" integer NOT NULL,
  "cutoff_minute" integer DEFAULT 0 NOT NULL,
  "delivery_start_hour" integer NOT NULL,
  "delivery_start_minute" integer DEFAULT 0 NOT NULL,
  "delivery_end_hour" integer NOT NULL,
  "delivery_end_minute" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cook_meal_settings_cook_meal_uidx"
  ON "cook_meal_settings" ("cook_id", "meal_type");
--> statement-breakpoint
-- Lunch from legacy cook_profiles columns
INSERT INTO "cook_meal_settings" (
  "cook_id", "meal_type", "enabled",
  "cutoff_hour", "cutoff_minute",
  "delivery_start_hour", "delivery_start_minute",
  "delivery_end_hour", "delivery_end_minute"
)
SELECT
  c."id",
  'LUNCH'::"meal_period",
  true,
  c."lunch_cutoff_hour",
  c."lunch_cutoff_minute",
  c."delivery_window_start_hour",
  c."delivery_window_start_minute",
  c."delivery_window_end_hour",
  c."delivery_window_end_minute"
FROM "cook_profiles" c
ON CONFLICT ("cook_id", "meal_type") DO NOTHING;
--> statement-breakpoint
-- Breakfast defaults (disabled)
INSERT INTO "cook_meal_settings" (
  "cook_id", "meal_type", "enabled",
  "cutoff_hour", "cutoff_minute",
  "delivery_start_hour", "delivery_start_minute",
  "delivery_end_hour", "delivery_end_minute"
)
SELECT c."id", 'BREAKFAST'::"meal_period", false, 6, 30, 7, 30, 8, 30
FROM "cook_profiles" c
ON CONFLICT ("cook_id", "meal_type") DO NOTHING;
--> statement-breakpoint
-- Dinner defaults (disabled)
INSERT INTO "cook_meal_settings" (
  "cook_id", "meal_type", "enabled",
  "cutoff_hour", "cutoff_minute",
  "delivery_start_hour", "delivery_start_minute",
  "delivery_end_hour", "delivery_end_minute"
)
SELECT c."id", 'DINNER'::"meal_period", false, 16, 0, 19, 0, 20, 0
FROM "cook_profiles" c
ON CONFLICT ("cook_id", "meal_type") DO NOTHING;
