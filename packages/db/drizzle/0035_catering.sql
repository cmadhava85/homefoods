-- MVP-3 party / bulk catering. Additive only: no lunch table or column changes.
-- Gated by platform flag `catering_enabled` (default OFF) + per-cook opt-in.
CREATE TABLE IF NOT EXISTS "cook_catering_settings" (
  "cook_id" uuid PRIMARY KEY REFERENCES "cook_profiles"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "cutoff_hours" integer DEFAULT 48 NOT NULL,
  "daily_plate_cap" integer DEFAULT 100 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catering_combos" (
  "id" serial PRIMARY KEY NOT NULL,
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "name_ta" varchar(100),
  "contents" varchar(500),
  "price_per_plate_paise" integer NOT NULL,
  "min_plates" integer NOT NULL,
  "max_plates" integer NOT NULL,
  "is_veg" boolean DEFAULT true NOT NULL,
  "image_url" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "catering_combos_cook_name_uidx" ON "catering_combos" ("cook_id", "name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catering_bookings" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" varchar(20) NOT NULL UNIQUE,
  "customer_mobile" varchar(15) NOT NULL REFERENCES "users"("mobile_number"),
  "cook_id" uuid NOT NULL REFERENCES "cook_profiles"("id"),
  "combo_id" integer NOT NULL REFERENCES "catering_combos"("id"),
  "combo_name" varchar(100) NOT NULL,
  "combo_contents" varchar(500),
  "plates" integer NOT NULL,
  "price_per_plate_paise" integer NOT NULL,
  "food_paise" integer NOT NULL,
  "platform_fee_paise" integer NOT NULL,
  "advance_paise" integer NOT NULL,
  "balance_paise" integer NOT NULL,
  "event_date" date NOT NULL,
  "event_time" varchar(5) NOT NULL,
  "cutoff_at" timestamp with time zone NOT NULL,
  "fulfillment_mode" varchar(16) DEFAULT 'DELIVERY' NOT NULL,
  "address_id" integer REFERENCES "addresses"("id") ON DELETE SET NULL,
  "delivery_address" text NOT NULL,
  "note" varchar(500),
  "status" varchar(20) DEFAULT 'AWAITING_ADVANCE' NOT NULL,
  "refunded_paise" integer DEFAULT 0 NOT NULL,
  "cancelled_by" varchar(20),
  "cancel_reason" varchar(300),
  "cancelled_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "balance_reminded_at" timestamp with time zone,
  "cook_paid_at" timestamp with time zone,
  "cook_paid_utr" varchar(80),
  "trace_id" varchar(40) NOT NULL,
  "idempotency_key" varchar(160) UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catering_bookings_cook_date_idx" ON "catering_bookings" ("cook_id", "event_date", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catering_bookings_customer_idx" ON "catering_bookings" ("customer_mobile");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catering_payments" (
  "id" serial PRIMARY KEY NOT NULL,
  "booking_id" integer NOT NULL REFERENCES "catering_bookings"("id"),
  "phase" varchar(10) NOT NULL,
  "amount_paise" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "method" varchar(16) DEFAULT 'LINK' NOT NULL,
  "gateway_txn_id" varchar(100),
  "payment_id" varchar(100),
  "payment_url" text,
  "idempotency_key" varchar(160) NOT NULL UNIQUE,
  "raw_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catering_payments_booking_idx" ON "catering_payments" ("booking_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catering_payments_gateway_txn_idx" ON "catering_payments" ("gateway_txn_id");
