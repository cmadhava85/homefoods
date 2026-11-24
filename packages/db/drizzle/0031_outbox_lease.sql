ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "locked_until" timestamptz;
