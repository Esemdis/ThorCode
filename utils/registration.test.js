import { describe, it, expect } from 'vitest';
import { registrationOpen } from './registration.js';

describe('registrationOpen', () => {
  it('is closed when the variable is not set at all', () => {
    expect(registrationOpen({})).toBe(false);
  });

  it('opens only for the exact string "true"', () => {
    expect(registrationOpen({ REGISTRATION_OPEN: 'true' })).toBe(true);
  });

  // Each of these is something a person might type meaning "on". Reading any
  // of them as open would make a typo the way sign-up is left open.
  it.each(['1', 'yes', 'TRUE', 'True', ' true', 'on', '', 'false'])(
    'stays closed for %j',
    (value) => {
      expect(registrationOpen({ REGISTRATION_OPEN: value })).toBe(false);
    },
  );
});
