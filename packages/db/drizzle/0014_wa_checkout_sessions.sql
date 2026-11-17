CREATE TABLE IF NOT EXISTS "wa_checkout_sessions" (
  "mobile_number" varchar(15) PRIMARY KEY NOT NULL,
  "step" varchar(32) NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
