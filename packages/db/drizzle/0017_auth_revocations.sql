CREATE TABLE IF NOT EXISTS "auth_revocations" (
  "mobile_number" varchar(20) NOT NULL,
  "role" varchar(20) NOT NULL,
  "revoked_before" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_revocations_pkey" PRIMARY KEY ("mobile_number", "role")
);
