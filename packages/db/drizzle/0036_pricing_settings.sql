-- Admin-editable platform fee + cook commission (Admin → Pricing).
-- Orders / bookings snapshot the commission at creation; existing rows stay at 0 (cook keeps 100%).
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "int_value" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" varchar(80)
);
--> statement-breakpoint
ALTER TABLE "cook_profiles" ADD COLUMN IF NOT EXISTS "commission_bps" integer;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "commission_bps" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "catering_bookings" ADD COLUMN IF NOT EXISTS "commission_bps" integer DEFAULT 0 NOT NULL;
