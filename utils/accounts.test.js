import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcrypt';
import {
  passwordProblems, generatePassword, parseCreateUserArgs, createAccount, ACCOUNT_ROLES,
} from './accounts.js';

// A stand-in for the two Prisma calls createAccount makes, handed in directly:
// the function takes its client as an argument, so nothing global is replaced.
function accountsFakePrisma({ existing = null, createError = null } = {}) {
  return {
    user: {
      findFirst: vi.fn(async () => existing),
      create: vi.fn(async ({ data }) => {
        if (createError) throw createError;
        return { id: data.id, email: data.email, role: data.role };
      }),
    },
  };
}

describe('passwordProblems', () => {
  it('passes a password the sign-in form would accept', () => {
    expect(passwordProblems('Password1')).toEqual([]);
  });

  it('names each rule a password breaks, in the words the API uses', () => {
    expect(passwordProblems('short')).toEqual([
      'Password must be at least 8 characters, at most 100 characters',
      'Password must contain at least one uppercase letter',
    ]);
    expect(passwordProblems('ALLUPPERCASE')).toEqual(['Password must contain at least one lowercase letter']);
  });

  it('counts length in characters, as the sign-in check does', () => {
    // Sixty guitars and two letters: 62 characters, but 122 UTF-16 units. A
    // cap on .length would refuse a password the sign-in check accepts.
    expect(passwordProblems(`${'🎸'.repeat(60)}Aa`)).toEqual([]);
    expect(passwordProblems(`${'x'.repeat(100)}A`)).toHaveLength(1);
  });

  it('refuses something that is not a string at all', () => {
    expect(passwordProblems(undefined)).toEqual(['Password is required']);
  });
});

describe('generatePassword', () => {
  it('always passes the rules, whatever the random bytes are', () => {
    // All zero bytes encode to "AAAA…": no lowercase letter from the random
    // part, which is why the two letters are put in front.
    expect(passwordProblems(generatePassword(() => Buffer.alloc(18, 0)))).toEqual([]);
    expect(passwordProblems(generatePassword(() => Buffer.alloc(18, 0xff)))).toEqual([]);
    expect(passwordProblems(generatePassword())).toEqual([]);
  });

  it('does not hand out the same one twice', () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe('parseCreateUserArgs', () => {
  it('takes an address alone, as a USER whose password is to be generated', () => {
    expect(parseCreateUserArgs(['--email', 'someone@example.test']))
      .toEqual({ ok: true, email: 'someone@example.test', password: null, role: 'USER' });
  });

  it('stores the address the way sign-in will look for it', () => {
    expect(parseCreateUserArgs(['--email', ' Someone@Example.TEST ']).email).toBe('someone@example.test');
  });

  it('accepts a role in any case, and only the roles a person can have', () => {
    expect(parseCreateUserArgs(['--email', 'a@b.test', '--role', 'admin']).role).toBe('ADMIN');
    // SYSTEM is the sync service's machine user. It signs in with a minted
    // token, and a SYSTEM account with a password would be a second way in.
    expect(ACCOUNT_ROLES).not.toContain('SYSTEM');
    expect(parseCreateUserArgs(['--email', 'a@b.test', '--role', 'SYSTEM']))
      .toEqual({ ok: false, error: '--role must be one of USER, ADMIN' });
  });

  it('refuses a password the sign-in form would reject, rather than making an account that cannot sign in', () => {
    const parsed = parseCreateUserArgs(['--email', 'a@b.test', '--password', 'short']);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('at least 8 characters');
  });

  it('keeps a given password exactly as typed', () => {
    expect(parseCreateUserArgs(['--email', 'a@b.test', '--password', ' Padded Pass1 ']).password).toBe(' Padded Pass1 ');
  });

  it.each([
    [[], '--email must be a valid address'],
    [['--email', 'not-an-address'], '--email must be a valid address'],
    [['--email'], '--email needs a value'],
    [['--email', '--role', 'ADMIN'], '--email needs a value'],
    [['someone@example.test'], 'Unknown argument: someone@example.test'],
    [['--email', 'a@b.test', '--admin', 'yes'], 'Unknown argument: --admin'],
  ])('refuses %j', (argv, error) => {
    expect(parseCreateUserArgs(argv)).toEqual({ ok: false, error });
  });
});

describe('createAccount', () => {
  const newAccount = { email: 'new@example.test', password: 'Password1' };

  it('creates the account and its wishlist in one write', async () => {
    const prisma = accountsFakePrisma();

    const result = await createAccount(prisma, newAccount);

    expect(result.status).toBe('created');
    expect(result.user).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), email: 'new@example.test', role: 'USER' });
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.create.mock.calls[0][0].data.wishlists).toEqual({ create: { name: 'My Wishlist' } });
  });

  it('stores a hash the sign-in can check, never the password', async () => {
    const prisma = accountsFakePrisma();

    await createAccount(prisma, newAccount);

    const { password_hash: hash } = prisma.user.create.mock.calls[0][0].data;
    expect(hash).not.toContain(newAccount.password);
    expect(await bcrypt.compare(newAccount.password, hash)).toBe(true);
  });

  it('gives the role it was asked for', async () => {
    const prisma = accountsFakePrisma();

    const result = await createAccount(prisma, { ...newAccount, role: 'ADMIN' });

    expect(result.user.role).toBe('ADMIN');
  });

  it('makes nothing when the address is taken in any capitalisation', async () => {
    const prisma = accountsFakePrisma({ existing: { id: 'u1' } });

    const result = await createAccount(prisma, newAccount);

    expect(result).toEqual({ status: 'exists' });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: 'new@example.test', mode: 'insensitive' } },
    }));
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('reports "exists" when the address was taken between the check and the write', async () => {
    const prisma = accountsFakePrisma({ createError: Object.assign(new Error('unique'), { code: 'P2002' }) });

    expect(await createAccount(prisma, newAccount)).toEqual({ status: 'exists' });
  });

  it('lets any other database error through', async () => {
    const prisma = accountsFakePrisma({ createError: new Error('connection lost') });

    await expect(createAccount(prisma, newAccount)).rejects.toThrow('connection lost');
  });
});
