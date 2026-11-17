CREATE TABLE IF NOT EXISTS "kitchen_followers" (
  "id" serial PRIMARY KEY NOT NULL,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE cascade,
  "customer_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number") ON DELETE cascade,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kitchen_followers_cook_mobile_uidx"
  ON "kitchen_followers" ("cook_id", "customer_mobile");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kitchen_followers_cook_idx" ON "kitchen_followers" ("cook_id");
