CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- PostGIS optional for MVP-1 (lat/lng stored as numeric). Enable when available:
-- CREATE EXTENSION IF NOT EXISTS "postgis";

CREATE TYPE "public"."user_segment" AS ENUM('SENIOR', 'BACHELOR', 'CHILD_PAYER');
CREATE TYPE "public"."logistics_mode" AS ENUM('SELF', 'PARTNER');
CREATE TYPE "public"."meal_period" AS ENUM('BREAKFAST', 'LUNCH', 'DINNER');
CREATE TYPE "public"."inventory_category" AS ENUM('HOT_MEAL', 'DRY_PANTRY');
CREATE TYPE "public"."order_state" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'AWAITING_PAYMENT', 'CONFIRMING_PAYMENT', 'PAID', 'COOKING', 'PACKED', 'DISPATCHED', 'DELAYED', 'DELIVERED', 'RETURNED_TO_KITCHEN', 'LOGISTICS_EXCEPTION', 'CANCELLED', 'REFUNDED', 'FAILED');
CREATE TYPE "public"."platform_channel" AS ENUM('VOICE_IVR', 'WHATSAPP_BOT', 'WEB_STOREFRONT', 'SYSTEM_CRON', 'ADMIN');
CREATE TYPE "public"."onboarding_status" AS ENUM('DRAFT', 'DOCS_SUBMITTED', 'GATEWAY_KYC_PENDING', 'LIVE', 'REJECTED');
CREATE TYPE "public"."spice_level" AS ENUM('NORMAL', 'LESS');
CREATE TYPE "public"."ticket_status" AS ENUM('OPEN', 'RESOLVED', 'CLOSED');
CREATE TYPE "public"."ticket_category" AS ENUM('MISSING_DELIVERY', 'QUALITY', 'WRONG_ITEM', 'PAYMENT', 'FOODBORNE', 'COOK_OPS', 'DELAY', 'DOOR_NO_ANSWER', 'OTHER');

