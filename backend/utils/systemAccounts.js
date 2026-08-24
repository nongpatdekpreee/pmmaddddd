/**
 * Central / system login accounts listed in SYSTEM_USERNAMES (comma-separated).
 * These stay in DB for login but are hidden from Employee directory lists.
 */

function getSystemUsernames() {
  const raw = String(process.env.SYSTEM_USERNAMES || '');
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * SQL fragment: hide profiles whose linked login Username is in SYSTEM_USERNAMES.
 * @param {string} usernameExpr e.g. 'u.Username'
 */
function systemUsernameExcludeSql(usernameExpr = 'u.Username') {
  const names = getSystemUsernames();
  if (names.length === 0) {
    return { sql: '', params: [] };
  }
  const placeholders = names.map(() => '?').join(', ');
  return {
    sql: ` AND (${usernameExpr} IS NULL OR LOWER(TRIM(${usernameExpr})) NOT IN (${placeholders}))`,
    params: names,
  };
}

function isSystemUsername(username) {
  const n = String(username || '')
    .trim()
    .toLowerCase();
  if (!n) return false;
  return getSystemUsernames().includes(n);
}

module.exports = {
  getSystemUsernames,
  systemUsernameExcludeSql,
  isSystemUsername,
};
