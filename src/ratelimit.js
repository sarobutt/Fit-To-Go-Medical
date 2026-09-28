/**
 * Simple in-memory brake on guessing. Failures are counted per key for 15 minutes.
 * Sign-in checks two keys: the account (email + IP) and the connection (IP alone),
 * so one address can't try a common password against many accounts.
 */
const WINDOW_MS = 15 * 60_000;
const failures = new Map();

const LIMITS = { account: 10, connection: 30, staffAccount: 5, registrations: 10 };

function tooManyAttempts(key, max = 10) {
  const entry = failures.get(key);
  if (!entry || entry.until < Date.now()) return false;
  return entry.count >= max;
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || entry.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + WINDOW_MS });
  else entry.count++;
}

function clearFailures(key) {
  failures.delete(key);
}

/** Keys and limits for a sign-in attempt. */
function signInKeys(kind, email, ip) {
  return [
    [`${kind}|${email}|${ip}`, kind === 'staff' ? LIMITS.staffAccount : LIMITS.account],
    [`ip|${ip}`, LIMITS.connection],
  ];
}

const blocked = (keys) => keys.some(([key, max]) => tooManyAttempts(key, max));
const recordAll = (keys) => keys.forEach(([key]) => recordFailure(key));

// Keep memory bounded: drop expired entries every few minutes.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) if (entry.until < now) failures.delete(key);
}, 5 * 60_000).unref();

/** Tests start each case with a clean slate. */
function resetAll() {
  failures.clear();
}

module.exports = { tooManyAttempts, recordFailure, clearFailures, signInKeys, blocked, recordAll, resetAll, LIMITS };
