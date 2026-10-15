-- Places, the saved day plan, budgets and expense estimates are wander's now.
-- wander copies them across through its Settings page ("Import my travel-bag
-- trips"), reading this API with the user's own token — so this migration
-- must only run once every trip worth keeping has been imported. It destroys
-- the rows; there is no undo short of a backup.
--
-- Trip itself, its items, todos, weather and reviews stay: travel-bag still
-- needs a trip to pack for, and wander's packing panel reads them from here.

-- DropForeignKey
ALTER TABLE "TripPlace" DROP CONSTRAINT "TripPlace_trip_id_fkey";

-- DropForeignKey
ALTER TABLE "ExpenseEstimate" DROP CONSTRAINT "ExpenseEstimate_trip_id_fkey";

-- AlterTable
ALTER TABLE "Trip" DROP COLUMN "arrival_place_id",
DROP COLUMN "arrival_time",
DROP COLUMN "budget_entertainment",
DROP COLUMN "budget_flights",
DROP COLUMN "budget_food",
DROP COLUMN "budget_hotel",
DROP COLUMN "currency",
DROP COLUMN "departure_place_id",
DROP COLUMN "departure_time",
DROP COLUMN "exchange_rates",
DROP COLUMN "money_budget",
DROP COLUMN "plan_data",
DROP COLUMN "plan_updated_at",
DROP COLUMN "transfer_minutes";

-- DropTable
DROP TABLE "TripPlace";

-- DropTable
DROP TABLE "ExpenseEstimate";

-- DropEnum
DROP TYPE "PlaceKind";

