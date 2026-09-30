-- Addresses are stored and compared lowercased from here on (see
-- utils/validation/email.js). Data only: the schema does not change.
--
-- An account is folded only when no other account has the same address in
-- another case. Folding both of such a pair would fail on the unique key, and
-- a failed migration stops the container from starting. Sign-in still finds a
-- pair like that by the exact address; see findUserByEmail in routes/users.js.
UPDATE "User" AS u
SET email = lower(u.email)
WHERE u.email <> lower(u.email)
  AND NOT EXISTS (
    SELECT 1 FROM "User" AS o
    WHERE o.id <> u.id AND lower(o.email) = lower(u.email)
  );

-- Pending changes are compared to the address as it is now stored.
UPDATE "EmailVerification"
SET new_email = lower(new_email)
WHERE new_email <> lower(new_email);
