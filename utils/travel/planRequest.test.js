import { describe, it, expect } from 'vitest';
import {
  buildPlanRequest, PlanInputError,
  dateOnly, datesBetween, wetDates, hotelForDate, dayBounds, travelBounds, toPlace, MAX_DAYS,
} from './planRequest.js';

const hotel = (over = {}) => ({
  id: 1, name: "Hotel", kind: "HOTEL", lat: 48.8575, lon: 2.361, priority: 3, ...over,
});
const sight = (over = {}) => ({
  id: 2, name: "Louvre", kind: "SIGHT", lat: 48.8606, lon: 2.3376, priority: 3, ...over,
});
const trip = (over = {}) => ({
  start_date: new Date("2026-09-14T00:00:00Z"),
  end_date: new Date("2026-09-16T00:00:00Z"),
  ...over,
});

describe("reading dates out of the database", () => {
  it("gives back the calendar day that was stored, not the one local time lands on", () => {
    // A @db.Date arrives pinned to UTC midnight. Read in any timezone west of
    // UTC by anything local-aware, this is the 13th.
    expect(dateOnly(new Date("2026-09-14T00:00:00Z"))).toBe("2026-09-14");
  });

  it("accepts a string as readily as a Date, because both turn up", () => {
    expect(dateOnly("2026-09-14")).toBe("2026-09-14");
  });

  it("treats an unparseable date as absent rather than as NaN", () => {
    expect(dateOnly("not a date")).toBeNull();
    expect(dateOnly(null)).toBeNull();
  });
});

describe("expanding a trip into days", () => {
  it("includes both the first and the last day", () => {
    expect(datesBetween("2026-09-14", "2026-09-16"))
      .toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
  });

  it("handles a single-day trip", () => {
    expect(datesBetween("2026-09-14", "2026-09-14")).toEqual(["2026-09-14"]);
  });

  it("crosses a month boundary without arithmetic going wrong", () => {
    expect(datesBetween("2026-08-30", "2026-09-02"))
      .toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });

  it("crosses a daylight-saving change without dropping or repeating a day", () => {
    // Europe puts the clocks back on 2026-10-25. A local-time cursor stepping
    // by 24 hours lands on the 25th twice.
    expect(datesBetween("2026-10-24", "2026-10-26"))
      .toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  });

  it("stops one past the limit so an over-long trip is visibly over it", () => {
    expect(datesBetween("2026-01-01", "2026-12-31")).toHaveLength(MAX_DAYS + 1);
  });
});

describe("deciding which days are wet", () => {
  it("counts a day as wet from either the millimetres or the code", () => {
    const wet = wetDates({
      days: [
        { date: "2026-09-14", precip_avg: 4.2, weather_code: 3 },
        { date: "2026-09-15", precip_avg: 0, weather_code: 61 },
        { date: "2026-09-16", precip_avg: 0.2, weather_code: 3 },
      ],
    });
    expect([...wet].sort()).toEqual(["2026-09-14", "2026-09-15"]);
  });

  it("does not call a trip dry just because nobody has synced the weather", () => {
    // Absent weather has to mean unknown. Returning every date here would tell
    // the solver it definitely will not rain.
    expect(wetDates(null).size).toBe(0);
    expect(wetDates({}).size).toBe(0);
    expect(wetDates({ days: "nonsense" }).size).toBe(0);
  });
});

describe("anchoring days to a hotel", () => {
  it("uses the only hotel there is when nothing is pinned", () => {
    expect(hotelForDate([hotel()], "2026-09-15").id).toBe(1);
  });

  it("switches hotels from the day the second one is pinned to", () => {
    const first = hotel({ id: 1 });
    const second = hotel({ id: 2, pinned_day: new Date("2026-09-16T00:00:00Z") });
    const hotels = [first, second];

    expect(hotelForDate(hotels, "2026-09-15").id).toBe(1);
    expect(hotelForDate(hotels, "2026-09-16").id).toBe(2);  // the day itself, not the day after
    expect(hotelForDate(hotels, "2026-09-17").id).toBe(2);
  });

  it("stays on the latest hotel pinned on or before the day, through three of them", () => {
    const hotels = [
      hotel({ id: 1 }),
      hotel({ id: 3, pinned_day: "2026-09-20" }),
      hotel({ id: 2, pinned_day: "2026-09-16" }),
    ];
    expect(hotelForDate(hotels, "2026-09-19").id).toBe(2);
    expect(hotelForDate(hotels, "2026-09-21").id).toBe(3);
  });

  it("falls back to the earliest pinned hotel for days before any pin", () => {
    // Otherwise a trip whose only hotel is pinned to day three has no hotel at
    // all on days one and two, and the solve fails instead of being slightly off.
    const hotels = [hotel({ id: 2, pinned_day: "2026-09-16" })];
    expect(hotelForDate(hotels, "2026-09-14").id).toBe(2);
  });
});