CREATE TABLE "users" (
  "mobile_number" varchar(15) PRIMARY KEY,
  "full_name" varchar(100) NOT NULL,
  "preferred_language" varchar(5) DEFAULT 'ta' NOT NULL,
  "segment" "user_segment" DEFAULT 'BACHELOR' NOT NULL,
  "primary_address" text NOT NULL,
  "office_address" text,
  "pin_code" varchar(6),
  "consents" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "cook_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mobile_number" varchar(15) NOT NULL UNIQUE,
  "kitchen_name" varchar(100) NOT NULL,
  "slug_handle" varchar(50) NOT NULL UNIQUE,
  "lat" numeric(10, 7),
  "lng" numeric(10, 7),
  "pin_code" varchar(6) NOT NULL,
  "delivery_type" "logistics_mode" DEFAULT 'SELF' NOT NULL,
  "flat_self_delivery_fee" numeric(5, 2) DEFAULT '25.00' NOT NULL,
  "max_self_distance_km" numeric(3, 1) DEFAULT '3.0' NOT NULL,
  "max_daily_capacity" integer DEFAULT 40 NOT NULL,
  "lunch_cutoff_hour" integer DEFAULT 8 NOT NULL,
  "lunch_cutoff_minute" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "onboarding_status" "onboarding_status" DEFAULT 'DRAFT' NOT NULL,
  "fssai_number" varchar(32),
  "fssai_verified_at" timestamptz,
  "payout_beneficiary_ref" varchar(80),
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "daily_menus" (
  "id" serial PRIMARY KEY,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE CASCADE,
  "item_name" varchar(100) NOT NULL,
  "price_paise" integer NOT NULL,
  "item_type" "inventory_category" DEFAULT 'HOT_MEAL' NOT NULL,
  "is_veg" boolean DEFAULT true NOT NULL,
  "allergens" text[] DEFAULT '{}' NOT NULL,
  "day_of_week" integer,
  "service_date" date,
  "meal_type" "meal_period" DEFAULT 'LUNCH' NOT NULL,
  "total_stock_available" integer DEFAULT -1 NOT NULL,
  "is_available" boolean DEFAULT true NOT NULL
);

CREATE TABLE "orders" (
  "id" serial PRIMARY KEY,
  "public_id" varchar(20) NOT NULL UNIQUE,
  "customer_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number"),
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id"),
  "meal_type" "meal_period" NOT NULL,
  "service_date" date NOT NULL,
  "item_name" varchar(100) NOT NULL,
  "qty" integer DEFAULT 1 NOT NULL,
  "spice" "spice_level" DEFAULT 'NORMAL' NOT NULL,
  "food_paise" integer NOT NULL,
  "delivery_paise" integer DEFAULT 0 NOT NULL,
  "platform_fee_paise" integer DEFAULT 300 NOT NULL,
  "status" "order_state" DEFAULT 'DRAFT' NOT NULL,
  "settlement_hold" boolean DEFAULT false NOT NULL,
  "settlement_id" integer,
  "delivery_target_address" text NOT NULL,
  "channel" "platform_channel" DEFAULT 'WEB_STOREFRONT' NOT NULL,
  "gateway_txn_id" varchar(100),
  "idempotency_key" varchar(160) UNIQUE,
  "route_maps_url" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "payments" (
  "id" serial PRIMARY KEY,
  "order_id" integer NOT NULL REFERENCES "orders"("id"),
  "amount_paise" integer NOT NULL,
  "status" varchar(32) NOT NULL,
  "gateway_txn_id" varchar(100),
  "idempotency_key" varchar(160) UNIQUE,
  "raw_payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "settlements" (
  "id" serial PRIMARY KEY,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id"),
  "business_date" date NOT NULL,
  "gross_paise" integer NOT NULL,
  "fees_paise" integer DEFAULT 0 NOT NULL,
  "net_paise" integer NOT NULL,
  "order_count" integer NOT NULL,
  "gateway_batch_id" varchar(100),
  "status" varchar(32) DEFAULT 'COMPLETED' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "settlements_cook_date_uidx" ON "settlements" ("cook_id","business_date");

CREATE TABLE "cook_ledger" (
  "id" serial PRIMARY KEY,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id"),
  "entry_type" varchar(40) NOT NULL,
  "amount_paise" integer NOT NULL,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "support_tickets" (
  "id" serial PRIMARY KEY,
  "order_id" integer REFERENCES "orders"("id"),
  "cook_id" uuid REFERENCES "cook_profiles"("id"),
  "customer_mobile" varchar(15),
  "category" "ticket_category" DEFAULT 'OTHER' NOT NULL,
  "status" "ticket_status" DEFAULT 'OPEN' NOT NULL,
  "source" varchar(40) DEFAULT 'WEB' NOT NULL,
  "summary" text NOT NULL,
  "decision" varchar(40),
  "sla_due_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "resolved_at" timestamptz
);

CREATE TABLE "admin_action_log" (
  "id" bigserial PRIMARY KEY,
  "actor" varchar(80) DEFAULT 'owner' NOT NULL,
  "action" varchar(80) NOT NULL,
  "entity_type" varchar(40) NOT NULL,
  "entity_id" varchar(80) NOT NULL,
  "reason" text,
  "payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "platform_event_ledger" (
  "id" bigserial PRIMARY KEY,
  "associated_mobile" varchar(15),
  "order_id" integer,
  "cook_id" uuid,
  "channel" "platform_channel" NOT NULL,
  "event_name" varchar(100) NOT NULL,
  "raw_payload" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "outbox" (
  "id" bigserial PRIMARY KEY,
  "event_name" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL,
  "processed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "cutoff_locks" (
  "id" serial PRIMARY KEY,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id"),
  "meal_type" "meal_period" NOT NULL,
  "service_date" date NOT NULL,
  "locked_at" timestamptz DEFAULT now() NOT NULL,
  "headcount" integer DEFAULT 0 NOT NULL,
  "route_maps_url" text
);

CREATE UNIQUE INDEX "cutoff_unique" ON "cutoff_locks" ("cook_id","meal_type","service_date");
CREATE UNIQUE INDEX "orders_idempotency_uidx" ON "orders" ("idempotency_key");
