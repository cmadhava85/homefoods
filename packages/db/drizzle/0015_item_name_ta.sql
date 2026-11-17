ALTER TABLE "daily_menus" ADD COLUMN IF NOT EXISTS "item_name_ta" varchar(100);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "item_name_ta" varchar(100);

-- Demo backfill for common staging dishes
UPDATE "daily_menus" SET "item_name_ta" = 'சாம்பார் சாதம் + பொரியல்'
  WHERE "item_name" = 'Sambar Rice + Poriyal' AND ("item_name_ta" IS NULL OR "item_name_ta" = '');
UPDATE "daily_menus" SET "item_name_ta" = 'சப்பாத்தி (3) + பருப்பு'
  WHERE "item_name" = 'Chapathi (3) + Dal' AND ("item_name_ta" IS NULL OR "item_name_ta" = '');
UPDATE "daily_menus" SET "item_name_ta" = 'தயிர் சாதம் + ஊறுகாய்'
  WHERE "item_name" = 'Curd Rice + Pickle' AND ("item_name_ta" IS NULL OR "item_name_ta" = '');
UPDATE "daily_menus" SET "item_name_ta" = 'இன்றைய தாலி'
  WHERE "item_name" = 'Today Thali' AND ("item_name_ta" IS NULL OR "item_name_ta" = '');
UPDATE "daily_menus" SET "item_name_ta" = 'வார கிண்ணம்'
  WHERE "item_name" = 'Weekly Bowl' AND ("item_name_ta" IS NULL OR "item_name_ta" = '');

UPDATE "orders" o
SET "item_name_ta" = m."item_name_ta"
FROM "daily_menus" m
WHERE o."menu_item_id" = m."id"
  AND (o."item_name_ta" IS NULL OR o."item_name_ta" = '')
  AND m."item_name_ta" IS NOT NULL;
