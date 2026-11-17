-- MVP-2 partner logistics: rider-assign state + shipment tracking on orders.
ALTER TYPE "order_state" ADD VALUE IF NOT EXISTS 'ASSIGNING_RIDER';

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "logistics_mode" "logistics_mode" DEFAULT 'SELF' NOT NULL;
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "partner_shipment_id" varchar(100);
