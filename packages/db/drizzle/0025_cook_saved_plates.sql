CREATE TABLE IF NOT EXISTS "cook_saved_plates" (
  "id" serial PRIMARY KEY NOT NULL,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE cascade,
  "item_name" varchar(100) NOT NULL,
  "item_name_ta" varchar(100),
  "price_paise" integer NOT NULL,
  "is_veg" boolean DEFAULT true NOT NULL,
  "image_url" text,
  "meal_type" "meal_period" DEFAULT 'LUNCH' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cook_saved_plates_cook_meal_name_uidx"
  ON "cook_saved_plates" ("cook_id", "meal_type", "item_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cook_saved_plates_cook_idx"
  ON "cook_saved_plates" ("cook_id");
