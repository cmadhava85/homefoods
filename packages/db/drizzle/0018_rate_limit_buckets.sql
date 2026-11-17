CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "bucket_key" varchar(255) PRIMARY KEY NOT NULL,
  "hits" integer DEFAULT 0 NOT NULL,
  "reset_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "rate_limit_buckets_reset_idx" ON "rate_limit_buckets" ("reset_at");
