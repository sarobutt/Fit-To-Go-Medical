/** Simple in-memory brake on guessing: `max` failures per key per 15 minutes. */
const WINDOW_MS = 15 * 60_000;
const failures = new Map();

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

module.exports = { tooManyAttempts, recordFailure, clearFailures };
