const config = require('./config');

/** Current wall-clock time in the clinic's time zone as 'YYYY-MM-DD HH:MM'. */
function nowLocal(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function todayLocal() {
  return nowLocal().slice(0, 10);
}

/** Adds days to a 'YYYY-MM-DD' string. */
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Hours between two clinic-local 'YYYY-MM-DD HH:MM' strings. */
function hoursBetween(a, b) {
  const ms = new Date(`${b.replace(' ', 'T')}:00Z`) - new Date(`${a.replace(' ', 'T')}:00Z`);
  return ms / 3_600_000;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function formatDateTime(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toLocaleString('en-GB', {
      timeZone: config.timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  const s = String(value);
  return `${formatDate(s)}, ${s.slice(11, 16)}`;
}

module.exports = {
  nowLocal, todayLocal, addDays, toMinutes, fromMinutes, hoursBetween, isDate, isTime, formatDate, formatDateTime,
};
