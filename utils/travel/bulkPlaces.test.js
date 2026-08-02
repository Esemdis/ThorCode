import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseBulkPlaces, nameFromUrl, MAX_NAME } = require("./bulkPlaces");

const names = (text, options) => parseBulkPlaces(text, options).places.map((p) => p.name);

describe("reading a pasted list", () => {
  it("takes one place per line", () => {
    expect(names("Louvre\nOrsay\nRodin")).toEqual(["Louvre", "Orsay", "Rodin"]);
  });

  it("ignores blank lines and surrounding whitespace", () => {
    expect(names("  Louvre  \n\n\n   \n Orsay ")).toEqual(["Louvre", "Orsay"]);
  });

  it.each([
    ["- Louvre", "a dash"],
    ["* Louvre", "an asterisk"],
    ["• Louvre", "a bullet"],
    ["1. Louvre", "a number"],
    ["2) Louvre", "a number with a bracket"],
  ])("strips %s left on by whatever it was pasted from (%s)", (line) => {
    expect(names(line)).toEqual(["Louvre"]);
  });

  it("handles Windows line endings, because pasted text often has them", () => {
    expect(names("Louvre\r\nOrsay")).toEqual(["Louvre", "Orsay"]);
  });
});

describe("lines with links in them", () => {
  it("keeps the name and the link when both are given", () => {
    const { places } = parseBulkPlaces("Louvre https://maps.app.goo.gl/abc");
    expect(places).toEqual([{ name: "Louvre", url: "https://maps.app.goo.gl/abc" }]);
  });

  it("does not leave the separator dangling on the name", () => {
    expect(names("Louvre — https://maps.app.goo.gl/abc")).toEqual(["Louvre"]);
    expect(names("Louvre | https://maps.app.goo.gl/abc")).toEqual(["Louvre"]);
  });

  it("reads the name out of a Google Maps link when the line is only a link", () => {
    // A list of links you sent yourself is a real way to collect places, and
    // thirty rows called "maps.app.goo.gl" would be useless.
    expect(names("https://www.google.com/maps/place/Louvre+Museum/@48.86,2.33,17z"))
      .toEqual(["Louvre Museum"]);
  });

  it("decodes an escaped name", () => {
    expect(names("https://www.google.com/maps/place/Mus%C3%A9e+d%27Orsay/@48.8,2.3"))
      .toEqual(["Musée d'Orsay"]);
  });

  it("survives a malformed escape rather than losing the line", () => {
    // A lone % is not valid percent-encoding and decodeURIComponent throws on
    // it. Losing a pasted place to that would be silent and baffling, so the
    // raw segment is kept — the + still becomes a space, which is what a
    // Google Maps path means by it.
    expect(names("https://www.google.com/maps/place/100%+Chocolat/@48.8,2.3"))
      .toEqual(["100% Chocolat"]);
  });

  it("falls back to the host for a short link that carries no name", () => {
    expect(names("https://maps.app.goo.gl/xY7z")).toEqual(["maps.app.goo.gl"]);
  });

  it("has nothing to make a place out of when a line is only punctuation", () => {
    const { places, skipped } = parseBulkPlaces("---");
    expect(places).toEqual([]);
    expect(skipped).toEqual([{ line: "---", reason: "no_name" }]);
  });
});

describe("not creating the same place twice", () => {
  it("skips a name the trip already has", () => {
    const { places, skipped } = parseBulkPlaces("Louvre\nOrsay", { existing: ["louvre"] });
    expect(places.map((p) => p.name)).toEqual(["Orsay"]);
    expect(skipped).toEqual([{ line: "Louvre", reason: "duplicate" }]);
  });

  it("skips a repeat inside the same paste", () => {
    // Pasting the same list twice is an ordinary accident. Sixty rows is not a
    // reasonable response to it.
    expect(names("Louvre\nLouvre")).toEqual(["Louvre"]);
  });

  it("treats casing and runs of spaces as the same place", () => {
    expect(names("Louvre\n  LOUVRE  \nthe   louvre", { existing: ["the louvre"] }))
      .toEqual(["Louvre"]);
  });
});

describe("limits", () => {
  it("stops at the room left and says what it dropped", () => {
    const { places, skipped } = parseBulkPlaces("a\nb\nc\nd", { max: 2 });
    expect(places).toHaveLength(2);
    expect(skipped.map((s) => s.reason)).toEqual(["too_many", "too_many"]);
  });

  it("truncates a name to what the column holds", () => {
    const { places } = parseBulkPlaces("x".repeat(400));
    expect(places[0].name).toHaveLength(MAX_NAME);
  });

  it("reads nothing out of nothing", () => {
    for (const empty of [null, undefined, "", "   "]) {
      expect(parseBulkPlaces(empty)).toEqual({ places: [], skipped: [] });
    }
  });
});

describe("names out of URLs on their own", () => {
  it("stops at the query string rather than swallowing it", () => {
    expect(nameFromUrl("https://maps.google.com/maps/place/Rodin?hl=en")).toBe("Rodin");
  });

  it("has no name to offer for a link with no place in it", () => {
    expect(nameFromUrl("https://example.com/")).toBe("example.com");
  });
});
