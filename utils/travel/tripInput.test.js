import { describe, it, expect } from 'vitest';
import { normaliseTripInput } from './tripInput.js';

describe('normaliseTripInput on create', () => {
  it('fills the defaults a new trip needs', () => {
    expect(normaliseTripInput({ name: '  Lisbon  ' })).toEqual({
      data: { name: 'Lisbon', currency: 'SEK', tags: [] },
    });
  });

  it('reads a full body', () => {
    const { data } = normaliseTripInput({
      name: 'Lisbon', destination: ' Lisbon ', start_date: '2026-10-01', end_date: '2026-10-05',
      weight_budget: '7000', money_budget: 12000.5, currency: 'eur', tags: [' city ', ''],
    });
    expect(data).toMatchObject({
      destination: 'Lisbon',
      start_date: new Date('2026-10-01'),
      weight_budget: 7000,
      money_budget: 12000.5,
      currency: 'EUR',
      tags: ['city'],
    });
  });

  it('never accepts place ids for a trip that has no places yet', () => {
    expect(normaliseTripInput({ name: 'x', arrival_place_id: 3 }).data).not.toHaveProperty('arrival_place_id');
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
    [{ name: 'x', currency: 12 }, /currency/],
    [{ name: 'x', currency: 'euro' }, /currency/],
    [{ name: 'x', weight_budget: '7.5kg' }, /weight_budget/],
    [{ name: 'x', money_budget: -1 }, /money_budget/],
    [{ name: 'x', budget_food: 1e12 }, /budget_food/],
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
    expect(normaliseTripInput({ money_budget: '', destination: null }, { partial: true }).data)
      .toEqual({ money_budget: null, destination: null });
  });

  it('keeps arrival and departure in range', () => {
    expect(normaliseTripInput({ arrival_time: 1440 }, { partial: true }).error).toMatch(/arrival_time/);
    expect(normaliseTripInput({ transfer_minutes: 721 }, { partial: true }).error).toMatch(/transfer_minutes/);
    expect(normaliseTripInput({ arrival_time: 840, transfer_minutes: '' }, { partial: true }).data)
      .toEqual({ arrival_time: 840, transfer_minutes: null });
  });

  it('takes place ids only when asked to, and only as ids', () => {
    expect(normaliseTripInput({ arrival_place_id: '12' }, { partial: true, withPlaces: true }).data)
      .toEqual({ arrival_place_id: 12 });
    expect(normaliseTripInput({ arrival_place_id: 'abc' }, { partial: true, withPlaces: true }).error)
      .toMatch(/arrival_place_id/);
    expect(normaliseTripInput({ departure_place_id: null }, { partial: true, withPlaces: true }).data)
      .toEqual({ departure_place_id: null });
  });

  it('refuses a currency cleared to nothing', () => {
    expect(normaliseTripInput({ currency: '' }, { partial: true }).error).toMatch(/currency/);
  });
});
