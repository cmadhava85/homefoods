-- Admin-managed kill switches / feature toggles
CREATE TABLE IF NOT EXISTS "platform_feature_flags" (
  "key" varchar(64) PRIMARY KEY,
  "enabled" boolean DEFAULT true NOT NULL,
  "label" varchar(120) NOT NULL,
  "description" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "updated_by" varchar(80)
);