describe("mapping a row to a place", () => {
  it("lowercases the kind the schema spells in capitals", () => {
    expect(toPlace(sight()).kind).toBe("sight");
  });

  it("leaves duration and hours out entirely when they are not set", () => {
    // Not sent as null: the solver has its own defaults for "unspecified", and
    // an explicit null would override them with nothing.
    const place = toPlace(sight({ duration: null, hours: null }));
    expect("duration" in place).toBe(false);
    expect("hours" in place).toBe(false);
  });

  it("keeps a place that could not be geocoded, with null coordinates", () => {
    // The solver reports it as dropped, which is a better answer than refusing
    // to plan the trip or silently discarding somewhere the user typed in.
    const place = toPlace(sight({ lat: null, lon: null }));
    expect(place.lat).toBeNull();
    expect(place.lon).toBeNull();
    expect(place.name).toBe("Louvre");
  });

  it("passes opening hours through untouched", () => {
    const hours = { mon: [], tue: [[570, 1080], [1200, 1350]] };
    expect(toPlace(sight({ hours })).hours).toEqual(hours);
  });
});

describe("building the whole request", () => {
  it("produces one day per calendar day, each anchored at the hotel", () => {
    const request = buildPlanRequest(trip(), [hotel(), sight()]);
    expect(request.days.map((d) => d.date))
      .toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
    expect(request.days.every((d) => d.hotel_id === 1)).toBe(true);
  });

  it("marks the wet days from the forecast already synced to the trip", () => {
    const request = buildPlanRequest(
      trip({ weather_data: { days: [{ date: "2026-09-15", precip_avg: 6 }] } }),
      [hotel(), sight()]
    );
    expect(request.days.map((d) => d.wet)).toEqual([false, true, false]);
  });

  it("sends the hotel along with everything else", () => {
    // The solver looks hotel_id up in `places`, so leaving the hotel out of the
    // list makes every day fail to resolve its own depot.
    const request = buildPlanRequest(trip(), [hotel(), sight()]);
    expect(request.places.map((p) => p.id)).toEqual([1, 2]);
  });

  it("defaults the day to 09:00–22:00 and lets options move it", () => {
    expect(buildPlanRequest(trip(), [hotel()]).days[0]).toMatchObject({ start: 540, end: 1320 });
    const early = buildPlanRequest(trip(), [hotel()], { day_start: 480, day_end: 1260 });
    expect(early.days[0]).toMatchObject({ start: 480, end: 1260 });
  });

  it("only sends balance and transit when they were actually asked for", () => {
    const bare = buildPlanRequest(trip(), [hotel()]);
    expect("balance" in bare).toBe(false);
    expect("transit" in bare).toBe(false);

    const full = buildPlanRequest(trip(), [hotel()], { transit: true, balance: 0 });
    expect(full.transit).toBe(true);
    expect(full.balance).toBe(0);
  });

  it("refuses a trip with no dates, saying what to do about it", () => {
    expect(() => buildPlanRequest(trip({ start_date: null }), [hotel()]))
      .toThrow(PlanInputError);
    expect(() => buildPlanRequest(trip({ start_date: null }), [hotel()]))
      .toThrow(/start and end dates/);
  });

  it("refuses a trip with no hotel", () => {
    expect(() => buildPlanRequest(trip(), [sight()])).toThrow(/hotel/);
  });

  it("refuses a hotel that was never geocoded", () => {
    // Every day starts and ends there, so an unplaceable hotel is not one
    // dropped place — it is a trip with no shape at all.
    expect(() => buildPlanRequest(trip(), [hotel({ lat: null, lon: null }), sight()]))
      .toThrow(/coordinates/);
  });

  it("refuses a trip that ends before it starts", () => {
    const backwards = trip({ end_date: new Date("2026-09-01T00:00:00Z") });
    expect(() => buildPlanRequest(backwards, [hotel()])).toThrow(/ends before/);
  });

  it("refuses a trip long enough to be a typo", () => {
    const long = trip({ end_date: new Date("2027-09-14T00:00:00Z") });
    expect(() => buildPlanRequest(long, [hotel()])).toThrow(new RegExp(`${MAX_DAYS} days`));
  });
});

