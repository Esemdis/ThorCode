-- AlterTable: what the item costs in store vs what was actually paid
ALTER TABLE "GearItem" ADD COLUMN "retail_price" DECIMAL(10,2);
ALTER TABLE "GearItem" ADD COLUMN "bought_for" DECIMAL(10,2);
ALTER TABLE "GearItem" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'SEK';

-- AlterTable: trip vibe tags (concert, friends, culture, food, …)
ALTER TABLE "Trip" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
