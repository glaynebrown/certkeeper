/* Date + renewal-rule helpers, shared by the website and the daily reminder
   function (firebase.json copies this file into functions/ on deploy).

   Every cert date is stored as a plain 'YYYY-MM-DD' string -- no time, no
   timezone -- so "expires Oct 31" means Oct 31 for everyone. A Date object
   would quietly shift it a day for anyone west of UTC. Plain strings in this
   format also sort and compare correctly with < and >. */
const Dates = (() => {
  const pad = n => String(n).padStart(2, '0');
  const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  function parse(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }
  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function isValid(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    const { y, m, d } = parse(s);
    return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }
  function today() {
    const n = new Date();
    return fmt(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }
  const toUTC = s => { const { y, m, d } = parse(s); return Date.UTC(y, m - 1, d); };

  function daysBetween(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }
  function addDays(s, n) {
    const t = new Date(toUTC(s) + n * 86400000);
    return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  // Clamps to the last day of the target month (Jan 31 + 1 month = Feb 28).
  function addMonths(s, n) {
    const { y, m, d } = parse(s);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12), nm = total - ny * 12 + 1;
    return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
  }
  function endOfMonth(s) {
    const { y, m } = parse(s);
    return fmt(y, m, daysInMonth(y, m));
  }
  const isEndOfMonth = s => s === endOfMonth(s);

  function pretty(s) {
    if (!isValid(s)) return '';
    const { y, m, d } = parse(s);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US',
      { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  // How long something has been held: "4 yrs 3 mos", "8 mos", "1 yr".
  function tenure(from, to = today()) {
    if (!isValid(from) || from > to) return '';
    const a = parse(from), b = parse(to);
    const months = (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0);
    const y = Math.floor(months / 12), m = months % 12;
    if (!y && !m) return 'less than a month';
    return [y && `${y} yr${y === 1 ? '' : 's'}`, m && `${m} mo${m === 1 ? '' : 's'}`].filter(Boolean).join(' ');
  }
  function monthYear(s) {
    if (!isValid(s)) return '';
    const { y, m } = parse(s);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // ---- reminder offsets: '6m', '1w', '10d' = that long before expiration ----
  const PRESET_OFFSETS = ['6m', '3m', '2m', '1m', '1w'];
  const UNIT_NAMES = { d: 'day', w: 'week', m: 'month' };

  function parseOffset(o) {
    const match = /^(\d+)([dwm])$/.exec(o || '');
    return match ? { n: Number(match[1]), unit: match[2] } : null;
  }
  function offsetLabel(o) {
    const p = parseOffset(o);
    return p ? `${p.n} ${UNIT_NAMES[p.unit]}${p.n === 1 ? '' : 's'} before` : o;
  }
  function reminderDate(exp, o) {
    const p = parseOffset(o);
    if (!p) return null;
    if (p.unit === 'm') return addMonths(exp, -p.n);
    return addDays(exp, -(p.unit === 'w' ? 7 * p.n : p.n));
  }
  // Longest lead time first, so lists read 6 months, 3 months, ..., 1 week.
  function sortOffsets(list) {
    const approxDays = o => { const p = parseOffset(o); return p.n * { d: 1, w: 7, m: 30.44 }[p.unit]; };
    return [...new Set(list)].filter(parseOffset).sort((a, b) => approxDays(b) - approxDays(a));
  }

  // ---- renewal rules: how "I renewed" suggests the next expiration ----
  const RULES = {
    fixed: 'Fixed cycle: old expiration + the time it’s good for',
    classDate: 'Counted from the day I renew / take the class',
    classDateEOM: 'Counted from the class date, expires end of that month',
    manual: 'I’ll type the new date myself',
  };

  function suggestExpiration(rule, oldExp, renewedOn, months) {
    if (!months) return '';
    if (rule === 'fixed') {
      if (!isValid(oldExp)) return '';
      const next = addMonths(oldExp, months);
      // Keeps end-of-month cycles on the last day (RN: Feb 28 -> Feb 29 in a leap year).
      return isEndOfMonth(oldExp) ? endOfMonth(next) : next;
    }
    if (!isValid(renewedOn)) return '';
    if (rule === 'classDate') return addMonths(renewedOn, months);
    if (rule === 'classDateEOM') return endOfMonth(addMonths(renewedOn, months));
    return '';
  }

  // ---- status for the colored cards ----
  // ok = fine, due = inside its earliest reminder window, expired = past date.
  function status(cert, t = today()) {
    if (!isValid(cert.expiresOn)) return { key: 'none', days: null };
    const days = daysBetween(t, cert.expiresOn);
    if (days < 0) return { key: 'expired', days };
    const due = (cert.reminders || []).some(o => { const r = reminderDate(cert.expiresOn, o); return r && r <= t; });
    return { key: due ? 'due' : 'ok', days };
  }

  // Reminder keys whose date has arrived but haven't been emailed yet. 'exp'
  // is the built-in "expires today" notice; 'again' is a snoozed reminder
  // ("remind me again in 1 week"). Once the cert has expired nothing more is
  // sent -- the in-app banner takes over from there.
  function dueReminders(cert, t) {
    if (!isValid(cert.expiresOn) || t > cert.expiresOn) return [];
    const sent = cert.remindersSent || [];
    const due = [...(cert.reminders || []), 'exp'].filter(key => {
      if (sent.includes(key)) return false;
      const date = key === 'exp' ? cert.expiresOn : reminderDate(cert.expiresOn, key);
      return date && date <= t;
    });
    if (isValid(cert.remindAgainOn) && cert.remindAgainOn <= t) due.push('again');
    return due;
  }

  return {
    isValid, today, daysBetween, addDays, addMonths, endOfMonth, pretty, tenure, monthYear,
    PRESET_OFFSETS, parseOffset, offsetLabel, reminderDate, sortOffsets,
    RULES, suggestExpiration, status, dueReminders,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Dates;
