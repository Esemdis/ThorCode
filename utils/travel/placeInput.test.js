import { describe, it, expect } from 'vitest';
import { normalisePlaceInput, checkHours, MAX_DURATION_MIN } from './placeInput.js';

const ok = (body, options) => {
  const result = normalisePlaceInput(body, options);
  expect(result.error).toBeUndefined();
  return result.data;
};
const err = (body, options) => normalisePlaceInput(body, options).error;

describe("opening hours", () => {
  it("accepts a normal day and a split one", () => {
    expect(checkHours({ tue: [[570, 1080]], wed: [[570, 780], [900, 1080]] })).toBeNull();
  });

  it("accepts an explicit empty list, which is how a closed day is said", () => {
    expect(checkHours({ mon: [] })).toBeNull();
  });

  it("accepts hours being absent entirely", () => {
    expect(checkHours(null)).toBeNull();
  });

  it("rejects a weekday nobody will have meant", () => {
    expect(checkHours({ tuesday: [[570, 1080]] })).toMatch(/unknown weekday/);
  });

  it("rejects a window that closes before it opens", () => {
    expect(checkHours({ tue: [[1080, 570]] })).toMatch(/closes at or before/);
  });

  it("rejects a zero-length window, which is always a form defaulting both ends", () => {
    expect(checkHours({ tue: [[1080, 1080]] })).toMatch(/closes at or before/);
  });

  it("rejects times outside the day", () => {
    expect(checkHours({ tue: [[-10, 600]] })).toMatch(/between 0 and 1440/);
    expect(checkHours({ tue: [[600, 1500]] })).toMatch(/between 0 and 1440/);
  });

  it("rejects times that are not whole minutes", () => {
    // A float here survives the write and only surfaces inside the solver.
    expect(checkHours({ tue: [[570.5, 1080]] })).toMatch(/whole minutes/);
  });

  it("rejects a list of one, which is a pair somebody flattened", () => {
    expect(checkHours({ tue: [[570]] })).toMatch(/\[open, close\] pairs/);
  });

  it("rejects an array where the object should be", () => {
    expect(checkHours([[570, 1080]])).toMatch(/keyed by weekday/);
  });
});

describe("saving a place", () => {
  it("needs a name on create but not on update", () => {
    expect(err({})).toMatch(/needs a name/);
    expect(ok({ priority: 2 }, { partial: true })).toEqual({ priority: 2 });
  });

  it("leaves untouched fields out of an update instead of defaulting them", () => {
    // The difference between PATCH and POST: an absent field here must not
    // become a default, or editing a note would reset the priority.
    const data = ok({ note: "timed entry 14:00" }, { partial: true });
    expect(Object.keys(data)).toEqual(["note"]);
  });

  it("takes the kind in any case the client feels like sending", () => {
    expect(ok({ name: "X", kind: "food" }).kind).toBe("FOOD");
  });

  it("rejects a kind the solver would not understand", () => {
    expect(err({ name: "X", kind: "museum" })).toMatch(/kind must be one of/);
  });

  it("insists on both halves of a coordinate or neither", () => {
    // Half a coordinate is not a location, and storing one puts the place on
    // the prime meridian.
    expect(err({ name: "X", lat: 48.85 })).toMatch(/both lat and lon/);
    expect(ok({ name: "X", lat: null, lon: null })).toMatchObject({ lat: null, lon: null });
  });

  it("rejects coordinates off the globe", () => {
    expect(err({ name: "X", lat: 95, lon: 2 })).toMatch(/lat is out of range/);
    expect(err({ name: "X", lat: 48, lon: 200 })).toMatch(/lon is out of range/);
  });

  it("keeps priority inside the range the drop penalty is scaled against", () => {
    expect(err({ name: "X", priority: 0 })).toMatch(/between 1 and 5/);
    expect(err({ name: "X", priority: 9 })).toMatch(/between 1 and 5/);
    expect(ok({ name: "X", priority: 5 }).priority).toBe(5);
  });

  it("rejects a duration long enough to make every day unsatisfiable", () => {
    expect(err({ name: "X", duration: 5000 })).toMatch(new RegExp(`${MAX_DURATION_MIN} minutes`));
  });

  it("allows clearing a duration back to the solver's own default", () => {
    expect(ok({ name: "X", duration: null }).duration).toBeNull();
  });

  it("stores a pinned day as the calendar day that was sent", () => {
    const data = ok({ name: "X", pinned_day: "2026-09-14" });
    expect(data.pinned_day.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("rejects a pinned day that is not a date", () => {
    expect(err({ name: "X", pinned_day: "next tuesday" })).toMatch(/YYYY-MM-DD/);
  });

  it("treats an empty pinned day as clearing it", () => {
    expect(ok({ name: "X", pinned_day: "" }).pinned_day).toBeNull();
  });

  it("trims the free text and turns blank into null", () => {
    const data = ok({ name: "  Louvre  ", note: "   ", url: " http://x " });
    expect(data.name).toBe("Louvre");
    expect(data.note).toBeNull();
    expect(data.url).toBe("http://x");
  });
});

describe("booking times", () => {
  it("takes a time of day as minutes since midnight", () => {
    expect(ok({ name: "X", arrive_after: 840, arrive_by: 840 }))
      .toMatchObject({ arrive_after: 840, arrive_by: 840 });
  });

  it("allows a deadline with no earliest time, and the reverse", () => {
    expect(ok({ name: "X", arrive_by: 840 }).arrive_by).toBe(840);
    expect(ok({ name: "X", arrive_after: 600 }).arrive_after).toBe(600);
  });

  it("refuses a booking that starts after it has to be over", () => {
    expect(err({ name: "X", arrive_after: 900, arrive_by: 600 }))
      .toMatch(/cannot start after/);
  });

  it("refuses a time that is not one", () => {
    expect(err({ name: "X", arrive_by: 2000 })).toMatch(/time of day/);
    expect(err({ name: "X", arrive_by: -5 })).toMatch(/time of day/);
  });

  it("allows clearing a booking", () => {
    expect(ok({ name: "X", arrive_after: null, arrive_by: null }))
      .toMatchObject({ arrive_after: null, arrive_by: null });
    expect(ok({ name: "X", arrive_by: "" }).arrive_by).toBeNull();
  });

  it("leaves a booking alone on an update that does not mention it", () => {
    const data = ok({ note: "n" }, { partial: true });
    expect("arrive_by" in data).toBe(false);
  });
});

describe("overruling the opening hours", () => {
  it("stores the override without discarding the hours themselves", () => {
    // The hours stay worth knowing even when they are not being enforced.
    const data = ok({ name: "X", ignore_hours: true, hours: { mon: [] } });
    expect(data.ignore_hours).toBe(true);
    expect(data.hours).toEqual({ mon: [] });
  });

  it("defaults to off by leaving it out of an update that does not mention it", () => {
    expect("ignore_hours" in ok({ note: "n" }, { partial: true })).toBe(false);
  });
});
