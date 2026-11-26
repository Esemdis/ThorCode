/**
 * The decisions behind scripts/service-tokens.js (THO-1016), kept out of the
 * script so they can be tested without a database.
 */

const { isServiceTokenId } = require('../auth/serviceTokens');

const SERVICE_TOKENS_USAGE = [
  'Usage:',
  '  node scripts/service-tokens.js list [--all]',
  '  node scripts/service-tokens.js withdraw <jti>',
].join('\n');

/**
 * `list [--all]` or `withdraw <jti>`, as `{ command, all }` / `{ command, jti }`,
 * or `{ error }`. A jti that cannot be a row's id is refused here, so it never
 * reaches a query.
 *
 * @param {string[]} argv - process.argv.slice(2)
 */
function parseServiceTokensArgs(argv) {
  const [command, ...rest] = argv;
  if (command === 'list') {
    if (rest.length === 0) return { command, all: false };
    if (rest.length === 1 && rest[0] === '--all') return { command, all: true };
    return { error: `list takes only --all, not ${rest.join(' ')}` };
  }
  if (command === 'withdraw') {
    if (rest.length !== 1) return { error: 'withdraw takes exactly one jti' };
    const jti = rest[0].trim().toLowerCase();
    if (!isServiceTokenId(jti)) return { error: `Not a token id: ${rest[0]}` };
    return { command, jti };
  }
  return { error: command ? `Unknown command ${command}` : 'No command given' };
}

/**
 * 'withdrawn', 'expired' or 'active'. Withdrawn wins over expired: it is the
 * one someone did on purpose, and the one worth seeing in the list.
 *
 * @param {{ withdrawn_at: Date|null, expires_at: Date }} row
 * @param {Date} now
 */
function serviceTokenStatus(row, now) {
  if (row.withdrawn_at) return 'withdrawn';
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

const dayOf = (date) => date.toISOString().slice(0, 10);

/**
 * The table `list` prints, one line per token after a header. The role is the
 * account's role now, which is what a full-session token's role was minted
 * from; a wander token is always USER with the wander scope. `withStatus`
 * adds a status column, for `--all`.
 *
 * @param {Array<{ id: string, scope: string|null, created_at: Date, expires_at: Date,
 *   withdrawn_at: Date|null, user_rel: { email: string, role: string } }>} rows
 * @param {Date} now
 * @param {{ withStatus?: boolean }} [options]
 * @returns {string[]}
 */
function formatServiceTokenRows(rows, now, { withStatus = false } = {}) {
  if (rows.length === 0) return [withStatus ? 'No service tokens.' : 'No active service tokens.'];
  const table = rows.map((row) => {
    const cells = [
      row.id,
      row.user_rel?.email ?? '?',
      row.scope ? `USER/${row.scope}` : (row.user_rel?.role ?? '?'),
      dayOf(row.created_at),
      dayOf(row.expires_at),
    ];
    if (withStatus) cells.push(serviceTokenStatus(row, now));
    return cells;
  });
  const header = ['JTI', 'EMAIL', 'ROLE/SCOPE', 'CREATED', 'EXPIRES'];
  if (withStatus) header.push('STATUS');
  const all = [header, ...table];
  const widths = header.map((_, i) => Math.max(...all.map((cells) => cells[i].length)));
  return all.map((cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
}

module.exports = {
  SERVICE_TOKENS_USAGE,
  parseServiceTokensArgs,
  serviceTokenStatus,
  formatServiceTokenRows,
};
