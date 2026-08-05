/**
 * Client for the route-planner service.
 *
 * Kept out of the routes because both endpoints need the same base URL, the
 * same optional bearer token and the same "the solver being down is not a 500
 * from us" handling, and because trips.js already shows what happens when a
 * service call is inlined: the URL is read from the environment in six places.
 */

const axios = require("axios");

// A solve is synchronous and CPU-bound. It waits on the OSRM matrix, then
// optionally on a transit matrix (one call per place), then burns its whole
// search time limit — so three minutes is a real ceiling and not a guess.
const SOLVE_TIMEOUT_MS = 180_000;
// Explaining a drop is two solves against one shared matrix, so it is one extra
// search on top of a solve rather than twice the work — but the ceiling has to
// cover it or the answer times out precisely on the crowded trips that make
// anyone ask the question.
const EXPLAIN_TIMEOUT_MS = 240_000;
const GEOCODE_TIMEOUT_MS = 20_000;

const baseUrl = () => (process.env.ROUTE_PLANNER_URL || "").replace(/\/$/, "");

function headers() {
  const token = process.env.ROUTE_PLANNER_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

class RoutePlannerError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RoutePlannerError";
    this.status = status;
  }
}

/**
 * Wrap a failed call in something a route can turn into an honest status.
 *
 * A 422 from the solver is the user's trip being unplannable and their message
 * is worth reading, so it comes back as a 422. Anything else — refused
 * connection, timeout, a 500 — is our infrastructure and becomes a 503: the
 * trip is fine, the service is not, and trying again later is the right advice.
 */
function wrap(err, what) {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (status === 422 && detail) {
    return new RoutePlannerError(detail, 422);
  }
  console.error(`[${new Date().toISOString()}] route-planner ${what} failed`, err?.message || err);
  return new RoutePlannerError("The route planner is unavailable — try again shortly", 503);
}

function assertConfigured() {
  if (!baseUrl()) {
    // Named rather than defaulted to localhost: a default would turn a
    // misconfigured deploy into a connection refused ten minutes later instead
    // of a sentence saying what is missing.
    throw new RoutePlannerError(
      "ROUTE_PLANNER_URL is not set — put it in .env for local work, or in Doppler for a deploy",
      503
    );
  }
}

/** Solve a trip. Takes the body from buildPlanRequest, returns the plan. */
async function solve(request) {
  assertConfigured();
  try {
    const { data } = await axios.post(`${baseUrl()}/plan`, request, {
      timeout: SOLVE_TIMEOUT_MS,
      headers: headers(),
    });
    return data;
  } catch (err) {
    throw wrap(err, "solve");
  }
}

/**
 * Ask what it would take to fit one dropped place in.
 *
 * `placeId` must be the number the place actually has. The solver matches ids
 * by identity and refuses a mismatched type rather than answering, because "12"
 * against a place numbered 12 matches nothing and would come back as the
 * confident, wrong answer "already in the plan" — and Express hands every route
 * parameter over as a string.
 */
async function explain(request, placeId) {
  assertConfigured();
  if (!Number.isInteger(placeId)) {
    throw new RoutePlannerError("A place id is required", 400);
  }
  try {
    const { data } = await axios.post(
      `${baseUrl()}/explain`,
      { ...request, place_id: placeId },
      { timeout: EXPLAIN_TIMEOUT_MS, headers: headers() }
    );
    return data;
  } catch (err) {
    throw wrap(err, "explain");
  }
}

/**
 * A paragraph about a place, from Wikipedia. Null when there is no article.
 *
 * Swallowed like geocode rather than thrown like search: a missing description
 * is the normal case for most places, and it must never stop a batch.
 */
async function describe(name, lat, lon, languages = ["en"]) {
  assertConfigured();
  try {
    const { data } = await axios.post(
      `${baseUrl()}/describe`,
      { name, lat, lon, languages },
      { timeout: GEOCODE_TIMEOUT_MS, headers: headers() }
    );
    // Null here is a real answer with a 200 behind it: Wikipedia has no article
    // for this place, and it never will. That is worth recording.
    return data || null;
  } catch (err) {
    // A failure is not that answer, and must not be mistaken for it. The caller
    // stamps `blurb_checked_at` on whatever comes back, so swallowing this and
    // returning null marked every sight on the trip as permanently having no
    // article the one time the planner was restarting — and took the button
    // that would have let you retry away with it.
    throw wrap(err, "describe");
  }
}

/**
 * Resolve a place to coordinates. Returns null when nothing was found.
 *
 * Null is not an error here: a place that could not be located is still worth
 * saving. The solver reports it in `dropped` and the user can paste a map link
 * later, which is the one method that always works.
 */
async function geocode(query, near = null, context = null) {
  assertConfigured();
  try {
    const { data } = await axios.post(
      `${baseUrl()}/geocode`,
      { query, near, context },
      { timeout: GEOCODE_TIMEOUT_MS, headers: headers() }
    );
    return data || null;
  } catch (err) {
    // Deliberately swallowed. Saving a place must not depend on a geocoder
    // being up; null coordinates are a supported state all the way through.
    console.error(`[${new Date().toISOString()}] geocode "${query}" failed`, err?.message || err);
    return null;
  }
}

/**
 * Candidates for an address, for somebody who is watching and can choose.
 *
 * Separate from `geocode` because the failure they guard against is different.
 * Guessing silently is how a hotel ends up in the wrong country; here the
 * ambiguity is handed back, since only the person typing can resolve it.
 *
 * Throws rather than swallowing: an empty list means "nothing matched", and a
 * search box has to be able to tell that from "the geocoder is down".
 */
async function searchPlaces(query, { near = null, context = null, limit = 6 } = {}) {
  assertConfigured();
  try {
    const { data } = await axios.post(
      `${baseUrl()}/geocode/search`,
      { query, near, context, limit },
      { timeout: GEOCODE_TIMEOUT_MS, headers: headers() }
    );
    return data?.results ?? [];
  } catch (err) {
    throw wrap(err, "search");
  }
}

module.exports = {
  solve, explain, geocode, describe, searchPlaces, RoutePlannerError, SOLVE_TIMEOUT_MS,
};
