import { describe, it, expect } from 'vitest';
import {
  buildPlanRequest, PlanInputError,
  dateOnly, datesBetween, wetDates, hotelForDate, dayBounds, toPlace, MAX_DAYS,
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
    expect(dayBounds([sight()], "2026-09-15", 540, 1320)).toEqual({ start: 540, end: 1320 });
  });

  it("runs past midnight for an event that finishes after it", () => {
    // 22:30 plus two hours is 00:30, which is 1470 — minutes count from the
    // start of the day and are not wrapped. Capping at 1440 instead made this
    // come back as a time conflict, which is a wrong answer to a real plan.
    // The extra 90 is the journey home: the solver puts the hotel at both ends
    // of a day and the return leg has to land inside the window too.
    expect(dayBounds([booked({ arrive_by: 1350, arrive_after: 1350 })], "2026-09-15", 540, 1320))
      .toEqual({ start: 540, end: 1560 });
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
