-- Ad / kitchen boost campaigns (platform flag ads_enabled is kill switch; default OFF).
DO $$ BEGIN
  CREATE TYPE "ad_campaign_type" AS ENUM ('KITCHEN_BOOST', 'EXTERNAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ad_campaign_status" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "ad_campaigns" (
  "id" serial PRIMARY KEY NOT NULL,
  "type" "ad_campaign_type" NOT NULL,
  "status" "ad_campaign_status" DEFAULT 'DRAFT' NOT NULL,
  "pin_code" varchar(6) NOT NULL,
  "cook_id" uuid,
  "title" varchar(120) NOT NULL,
  "body" text,
  "cta_url" varchar(500),
  "image_url" varchar(500),
  "priority" integer DEFAULT 0 NOT NULL,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "created_by" varchar(80),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ad_campaigns_pin_status_idx"
  ON "ad_campaigns" ("pin_code", "status");
CREATE INDEX IF NOT EXISTS "ad_campaigns_cook_idx"
  ON "ad_campaigns" ("cook_id");
