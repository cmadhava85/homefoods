-- Optional plate contents / portion size shown to customers (e.g. "500ml rice + poriyal · 2 rotis").
ALTER TABLE "daily_menus" ADD COLUMN IF NOT EXISTS "portion_note" varchar(120);
--> statement-breakpoint
ALTER TABLE "cook_saved_plates" ADD COLUMN IF NOT EXISTS "portion_note" varchar(120);
