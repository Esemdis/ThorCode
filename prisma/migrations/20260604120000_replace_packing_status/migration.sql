-- Add NOT_PACKED before recreating the enum
ALTER TYPE "PackingStatus" ADD VALUE IF NOT EXISTS 'NOT_PACKED';

-- Migrate existing data (must be in a separate step after ADD VALUE commits)
-- BORROWED → NEED_TO_BUY, NOT_BRINGING → NOT_PACKED
UPDATE "PackingItem" SET status = 'NEED_TO_BUY'::"PackingStatus" WHERE status = 'BORROWED'::"PackingStatus";
UPDATE "PackingItem" SET status = 'NOT_PACKED'::"PackingStatus" WHERE status = 'NOT_BRINGING'::"PackingStatus";

-- Recreate enum without BORROWED and NOT_BRINGING
ALTER TYPE "PackingStatus" RENAME TO "PackingStatus_old";
CREATE TYPE "PackingStatus" AS ENUM ('NEED_TO_BUY', 'BOUGHT', 'PACKED', 'NOT_PACKED');
ALTER TABLE "PackingItem" ALTER COLUMN status TYPE "PackingStatus" USING status::text::"PackingStatus";
DROP TYPE "PackingStatus_old";
