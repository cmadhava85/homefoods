ALTER TABLE "cook_profiles"
  ADD COLUMN IF NOT EXISTS "payout_beneficiary_ref" varchar(80);

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "settlement_id" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "settlements_cook_date_uidx"
  ON "settlements" ("cook_id", "business_date");
