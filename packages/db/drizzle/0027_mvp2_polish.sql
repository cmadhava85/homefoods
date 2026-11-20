-- MVP-2 polish: pause-today, fulfillment offers, named menu templates.
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "intake_paused_date" varchar(10);
--> statement-breakpoint
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "offer_cook_delivery" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "offer_customer_arrange" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cook_menu_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE cascade,
  "name" varchar(80) NOT NULL,
  "meal_type" "meal_period" DEFAULT 'LUNCH' NOT NULL,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cook_menu_templates_cook_idx"
  ON "cook_menu_templates" ("cook_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cook_menu_templates_cook_meal_name_uidx"
  ON "cook_menu_templates" ("cook_id", "meal_type", "name");
