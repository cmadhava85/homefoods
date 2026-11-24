-- Convenience fee (gateway cost passed to the customer), wallet credit, and payment method per line.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "convenience_fee_paise" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "credit_applied_paise" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_method" varchar(16) DEFAULT 'LINK' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_credits" (
  "id" bigserial PRIMARY KEY,
  "customer_mobile" varchar(15) NOT NULL,
  "amount_paise" integer NOT NULL,
  "reason" varchar(40) NOT NULL,
  "order_id" integer REFERENCES "orders"("id"),
  "idempotency_key" varchar(120) NOT NULL UNIQUE,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_credits_mobile_idx" ON "customer_credits" ("customer_mobile");
