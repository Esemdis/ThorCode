import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { explain, RoutePlannerError } = require("./routePlanner");

// Only the checks that happen before the network does. Everything else in this
// module is an axios call, and a test that mocks axios to assert axios was
// called tests the mock.
describe("guards that run before any request", () => {
  const saved = process.env.ROUTE_PLANNER_URL;

  beforeEach(() => {
    process.env.ROUTE_PLANNER_URL = "http://planner.test";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ROUTE_PLANNER_URL;
    else process.env.ROUTE_PLANNER_URL = saved;
  });

  it("says what is missing when the planner has no address configured", async () => {
    delete process.env.ROUTE_PLANNER_URL;
    await expect(explain({}, 12)).rejects.toThrow(/ROUTE_PLANNER_URL/);
  });

  // The trap this guard exists for: Express hands over "12", the solver matches
  // ids by identity, "12" matches nothing, and the answer comes back as
  // "already in the plan" for a place that was in fact left out. Refusing here
  // is the difference between a 400 and a wrong answer nobody can spot.
  it.each([["12"], [null], [undefined], [NaN], [12.5]])(
    "refuses a place id that is not a whole number: %p",
    async (id) => {
      await expect(explain({}, id)).rejects.toBeInstanceOf(RoutePlannerError);
      await expect(explain({}, id)).rejects.toMatchObject({ status: 400 });
    }
  );
});
