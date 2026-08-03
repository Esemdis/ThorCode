import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { wikipediaLanguages } = require("./language");

describe("which Wikipedias to search", () => {
  it("always tries English first, because that is what you want to read", () => {
    expect(wikipediaLanguages("Berlin, Germany")[0]).toBe("en");
  });

  it("adds the local language so a name written on the building is found", () => {
    // English Wikipedia files the Berliner Dom under "Berlin Cathedral", and
    // the two names share no words at all.
    expect(wikipediaLanguages("Berlin, Germany")).toEqual(["en", "de"]);
    expect(wikipediaLanguages("Paris, France")).toEqual(["en", "fr"]);
  });

  it("recognises a city on its own, not only a country", () => {
    expect(wikipediaLanguages("Kraków")).toEqual(["en", "pl"]);
    expect(wikipediaLanguages("kyoto")).toEqual(["en", "ja"]);
  });

  it("reads a destination however it was capitalised", () => {
    expect(wikipediaLanguages("BERLIN")).toEqual(["en", "de"]);
  });

  it("sends Austria and Switzerland to German rather than inventing one", () => {
    expect(wikipediaLanguages("Vienna, Austria")).toEqual(["en", "de"]);
    expect(wikipediaLanguages("Zürich")).toEqual(["en", "de"]);
  });

  it("falls back to English alone for anywhere unlisted", () => {
    // The same behaviour as before this existed, which is the right failure.
    expect(wikipediaLanguages("Reykjavík, Iceland")).toEqual(["en"]);
    expect(wikipediaLanguages(null)).toEqual(["en"]);
    expect(wikipediaLanguages("")).toEqual(["en"]);
  });
});
