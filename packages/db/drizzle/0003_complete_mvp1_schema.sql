-- Complete MVP-1 schema: TDD critical tables + integrity fields

CREATE TYPE "public"."address_label" AS ENUM('HOME', 'OFFICE', 'OTHER');
CREATE TYPE "public"."payment_kind" AS ENUM('CHARGE', 'REFUND');
CREATE TYPE "public"."family_link_status" AS ENUM('PENDING', 'ACTIVE', 'REVOKED');

CREATE TABLE IF NOT EXISTS "addresses" (
  "id" serial PRIMARY KEY,
  "user_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number") ON DELETE CASCADE,
  "label" "address_label" DEFAULT 'HOME' NOT NULL,
  "line1" text NOT NULL,
  "line2" text,
  "pin_code" varchar(6) NOT NULL,
  "lat" numeric(10, 7),
  "lng" numeric(10, 7),
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "addresses_user_idx" ON "addresses" ("user_mobile");
CREATE UNIQUE INDEX IF NOT EXISTS "addresses_user_label_uidx" ON "addresses" ("user_mobile", "label");

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" serial PRIMARY KEY,
  "user_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number") ON DELETE CASCADE,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE CASCADE,
  "meal_type" "meal_period" DEFAULT 'LUNCH' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_user_cook_meal_uidx"
  ON "subscriptions" ("user_mobile", "cook_id", "meal_type");

CREATE TABLE IF NOT EXISTS "family_links" (
  "id" serial PRIMARY KEY,
  "senior_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number") ON DELETE CASCADE,
  "payer_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number") ON DELETE CASCADE,
  "status" "family_link_status" DEFAULT 'PENDING' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "activated_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "family_links_senior_payer_uidx"
  ON "family_links" ("senior_mobile", "payer_mobile");

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "payer_mobile" varchar(15) REFERENCES "users"("mobile_number");
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "menu_item_id" integer REFERENCES "daily_menus"("id");
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "address_id" integer REFERENCES "addresses"("id");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'orders_settlement_id_fkey' AND table_name = 'orders'
  ) THEN
    ALTER TABLE "orders"
      ADD CONSTRAINT "orders_settlement_id_fkey"
      FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "orders_cook_service_idx" ON "orders" ("cook_id", "service_date", "status");
CREATE INDEX IF NOT EXISTS "orders_customer_idx" ON "orders" ("customer_mobile");

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "kind" "payment_kind" DEFAULT 'CHARGE' NOT NULL;
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments" ("order_id");

ALTER TABLE "cook_ledger"
  ADD COLUMN IF NOT EXISTS "order_id" integer REFERENCES "orders"("id");
ALTER TABLE "cook_ledger"
  ADD COLUMN IF NOT EXISTS "settlement_id" integer REFERENCES "settlements"("id");
CREATE INDEX IF NOT EXISTS "cook_ledger_cook_idx" ON "cook_ledger" ("cook_id");

CREATE TABLE IF NOT EXISTS "ratings_reviews" (
  "id" serial PRIMARY KEY,
  "order_id" integer NOT NULL UNIQUE REFERENCES "orders"("id"),
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id"),
  "customer_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number"),
  "rating" integer NOT NULL,
  "comment" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ratings_reviews_cook_idx" ON "ratings_reviews" ("cook_id");

ALTER TABLE "outbox"
  ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "outbox"
  ADD COLUMN IF NOT EXISTS "last_error" text;
CREATE INDEX IF NOT EXISTS "outbox_unprocessed_idx" ON "outbox" ("processed_at");

CREATE INDEX IF NOT EXISTS "daily_menus_cook_date_idx"
  ON "daily_menus" ("cook_id", "service_date", "meal_type");

-- Backfill default HOME addresses from users.primary_address where missing
INSERT INTO "addresses" ("user_mobile", "label", "line1", "pin_code", "is_default")
SELECT u."mobile_number", 'HOME', u."primary_address", COALESCE(u."pin_code", '000000'), true
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "addresses" a
  WHERE a."user_mobile" = u."mobile_number" AND a."label" = 'HOME'
);
