CREATE TABLE IF NOT EXISTS "auth_otps" (
  "id" serial PRIMARY KEY NOT NULL,
  "mobile_number" varchar(20) NOT NULL,
  "role" varchar(20) NOT NULL,
  "code_hash" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_otps_mobile_role_uidx" ON "auth_otps" ("mobile_number", "role");
CREATE INDEX IF NOT EXISTS "auth_otps_expires_idx" ON "auth_otps" ("expires_at");
