/**
 * Time-based one-time codes (RFC 6238), as used by Google Authenticator,
 * Microsoft Authenticator, 1Password and similar apps.
 */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/[\s=]/g, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const num = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(num).padStart(6, '0');
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Checks a 6-digit code, allowing one step of clock drift either way.
 * Returns the matching time step (store it to block reuse), or null.
 * Codes at or before `lastUsedStep` are rejected so a code works only once.
 */
function verify(secret, code, lastUsedStep = null, now = Date.now()) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean) || !secret) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (lastUsedStep != null && s <= lastUsedStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return s;
  }
  return null;
}

function keyUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, verify, keyUri, codeAt, currentStep };
