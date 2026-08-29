import { describe, it, expect } from 'vitest';
import { collapseDuplicates } from './attractions.js';

const at = (name, upcomingEvents, id = name) => ({ id, name, upcomingEvents });

describe('collapseDuplicates', () => {
  it('keeps the duplicate that still has shows', () => {
    // Ticketmaster carries re-registrations: two "Augustine" attractions with
    // different ids, and for "Architects" a live record alongside a dead one.
    const out = collapseDuplicates([at('Architects', 0, 'dead'), at('Architects', 3, 'live')]);

    expect(out.map((a) => a.id)).toEqual(['live']);
  });

  it('keeps the higher-ranked row when the counts tie', () => {
    // Both Augustine records have 0 upcoming events. Ticketmaster returns them
    // in relevance order, so the first is the better guess.
    const out = collapseDuplicates([at('Augustine', 0, 'first'), at('Augustine', 0, 'second')]);

    expect(out.map((a) => a.id)).toEqual(['first']);
  });

  it('does not collapse names that differ by a parenthetical', () => {
    // canonicalBandName strips a trailing "(UK)", which would merge these two —
    // but they are separate live acts with separate tours, 3 shows and 5. This
    // match is deliberately exact for that reason.
    const out = collapseDuplicates([at('Architects', 3), at('Architects (UK)', 5)]);

    expect(out.map((a) => a.name)).toEqual(['Architects', 'Architects (UK)']);
  });

  it('treats case and surrounding whitespace as the same name', () => {
    const out = collapseDuplicates([at('Augustine', 0, 'a'), at('  augustine ', 2, 'b')]);

    expect(out.map((a) => a.id)).toEqual(['b']);
  });

  it('keeps the surviving rows in Ticketmaster order', () => {
    const out = collapseDuplicates([at('Gojira', 1), at('Augustine', 0, 'a'), at('Augustine', 5, 'b'), at('Loathe', 2)]);

    expect(out.map((a) => a.name)).toEqual(['Gojira', 'Augustine', 'Loathe']);
    expect(out[1].id).toBe('b');
  });

  it('treats a missing event count as none', () => {
    const out = collapseDuplicates([{ id: 'x', name: 'Augustine' }, at('Augustine', 1, 'y')]);

    expect(out.map((a) => a.id)).toEqual(['y']);
  });

  it('is empty for nothing at all', () => {
    expect(collapseDuplicates([])).toEqual([]);
    expect(collapseDuplicates(null)).toEqual([]);
  });
});
