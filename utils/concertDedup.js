const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Primitive helpers ────────────────────────────────────────────────────────

// Normalize a date to midnight UTC on its calendar day
function toUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Haversine distance in km between two lat/lng points
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns true if both concerts have coordinates and are within 20km of each other
function sameArea(incoming, existing) {
  const iLat = parseFloat(incoming.latitude), iLng = parseFloat(incoming.longitude);
  const eLat = parseFloat(existing.latitude), eLng = parseFloat(existing.longitude);
  if (!iLat || !iLng || !eLat || !eLng) return false;
  return haversineKm(iLat, iLng, eLat, eLng) <= 20;
}

// Normalize a venue string for substring containment checks (strips accents, punctuation, case)
function normalizeVenueFlat(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Returns true if one venue name is substantially contained within the other.
// Catches cases like "Zenith De Nancy - Amphitheatre Plein Air" containing "Amphitheatre Plein Air".
// Requires the shorter fragment to be at least 10 chars to avoid trivial matches.
function venueContains(a, b) {
  const na = normalizeVenueFlat(a), nb = normalizeVenueFlat(b);
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  return shorter.length >= 10 && longer.includes(shorter);
}

// Bigram Dice coefficient — returns 0.0–1.0. Unicode-safe: keeps all letters/numbers.
function stringSimilarity(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const bigrams = (s) => Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2));
  const ba = bigrams(na), bb = bigrams(nb);
  if (!ba.length || !bb.length) return 0;
  const bbCount = new Map();
  for (const g of bb) bbCount.set(g, (bbCount.get(g) || 0) + 1);
  let matches = 0;
  for (const g of ba) if (bbCount.get(g) > 0) { matches++; bbCount.set(g, bbCount.get(g) - 1); }
  return (2 * matches) / (ba.length + bb.length);
}

// ─── Insert-time deduplication (DB) ──────────────────────────────────────────

/**
 * Pre-deduplicates an incoming bulk concert payload by coordinates before DB insert.
 * For each coordinate bucket, keeps the entry with the most bands.
 * Concerts without coordinates are passed through unchanged.
 */
function deduplicateByCoords(concerts) {
  const coordKey = (c) =>
    c.latitude != null && c.longitude != null
      ? `${Math.round(c.latitude / 0.001)}:${Math.round(c.longitude / 0.001)}`
      : null;

  const { coordMap, noCoord } = concerts.reduce(
    (acc, concert) => {
      const key = coordKey(concert);
      if (!key) { acc.noCoord.push(concert); return acc; }
      const existing = acc.coordMap.get(key);
      if (!existing || (concert.bands?.length ?? 0) > (existing.bands?.length ?? 0)) {
        acc.coordMap.set(key, concert);
      }
      return acc;
    },
    { coordMap: new Map(), noCoord: [] },
  );

  return [...coordMap.values(), ...noCoord];
}

/**
 * Checks whether an incoming concert already exists in the DB and merges it if so.
 * Returns { isDuplicate, existingConcert }.
 *
 * Duplicate detection rules:
 * 1. Band-schedule conflict — same band, same city area, same calendar day
 * 2. Named event match — name similarity ≥ 80%, same area, within 3 days
 * 3. Venue fuzzy match — venue similarity ≥ 70%, within date window
 * 4. City fuzzy match fallback — city similarity ≥ 70%, within date window
 */