describe("passing bookings to the solver", () => {
  it("sends a booking through when there is one", () => {
    const booked = sight({ arrive_after: 840, arrive_by: 840 });
    const request = buildPlanRequest(trip(), [hotel(), booked]);
    expect(request.places[1]).toMatchObject({ arrive_after: 840, arrive_by: 840 });
  });

  it("leaves the fields out entirely when nothing is booked", () => {
    // Same rule as duration and hours: omitted rather than null, so the solver's
    // "no constraint" stays distinguishable from a constraint of nothing.
    const request = buildPlanRequest(trip(), [hotel(), sight()]);
    expect("arrive_by" in request.places[1]).toBe(false);
    expect("arrive_after" in request.places[1]).toBe(false);
  });
});

describe("stretching a day to fit a booking", () => {
  const booked = (over) => sight({ id: 3, duration: 120, ...over });

  it("leaves an ordinary day alone", () => {
    expect(dayBounds([sight()], "2026-09-15", 540, 1320))
      .toMatchObject({ start: 540, end: 1320 });
  });

  it("runs past midnight for an event that finishes after it", () => {
    // 22:30 plus two hours is 00:30, which is 1470 — minutes count from the
    // start of the day and are not wrapped. Capping at 1440 instead made this
    // come back as a time conflict, which is a wrong answer to a real plan.
    // The extra 90 is the journey home: the solver puts the hotel at both ends
    // of a day and the return leg has to land inside the window too.
    expect(dayBounds([booked({ arrive_by: 1350, arrive_after: 1350 })], "2026-09-15", 540, 1320))
      .toMatchObject({ start: 540, end: 1560 });
  });

  it("starts early enough to travel to a dawn booking", () => {
    expect(dayBounds([booked({ arrive_after: 360 })], "2026-09-15", 540, 1320).start).toBe(270);
  });

  it("never starts before midnight", () => {
    expect(dayBounds([booked({ arrive_after: 30 })], "2026-09-15", 540, 1320).start).toBe(0);
  });

  it("only stretches the day a pinned booking is actually on", () => {
    const pinned = booked({ arrive_after: 1350, arrive_by: 1350, pinned_day: "2026-09-16" });
    expect(dayBounds([pinned], "2026-09-15", 540, 1320).end).toBe(1320);
    expect(dayBounds([pinned], "2026-09-16", 540, 1320).end).toBe(1560);
  });

  it("stretches every day for a booking pinned to none of them", () => {
    // An unpinned booking could land anywhere, so every day has to be able to
    // hold it. Refusing to schedule it at all would be the worse answer.
    const loose = booked({ arrive_after: 1320, arrive_by: 1320 });
    expect(dayBounds([loose], "2026-09-15", 540, 1320).end).toBe(1530);
  });

  it("stops at 04:00, because a day ending at breakfast is a typo not a night out", () => {
    expect(dayBounds([booked({ arrive_after: 1439, arrive_by: 1439, duration: 600 })], "2026-09-15", 540, 1320).end)
      .toBe(1680);
  });

  it("assumes an hour for a booking with no duration set", () => {
    expect(dayBounds([sight({ arrive_after: 1300, arrive_by: 1300 })], "2026-09-15", 540, 1320).end)
      .toBe(1450);
  });
});

describe("overruling the opening hours", () => {
  it("passes the override through, and omits it when it is off", () => {
    expect(toPlace(sight({ ignore_hours: true })).ignore_hours).toBe(true);
    expect("ignore_hours" in toPlace(sight())).toBe(false);
  });
});

