-- Durable business trace id for joining create → payment webhooks → outbox → worker
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "trace_id" varchar(40);
UPDATE "orders"
SET "trace_id" = COALESCE("checkout_id", "public_id")
WHERE "trace_id" IS NULL;
ALTER TABLE "orders" ALTER COLUMN "trace_id" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "orders_trace_id_idx" ON "orders" ("trace_id");
