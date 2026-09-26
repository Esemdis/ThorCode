import { describe, it, expect } from 'vitest';
import { normaliseEstimateInput } from './estimateInput.js';

describe('normaliseEstimateInput', () => {
  it('stores what travel-bag sends for a hotel', () => {
    const { data } = normaliseEstimateInput({
      category: 'Hotel', amount: 1890.5, currency: 'eur', note: null,
      date: '2026-10-01', end_date: '2026-10-04',
    });
    expect(data).toEqual({
      category: 'Hotel', amount: 1890.5, currency: 'EUR', note: null,
      date: new Date('2026-10-01'), end_date: new Date('2026-10-04'), sort_order: 0,
    });
  });

  it('defaults the currency and leaves the dates empty on a bare create', () => {
    expect(normaliseEstimateInput({ category: 'Food', amount: '120' }).data).toEqual({
      category: 'Food', amount: 120, currency: 'SEK', date: null, end_date: null, note: null, sort_order: 0,
    });
  });

  it('still takes a negative amount, which the create route always did', () => {
    expect(normaliseEstimateInput({ category: 'Refund', amount: -200 }).data.amount).toBe(-200);
  });

  it('touches only what an edit sent', () => {
    // bookedAction's update: the amount and its currency, nothing else.
    expect(normaliseEstimateInput({ amount: 2400, currency: 'SEK' }, { partial: true }))
      .toEqual({ data: { amount: 2400, currency: 'SEK' } });
  });

  it.each([
    ['no category', { amount: 5 }, /category/],
    ['no amount', { category: 'Food' }, /amount/],
    ['an amount that is not a number', { category: 'Food', amount: 'lots' }, /amount/],
    ['a date that does not parse', { category: 'Food', amount: 5, date: 'soonish' }, /date/],
    ['a currency longer than three letters', { category: 'Food', amount: 5, currency: 'EURO' }, /currency/],
    ['a category that is not text', { category: 7, amount: 5 }, /category/],
  ])('refuses %s', (_label, body, message) => {
    expect(normaliseEstimateInput(body).error).toMatch(message);
  });

  it('refuses the same things on an edit, which checked nothing at all', () => {
    expect(normaliseEstimateInput({ amount: 'lots' }, { partial: true }).error).toMatch(/amount/);
    expect(normaliseEstimateInput({ end_date: 'later' }, { partial: true }).error).toMatch(/end_date/);
    expect(normaliseEstimateInput({ category: '' }, { partial: true }).error).toMatch(/category/);
  });
});
