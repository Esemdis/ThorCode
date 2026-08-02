/**
 * A real trip's worth of places, for trying the day planner without inventing
 * data every time. Coordinates are real; opening hours are close enough to real
 * to make the closures bite.
 *
 * Only the days a place is *shut* are listed. A weekday absent from `hours`
 * means unknown, which the solver treats as open — so a museum that closes on
 * Mondays needs one line, not a seven-row grid.
 */

const sight = (name, lat, lon, over = {}) => ({ name, lat, lon, kind: "SIGHT", ...over });
const food = (name, lat, lon) => ({ name, lat, lon, kind: "FOOD" });

const CLOSED_MON = { hours: { mon: [] } };
const CLOSED_TUE = { hours: { tue: [] } };

const PLACES = [
  { name: "Hotel, Le Marais", lat: 48.8575, lon: 2.361, kind: "HOTEL" },

  // Big museums: half a day each, and each shut one day a week.
  sight("Louvre", 48.8606, 2.3376, { duration: 180, priority: 5, ...CLOSED_TUE }),
  sight("Musee d'Orsay", 48.86, 2.3266, { duration: 150, priority: 5, ...CLOSED_MON }),
  sight("Centre Pompidou", 48.8607, 2.3522, { duration: 120, priority: 3, ...CLOSED_TUE }),
  sight("Musee Picasso", 48.86, 2.3625, { duration: 90, priority: 2, ...CLOSED_MON }),
  sight("Musee Rodin", 48.8553, 2.3158, { duration: 90, priority: 3, ...CLOSED_MON }),
  sight("Musee de Cluny", 48.8506, 2.3444, { duration: 90, priority: 2, ...CLOSED_MON }),
  sight("Catacombes", 48.8338, 2.3324, { duration: 75, priority: 3, ...CLOSED_MON }),

  // The one that is genuinely a day out. Left in because watching the planner
  // decline it is more informative than watching it accept everything.
  sight("Chateau de Versailles", 48.8049, 2.1204, {
    duration: 240, priority: 4, hours: { mon: [], tue: [[540, 1050]], wed: [[540, 1050]], thu: [[540, 1050]] },
  }),

  sight("Eiffel Tower", 48.8584, 2.2945, { duration: 120, priority: 5, outdoor: true }),
  sight("Sainte-Chapelle", 48.8554, 2.345, { duration: 45, priority: 4 }),
  sight("Notre-Dame", 48.853, 2.3499, { duration: 45, priority: 4, outdoor: true }),
  sight("Sacre-Coeur", 48.8867, 2.3431, { duration: 60, priority: 3, outdoor: true }),
  sight("Arc de Triomphe", 48.8738, 2.295, { duration: 60, priority: 3, outdoor: true }),
  sight("Jardin du Luxembourg", 48.8462, 2.3372, { duration: 60, priority: 2, outdoor: true }),
  sight("Place des Vosges", 48.8555, 2.3655, { duration: 30, priority: 1, outdoor: true }),
  sight("Canal Saint-Martin", 48.8709, 2.3652, { duration: 45, priority: 1, outdoor: true }),
  sight("Shakespeare and Company", 48.8526, 2.347, { duration: 30, priority: 2 }),
  sight("Opera Garnier", 48.8719, 2.3316, { duration: 60, priority: 3 }),

  food("L'As du Fallafel", 48.8577, 2.3592),
  food("Le Comptoir du Relais", 48.8534, 2.3384),
  food("Breizh Cafe", 48.8607, 2.3627),
  food("Bouillon Chartier", 48.8719, 2.3435),
  food("Chez Janou", 48.857, 2.3665),
];

// A Monday start, so the Monday closures actually collide with day one.
const START = "2026-09-14";
const END = "2026-09-17";

module.exports = { PLACES, START, END };