describe("keeping a place the solver wanted to drop", () => {
  const trip = { start_date: "2026-09-14", end_date: "2026-09-15" };
  const places = [
    { id: 1, name: "Hotel", kind: "HOTEL", lat: 52.52, lon: 13.4 },
    { id: 2, name: "Theatre", kind: "SIGHT", lat: 52.49, lon: 13.42 },
  ];

  it("passes on the ids the user decided to keep", () => {
    expect(buildPlanRequest(trip, places, { force: [2] }).force).toEqual([2]);
  });

  it("drops an id that is not on this trip", () => {
    // The solver ignores a forced id it cannot match, which would look exactly
    // like the button doing nothing.
    expect(buildPlanRequest(trip, places, { force: [2, 999] }).force).toEqual([2]);
  });

  it("takes an id that arrived as a string", () => {
    // Route parameters and JSON round-trips both produce these, and the solver
    // matches ids by identity: "2" is not 2.
    expect(buildPlanRequest(trip, places, { force: ["2"] }).force).toEqual([2]);
  });

  it("says nothing about forcing when nothing was forced", () => {
    // An empty list would be harmless but is still a claim; omitting it keeps
    // a normal solve byte-identical to what it was before this existed.
    for (const force of [undefined, [], null, "nope"]) {
      expect(buildPlanRequest(trip, places, { force })).not.toHaveProperty("force");
    }
  });
});

describe("landing and departing", () => {
  const bounds = { start: 540, end: 1320, core_start: 540, core_end: 1320 };
  const both = { first: true, last: true };

  it("does not offer a morning on a day you land in the afternoon", () => {
    expect(travelBounds(bounds, { arrival: 840, first: true }).start).toBe(840);
  });

  it("does not offer an evening on a day you fly out at eleven", () => {
    expect(travelBounds(bounds, { departure: 660, last: true }).end).toBe(660);
  });

  it("leaves the days in the middle of the trip alone", () => {
    // Only the ends of a trip are not yours from start to finish.
    expect(travelBounds(bounds, { arrival: 840, departure: 660 })).toEqual(bounds);
  });

  it("widens the day for a late landing rather than refusing it", () => {
    // A window of [23:00, 22:00] is not a short day, it is an infeasible one,
    // and the solver would correctly return nothing for the whole trip.
    const got = travelBounds(bounds, { arrival: 1380, first: true });
    expect(got.end).toBeGreaterThan(got.start);
  });

  it("widens it backwards for a departure before the day would have started", () => {
    const got = travelBounds(bounds, { departure: 400, last: true });
    expect(got.start).toBeLessThan(got.end);
    expect(got.start).toBeGreaterThanOrEqual(0);
  });

  it("applies both to the only day of a one-day trip", () => {
    const got = travelBounds(bounds, { arrival: 600, departure: 1200, ...both });
    expect(got).toMatchObject({ start: 600, end: 1200 });
  });

  it("changes nothing when no times are recorded", () => {
    expect(travelBounds(bounds, both)).toEqual(bounds);
    expect(travelBounds(bounds, { arrival: null, departure: null, ...both })).toEqual(bounds);
  });

  it("keeps midnight as the earliest a day can start", () => {
    expect(travelBounds({ start: 60, end: 120 }, { departure: 30, last: true }).start).toBe(0);
  });
});

