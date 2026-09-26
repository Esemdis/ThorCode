import { describe, it, expect } from 'vitest';
import { normaliseLoadoutInput } from './loadoutInput.js';

describe('normaliseLoadoutInput', () => {
  it('trims the name and fills in the rest on a create', () => {
    expect(normaliseLoadoutInput({ name: ' Weekend ' }).data)
      .toEqual({ name: 'Weekend', description: null, weight_budget: null });
  });

  it('touches only what an edit sent', () => {
    expect(normaliseLoadoutInput({ weight_budget: '7000' }, { partial: true }))
      .toEqual({ data: { weight_budget: 7000 } });
  });

  it.each([
    ['no name on a create', {}, false, /name/],
    ['a name that is not text', { name: 42 }, true, /name/],
    ['a budget that is not a number', { weight_budget: 'heavy' }, true, /weight_budget/],
    ['a budget in part-grams', { weight_budget: 1500.5 }, true, /weight_budget/],
  ])('refuses %s', (_label, body, partial, message) => {
    expect(normaliseLoadoutInput(body, { partial }).error).toMatch(message);
  });
});