async function checkDuplicateConcert({ concert, bandIds, tx }) {
  let existingConcert = null;

  if (concert.concert_date) {
    const dayStart = toUtcDay(concert.concert_date);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const incomingIsMultiBand = concert.festival || bandIds.length >= 3;

    const candidates = await tx.concert.findMany({
      where: {
        concert_date: {
          gte: new Date(dayStart.getTime() - 7 * oneDayMs),
          lte: new Date(dayStart.getTime() + 7 * oneDayMs),
        },
      },
      include: { bands: true },
    });

    const diffDays = (c) => Math.abs(toUtcDay(c.concert_date).getTime() - dayStart.getTime()) / oneDayMs;
    const isMultiBand = (c) => c.festival || c.bands.length >= 3;
    const sharesABand = (c) => c.bands.some((ref) => bandIds.includes(ref.band));

    // 0. Band-schedule conflict
    if (bandIds.length > 0) {
      const sameDayCandidates = candidates.filter((c) => diffDays(c) === 0);
      for (const c of sameDayCandidates) {
        if (!sharesABand(c)) continue;
        const inSameArea = sameArea(concert, c) ||
          (concert.city && c.city && stringSimilarity(concert.city, c.city) >= 0.7);
        if (inSameArea) { existingConcert = c; break; }
      }
    }

    // 0.5. Named event match
    if (!existingConcert && concert.name) {
      const nameCandidates = candidates
        .filter((c) => {
          if (!c.name) return false;
          if (diffDays(c) > 3) return false;
          if (stringSimilarity(concert.name, c.name) < 0.8) return false;
          return sameArea(concert, c) ||
            (concert.city && c.city && stringSimilarity(concert.city, c.city) >= 0.7);
        })
        .sort((a, b) => b.bands.length - a.bands.length);
      existingConcert = nameCandidates[0] ?? null;
    }

    // 1. Venue fuzzy match
    if (!existingConcert && concert.venue) {
      const venueMatches = candidates
        .filter((c) => c.venue)
        .map((c) => ({ c, sim: stringSimilarity(concert.venue, c.venue) }))
        .filter(({ c, sim }) => {
          const venueMatch = sim >= 0.7 || venueContains(concert.venue, c.venue);
          if (!venueMatch) return false;
          const eitherIsMultiBand = incomingIsMultiBand || isMultiBand(c);
          const d = diffDays(c);
          const highConfidence = d === 0 && (sim >= 0.95 || venueContains(concert.venue, c.venue));
          if (bandIds.length > 0 && !sharesABand(c) && !eitherIsMultiBand && !highConfidence) return false;
          return d <= 1.5 || eitherIsMultiBand || highConfidence;
        })
        .filter(({ c }) => diffDays(c) <= 7)
        .sort((a, b) => b.c.bands.length - a.c.bands.length || b.sim - a.sim);
      existingConcert = venueMatches[0]?.c ?? null;
    }

    // 2. City fuzzy match fallback
    if (!existingConcert && concert.city) {
      const cityMatches = candidates
        .filter((c) => {
          const eitherIsMultiBand = incomingIsMultiBand || isMultiBand(c);
          if (bandIds.length > 0 && !sharesABand(c) && !eitherIsMultiBand) return false;
          const d = diffDays(c);
          return d <= (eitherIsMultiBand ? 7 : 1.5);
        })
        .filter((c) => {
          const eitherIsMultiBand = incomingIsMultiBand || isMultiBand(c);
          return (eitherIsMultiBand && sameArea(concert, c)) ||
            (c.city && stringSimilarity(concert.city, c.city) >= 0.7);
        })
        .sort((a, b) => b.bands.length - a.bands.length);
      existingConcert = cityMatches[0] ?? null;
    }
  }

  if (existingConcert) {
    const incomingWins = bandIds.length > existingConcert.bands.length;
    const isAtFormat = (s) => s.includes(' @ ') || / at /i.test(s);
    const existingIsAtFormat = isAtFormat(existingConcert.name || '');
    const incomingIsAtFormat = isAtFormat(concert.name || '');
    const bestName = (!existingIsAtFormat && incomingIsAtFormat)
      ? existingConcert.name
      : (existingIsAtFormat && !incomingIsAtFormat && concert.name)
        ? concert.name
        : (concert.name && existingConcert.name && !incomingIsAtFormat && !existingIsAtFormat)
          ? (concert.name.length <= existingConcert.name.length ? concert.name : existingConcert.name)
          : concert.name || existingConcert.name;
    const hasBetterName = bestName !== existingConcert.name;

    if (incomingWins || hasBetterName) {
      await tx.concert.update({
        where: { id: existingConcert.id },
        data: {
          name: bestName,
          ...(incomingWins && {
            concert_date: concert.concert_date ? new Date(concert.concert_date) : existingConcert.concert_date,
            url: concert.url || existingConcert.url,
            metadata: concert.metadata || existingConcert.metadata,
            on_sale: concert.on_sale !== undefined ? concert.on_sale : existingConcert.on_sale,
            ticket_sale_start: concert.ticket_sale_start ? new Date(concert.ticket_sale_start) : existingConcert.ticket_sale_start,
            festival: concert.festival || existingConcert.festival,
          }),
        },
      });
    }

    const existingRefs = await tx.concertBandReference.findMany({
      where: { concert: existingConcert.id, band: { in: bandIds } },
      select: { band: true },
    });
    const linkedBandIds = new Set(existingRefs.map((r) => r.band));
    const toLink = bandIds.filter((id) => !linkedBandIds.has(id));
    if (toLink.length > 0) {
      await tx.concertBandReference.createMany({
        data: toLink.map((band) => ({ concert: existingConcert.id, band })),
      });
    }
  }

  return { isDuplicate: !!existingConcert, existingConcert };
}

