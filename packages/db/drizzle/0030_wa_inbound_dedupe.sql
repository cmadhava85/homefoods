CREATE TABLE IF NOT EXISTS "wa_inbound_dedupe" (
  "wamid" varchar(128) PRIMARY KEY,
  "from_mobile" varchar(15),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_inbound_dedupe_created_idx" ON "wa_inbound_dedupe" ("created_at");
