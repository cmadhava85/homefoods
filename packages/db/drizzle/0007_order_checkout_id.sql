ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_id" varchar(20);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_checkout_idx" ON "orders" ("checkout_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_gateway_txn_idx" ON "orders" ("gateway_txn_id");
