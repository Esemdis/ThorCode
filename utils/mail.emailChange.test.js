import { describe, it, expect } from 'vitest';
import { buildEmailChangedNoticeHtml, maskAddressForNotice } from './mail.js';

describe('the notice to the old address after an email change (THO-835)', () => {
  it('says the address changed and where to, without spelling out the new one', () => {
    const html = buildEmailChangedNoticeHtml({ newEmail: 'newperson@example.test' });

    expect(html).toContain('The email address on your Concert Map account was changed');
    expect(html).toContain('n•••@example.test');
    expect(html).not.toContain('newperson');
  });

  it('tells the reader what it means if they did not make the change', () => {
    const html = buildEmailChangedNoticeHtml({ newEmail: 'a@example.test' });

    expect(html).toContain('If you did not');
    // The old address can no longer reset the password, which is the whole
    // reason the reader must act on this mail rather than on a later one.
    expect(html).toContain('can no longer be used to sign in or to reset the password');
  });

  it('escapes whatever the new address carries', () => {
    const html = buildEmailChangedNoticeHtml({ newEmail: 'x@<b>evil</b>.test' });

    expect(html).not.toContain('<b>evil</b>');
  });
});

describe('masking the new address in that notice', () => {
  it('keeps the first character and the whole domain', () => {
    expect(maskAddressForNotice('someone@example.test')).toBe('s•••@example.test');
  });

  it('masks a one-letter local part the same way, so its length is not told', () => {
    expect(maskAddressForNotice('s@example.test')).toBe('s•••@example.test');
  });

  it('masks all of something that is not an address', () => {
    expect(maskAddressForNotice('nonsense')).toBe('•••');
    expect(maskAddressForNotice('')).toBe('•••');
  });
});
