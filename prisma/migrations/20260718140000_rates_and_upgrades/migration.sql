-- AlterTable: per-trip manual exchange rates, e.g. { "EUR": 11.2 } (foreign → trip currency)
ALTER TABLE "Trip" ADD COLUMN "exchange_rates" JSONB;

-- AlterTable: gear upgrade trail — retired items point at their replacement
ALTER TABLE "GearItem" ADD COLUMN "retired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "replaced_by_id" INTEGER;

-- AddForeignKey
ALTER TABLE "GearItem" ADD CONSTRAINT "GearItem_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "GearItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
