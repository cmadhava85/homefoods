-- MVP-2: cook reply on ratings (customers rate after DELIVERED; cook may reply, not hide)
ALTER TABLE "ratings_reviews"
  ADD COLUMN IF NOT EXISTS "cook_reply" text,
  ADD COLUMN IF NOT EXISTS "cook_replied_at" timestamptz;
