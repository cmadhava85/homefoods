-- Cook-controlled late orders (platform flag remains kill switch).
ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "late_orders_enabled" boolean DEFAULT true NOT NULL;
