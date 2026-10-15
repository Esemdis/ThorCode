import { describe, it, expect } from 'vitest';
import { normaliseTripInput } from './tripInput.js';

describe('normaliseTripInput on create', () => {
  it('fills the defaults a new trip needs', () => {
    expect(normaliseTripInput({ name: '  Lisbon  ' })).toEqual({
      data: { name: 'Lisbon', tags: [] },
    });
  });

  it('reads a full body', () => {
    const { data } = normaliseTripInput({
      name: 'Lisbon', destination: ' Lisbon ', start_date: '2026-10-01', end_date: '2026-10-05',
      weight_budget: '7000', tags: [' city ', ''],
    });
    expect(data).toMatchObject({
      destination: 'Lisbon',
      start_date: new Date('2026-10-01'),
      weight_budget: 7000,
      tags: ['city'],
    });
  });
});

describe('normaliseTripInput refuses what used to become a 500', () => {
  it.each([
    [{ name: '' }, /name/],
    [{ name: 'x'.repeat(201) }, /name/],
    [{ name: 'x', start_date: 'not a date' }, /start_date/],
    [{ name: 'x', start_date: '2026-10-05', end_date: '2026-10-01' }, /ends before/],
    [{ name: 'x', tags: 'city' }, /tags/],
    [{ name: 'x', tags: [1] }, /tags/],
    [{ name: 'x', weight_budget: '7.5kg' }, /weight_budget/],
    [{ name: 'x', destination: ['Lisbon'] }, /destination/],
  ])('%j', (body, message) => {
    expect(normaliseTripInput(body).error).toMatch(message);
  });
});

describe('normaliseTripInput on update', () => {
  it('leaves out what was not sent', () => {
    expect(normaliseTripInput({ notes: 'bring an adapter' }, { partial: true })).toEqual({
      data: { notes: 'bring an adapter' },
    });
  });

  it('clears a field sent as empty', () => {
    expect(normaliseTripInput({ weight_budget: '', destination: null }, { partial: true }).data)
      .toEqual({ weight_budget: null, destination: null });
  });
});
