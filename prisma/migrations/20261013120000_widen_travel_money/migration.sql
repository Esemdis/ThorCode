-- Every travel money column goes from DECIMAL(10,2) to DECIMAL(12,2): ten
-- digits before the point instead of eight.
--
-- Eight was enough in SEK and EUR and nowhere near enough in VND or IDR, where
-- 100,000,000 is a few thousand euros — a two-week budget, or one hotel stay
-- logged in local currency, was refused with "must be at most 99999999.99".
-- Wander's budget port already uses (12, 2), so this also keeps a later move
-- of these rows into wander from being lossy.
--
-- A pure widening: same scale, larger precision, so every existing value fits
-- unchanged and Postgres converts in place with no rounding.
--
-- The gear prices are widened with the trip columns because they are bounded
-- by the same DECIMAL_MAX in utils/travel/fields.js; raising that constant for
-- budgets alone would let a gear price through the validator and into a column
-- that cannot hold it, which is the bare 500 the normalisers exist to prevent.

-- AlterTable
ALTER TABLE "Trip" ALTER COLUMN "money_budget" TYPE DECIMAL(12,2),
ALTER COLUMN "budget_flights" TYPE DECIMAL(12,2),
ALTER COLUMN "budget_hotel" TYPE DECIMAL(12,2),
ALTER COLUMN "budget_entertainment" TYPE DECIMAL(12,2),
ALTER COLUMN "budget_food" TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "ExpenseEstimate" ALTER COLUMN "amount" TYPE DECIMAL(12,2);

-- AlterTable
ALTER TABLE "GearItem" ALTER COLUMN "retail_price" TYPE DECIMAL(12,2),
ALTER COLUMN "bought_for" TYPE DECIMAL(12,2);
