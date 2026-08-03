/**
 * The language a place's name is most likely written in, for Wikipedia.
 *
 * English Wikipedia files the Berliner Dom under "Berlin Cathedral", and those
 * two names share no words at all — so a trip whose places are written the way
 * they appear on the building finds nothing. German Wikipedia has it under
 * exactly what was typed, and the article links across to the English one.
 *
 * A short list rather than a taxonomy. It covers the destinations this app is
 * actually used for; anything unlisted simply gets English, which is the same
 * behaviour as before this existed. Matching is on the destination text because
 * that is all a trip records — "Berlin, Germany" and "berlin" both work.
 */

const BY_COUNTRY = [
  [["germany", "deutschland", "berlin", "munich", "münchen", "hamburg", "cologne", "köln"], "de"],
  [["france", "paris", "lyon", "marseille", "nice", "bordeaux"], "fr"],
  [["spain", "españa", "madrid", "barcelona", "seville", "sevilla", "valencia"], "es"],
  [["italy", "italia", "rome", "roma", "milan", "milano", "venice", "venezia", "florence"], "it"],
  [["netherlands", "amsterdam", "rotterdam", "utrecht"], "nl"],
  [["portugal", "lisbon", "lisboa", "porto"], "pt"],
  [["poland", "polska", "warsaw", "warszawa", "krakow", "kraków"], "pl"],
  [["sweden", "sverige", "stockholm", "gothenburg", "göteborg", "malmö"], "sv"],
  [["norway", "norge", "oslo", "bergen"], "no"],
  [["denmark", "danmark", "copenhagen", "københavn"], "da"],
  [["finland", "suomi", "helsinki"], "fi"],
  [["czech", "prague", "praha"], "cs"],
  [["austria", "österreich", "vienna", "wien", "salzburg"], "de"],
  [["switzerland", "zurich", "zürich", "geneva", "bern"], "de"],
  [["greece", "athens", "thessaloniki"], "el"],
  [["hungary", "budapest"], "hu"],
  [["japan", "tokyo", "kyoto", "osaka"], "ja"],
];

/**
 * Wikipedia languages to try, in order. English first — it is the one you want
 * to read in, and a match found elsewhere is translated back to it where the
 * article exists in both.
 */
function wikipediaLanguages(destination) {
  const text = String(destination ?? "").toLowerCase();
  for (const [needles, lang] of BY_COUNTRY) {
    if (needles.some((n) => text.includes(n))) {
      return lang === "en" ? ["en"] : ["en", lang];
    }
  }
  return ["en"];
}

module.exports = { wikipediaLanguages };
