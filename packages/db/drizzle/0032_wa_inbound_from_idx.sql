-- Worker checks "did this number message us in the last 24 h?" before choosing a paid template.
CREATE INDEX IF NOT EXISTS "wa_inbound_dedupe_from_created_idx" ON "wa_inbound_dedupe" ("from_mobile", "created_at");
