/**
 * The payload behind the band Photos tab.
 *
 * Shaped here rather than in the client because the interesting parts — "7 of 9
 * shows", a per-year series with its gaps filled, a rail that includes shows
 * you attended and shot nothing at — are arithmetic, and arithmetic belongs
 * somewhere it can be tested without mounting a modal.
 */

// Dates on a concert are calendar days. Slicing the year out of the string
// avoids Date entirely, which would otherwise shift a January show into the
// previous year for anyone west of UTC.
const yearOf = (isoDate) => parseInt(String(isoDate).slice(0, 4), 10);

function bandMediaOverview({ attendances, media, urlFor }) {
  const byAttendance = new Map(attendances.map((a) => [a.id, a]));

  const withShow = media
    .map((m) => {
      const attended = byAttendance.get(m.attendance_id);
      if (!attended) return null;
      return {
        ...m,
        ...urlFor(m.id),
        concert_id: attended.concert.id,
        concert_date: attended.concert.date,
        venue: attended.concert.venue,
        city: attended.concert.city,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.concert_date.localeCompare(a.concert_date) || b.id - a.id);

  const counts = new Map();
  for (const m of withShow) counts.set(m.attendance_id, (counts.get(m.attendance_id) ?? 0) + 1);

  const rail = [...attendances]
    .sort((a, b) => b.concert.date.localeCompare(a.concert.date))
    .map((a) => ({
      attendance_id: a.id,
      concert_id: a.concert.id,
      date: a.concert.date,
      venue: a.concert.venue,
      city: a.concert.city,
      count: counts.get(a.id) ?? 0,
      // The bill travels with the row: the lightbox's band picker and the
      // upload dialog's batch band both offer exactly these, and neither should
      // cost a request of its own to find out who played.
      bands: a.concert.bands ?? [],
    }));

  const years = withShow.map((m) => yearOf(m.concert_date));
  const first = years.length ? Math.min(...years) : null;
  const last = years.length ? Math.max(...years) : null;

  // Every year in the span gets an entry, including the ones with nothing in
  // them: the sparkline is a shape, and omitting an empty year would draw two
  // distant years as adjacent bars and read as a steady run.
  const perYear = [];
  if (first !== null) {
    const tally = years.reduce((acc, y) => acc.set(y, (acc.get(y) ?? 0) + 1), new Map());
    for (let y = first; y <= last; y++) perYear.push({ year: y, count: tally.get(y) ?? 0 });
  }

  return {
    stats: {
      files: withShow.length,
      videos: withShow.filter((m) => m.kind === 'VIDEO').length,
      shows_with_media: counts.size,
      shows_attended: attendances.length,
      first_year: first,
      last_year: last,
      per_year: perYear,
    },
    rail,
    files: withShow,
  };
}

module.exports = { bandMediaOverview };