// ─── Response-time deduplication (in-memory) ─────────────────────────────────

/**
 * Pass 1 — remove same-event duplicates stored as separate DB records.
 * Two concerts are considered the same event if venue similarity ≥ 70%,
 * name similarity ≥ 80%, and dates are within 7 days.
 */
function deduplicateByNameVenue(concerts) {
  const kept = [];
  for (const concert of concerts) {
    const name  = concert.name?.trim();
    const venue = concert.venue?.trim();
    const time  = concert.concert_date ? new Date(concert.concert_date).getTime() : null;

    if (!name || !venue || !time) { kept.push(concert); continue; }

    const isDup = kept.some((k) => {
      if (!k.name || !k.venue) return false;
      const kt = k.concert_date ? new Date(k.concert_date).getTime() : null;
      if (!kt || Math.abs(kt - time) > SEVEN_DAYS_MS) return false;
      return stringSimilarity(venue, k.venue) >= 0.7 || venueContains(venue, k.venue)
        ? stringSimilarity(name, k.name) >= 0.8
        : false;
    });

    if (!isDup) kept.push(concert);
  }
  return kept;
}

/**
 * Pass 2 — merge concerts on the same calendar day that share at least one
 * participating band. Bands and metadata names from duplicates are merged in.
 */
function mergeByDayAndBands(concerts) {
  const dayBuckets = new Map();
  const result = [];

  for (const concert of concerts) {
    const dateKey = concert.concert_date
      ? new Date(concert.concert_date).toISOString().slice(0, 10)
      : null;
    const bandIds = new Set((concert.participating_bands || []).map((b) => b.id));

    let mergedIdx = null;
    if (dateKey && bandIds.size > 0) {
      for (const idx of (dayBuckets.get(dateKey) || [])) {
        const ex = result[idx];
        const exIds = new Set((ex.participating_bands || []).map((b) => b.id));
        if ([...bandIds].some((id) => exIds.has(id))) { mergedIdx = idx; break; }
      }
    }

    if (mergedIdx !== null) {
      const base = result[mergedIdx];
      const baseIds = new Set((base.participating_bands || []).map((b) => b.id));
      base.participating_bands = [
        ...(base.participating_bands || []),
        ...(concert.participating_bands || []).filter((b) => !baseIds.has(b.id)),
      ];
      let baseMeta = []; try { baseMeta = JSON.parse(base.metadata || '[]'); } catch {}
      let concMeta = []; try { concMeta = JSON.parse(concert.metadata || '[]'); } catch {}
      base.metadata = JSON.stringify([...new Set([...baseMeta, ...concMeta])]);
    } else {
      const idx = result.length;
      result.push({ ...concert });
      if (dateKey) {
        if (!dayBuckets.has(dateKey)) dayBuckets.set(dateKey, []);
        dayBuckets.get(dateKey).push(idx);
      }
    }
  }

  return result;
}

/**
 * Run all in-memory deduplication passes over a flat concert array.
 * Input: concerts already deduplicated by DB id.
 */
function deduplicateConcerts(concerts) {
  return mergeByDayAndBands(deduplicateByNameVenue(concerts));
}

module.exports = {
  // Primitives (used by other modules for fuzzy matching)
  stringSimilarity,
  venueContains,
  // Insert-time
  deduplicateByCoords,
  checkDuplicateConcert,
  // Response-time
  deduplicateConcerts,
};