describe("where the first and last day begin and end", () => {
  const places = [
    { id: 1, name: "Hotel", kind: "HOTEL", lat: 52.52, lon: 13.4 },
    { id: 2, name: "Airport", kind: "SIGHT", lat: 52.36, lon: 13.5 },
    { id: 3, name: "Museum", kind: "SIGHT", lat: 52.51, lon: 13.39 },
  ];
  const trip = { start_date: "2026-09-14", end_date: "2026-09-16" };

  it("starts the first day at the terminal and ends the last one there", () => {
    const got = buildPlanRequest(trip, places, {}, ).days;
    expect(got[0]).not.toHaveProperty("start_id");

    const withTravel = buildPlanRequest(
      { ...trip, arrival_place_id: 2, departure_place_id: 2 }, places, {}
    ).days;
    expect(withTravel[0].start_id).toBe(2);
    expect(withTravel[0]).not.toHaveProperty("end_id");
    expect(withTravel[2].end_id).toBe(2);
    expect(withTravel[2]).not.toHaveProperty("start_id");
  });

  it("leaves the middle days at the hotel", () => {
    const got = buildPlanRequest(
      { ...trip, arrival_place_id: 2, departure_place_id: 2 }, places, {}
    ).days;
    expect(got[1]).not.toHaveProperty("start_id");
    expect(got[1]).not.toHaveProperty("end_id");
  });

  it("ignores a terminal that is no longer on the trip", () => {
    // The airport was deleted, or the trip was copied. Passing the stale id on
    // would make the solver refuse to plan anything at all, taking the whole
    // trip down over a field nobody remembers setting.
    const got = buildPlanRequest({ ...trip, arrival_place_id: 999 }, places, {}).days;
    expect(got[0]).not.toHaveProperty("start_id");
  });

  it("uses the same day for both ends of a one-day trip", () => {
    const oneDay = { start_date: "2026-09-14", end_date: "2026-09-14",
      arrival_place_id: 2, departure_place_id: 2 };
    const [only] = buildPlanRequest(oneDay, places, {}).days;
    expect(only.start_id).toBe(2);
    expect(only.end_id).toBe(2);
  });
});

describe("keeping ordinary sightseeing out of a stretched night", () => {
  it("reports the hours you would plan in alongside the ones the day may use", () => {
    // One 23:00 booking stretched the whole day and everything with no opening
    // hours became schedulable in the stretch — a real plan came back with a
    // church at 22:05, a monument at 23:41 and a waterfall at 00:43.
    const booked = [{ id: 9, arrive_by: 1320, duration: 120 }];
    const got = dayBounds(booked, "2026-09-03", 540, 1320);
    expect(got.end).toBeGreaterThan(1320);
    expect(got.core_end).toBe(1320);
    expect(got.core_start).toBe(540);
  });

  it("keeps the core window where it was on a day nothing stretched", () => {
    const got = dayBounds([], "2026-09-03", 540, 1320);
    expect(got).toMatchObject({ start: 540, end: 1320, core_start: 540, core_end: 1320 });
  });

  it("still holds the core window back to when you land", () => {
    const got = travelBounds(
      { start: 540, end: 1530, core_start: 540, core_end: 1320 },
      { arrival: 690, first: true }
    );
    expect(got.core_start).toBe(690);
    expect(got.end).toBe(1530);
  });

  it("leaves no sightseeing hours at all on a day you land at nine at night", () => {
    // An inverted core window would be read as a range rather than as none.
    const got = travelBounds(
      { start: 540, end: 1320, core_start: 540, core_end: 1320 },
      { arrival: 1300, first: true }
    );
    expect(got.core_start).toBeLessThanOrEqual(got.core_end);
  });
});

describe("when you are actually free on a day you land", () => {
  const places = [
    { id: 1, name: "Hotel", kind: "HOTEL", lat: 52.52, lon: 13.4 },
    { id: 2, name: "Airport", kind: "SIGHT", lat: 52.36, lon: 13.5 },
  ];
  const trip = { start_date: "2026-09-14", end_date: "2026-09-16", arrival_time: 690 };

  it("adds the transfer when no terminal was named", () => {
    // The day starts at the hotel, so "landing at 11:30" cannot mean standing
    // in the lobby at 11:30 having teleported out of the airport. It did.
    const [first] = buildPlanRequest(trip, places, {}).days;
    expect(first.start).toBe(690 + 60);
  });

  it("uses the landing time as given when the day starts at the terminal", () => {
    // The solver routes the transfer itself, so adding it here would charge for
    // the same journey twice.
    const [first] = buildPlanRequest({ ...trip, arrival_place_id: 2 }, places, {}).days;
    expect(first.start).toBe(690);
    expect(first.start_id).toBe(2);
  });

  it("respects a transfer time the traveller set", () => {
    const [first] = buildPlanRequest({ ...trip, transfer_minutes: 25 }, places, {}).days;
    expect(first.start).toBe(690 + 25);
  });

  it("subtracts it the other way round on the day you leave", () => {
    const days = buildPlanRequest({ ...trip, departure_time: 660 }, places, {}).days;
    expect(days[days.length - 1].end).toBe(660 - 60);
  });
});
