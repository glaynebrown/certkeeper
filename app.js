/* CertKeeper UI: hash routes, screens and pop-ups. Data goes through Store
   (store.js), dates and renewal rules through Dates (dates.js).

   Routes:  #/  dashboard      #/new  add cert       #/cert/ID  detail
            #/cert/ID/edit     #/settings            #/login  #/signup  #/reset
   Invite links look like  https://.../certkeeper/?invite=CODE  */

const view = document.getElementById('view');
const state = { user: null, profile: null, certs: [], certsLoaded: false, unwatch: null, signingUp: false };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = c => c.abbr || c.name;
const certById = id => state.certs.find(c => c.id === id);

// After a save, update our copy right away so the screen we draw next is
// current even if Firestore's live update hasn't arrived yet. (The live
// update then overwrites it with the same data.)
function applyLocal(id, patch) {
  const c = certById(id);
  if (c) Object.assign(c, patch);
}
// A brand-new cert has no local copy to patch; wait (briefly) for it to arrive.
function waitForCert(id) {
  const start = Date.now();
  return new Promise(resolve => (function poll() {
    if (certById(id) || Date.now() - start > 4000) return resolve();
    setTimeout(poll, 50);
  })());
}

// Only http(s) links ever become clickable.
function safeUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 3500);
}

const ERRORS = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'That email address doesn’t look right.',
  'auth/email-already-in-use': 'There’s already an account with that email. Try signing in.',
  'auth/weak-password': 'Password needs at least 8 characters.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
  'auth/requires-recent-login': 'For safety, sign out and back in, then try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'permission-denied': 'You don’t have permission to do that.',
  // Type and size are checked before uploading, so a refusal here means a permissions problem.
  'storage/unauthorized': 'The server refused this file. Wait a minute and try again. If it keeps happening, sign out and back in.',
};
const friendlyError = e => ERRORS[e && e.code] || (e && e.message) || 'Something went wrong.';

// Disables a button while its action runs and shows any error as a toast.
async function busy(btn, fn) {
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try { return await fn(); } catch (e) { console.error(e); toast(friendlyError(e), true); } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}

function fmtSize(b) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
// ['a', 'b', 'c'] -> "a, b and c" (falsy items skipped).
function listText(items) {
  const xs = items.filter(Boolean);
  return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join('');
}
const fmtNum = n => (Math.round(n * 100) / 100).toString();

const STATUS_TEXT = { ok: 'Current', due: 'Renew soon', expired: 'Expired', none: 'No date' };

function daysText(days) {
  if (days == null) return '';
  if (days === 0) return 'expires today';
  const a = Math.abs(days);
  const span = a >= 60 ? `${Math.round(a / 30.44)} months` : `${a} day${a === 1 ? '' : 's'}`;
  return days > 0 ? `${span} remaining` : `expired ${span} ago`;
}

function validityText(months) {
  if (!months) return '—';
  return months % 12 === 0 ? `${months / 12} year${months === 12 ? '' : 's'}` : `${months} months`;
}

const isSnoozed = (c, t) => c.snoozedUntil && c.snoozedUntil > t;
function needsAttention(c, t) {
  const k = Dates.status(c, t).key;
  return (k === 'due' || k === 'expired') && !isSnoozed(c, t);
}
// "RN for 4 yrs 3 mos · since Jun 2022" -- only when a first-certified date is set.
function tenureText(c) {
  const held = Dates.tenure(c.firstIssuedOn);
  return held ? `${label(c)} for ${held} · since ${Dates.monthYear(c.firstIssuedOn)}` : '';
}

const sortedCerts = () => [...state.certs].sort((a, b) => (a.expiresOn || '9999').localeCompare(b.expiresOn || '9999'));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ($(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Couldn’t load the ZIP tool. Check your connection.'));
    document.head.appendChild(s);
  });
}

function openFile(path) {
  // Open the tab right away (inside the click) so pop-up blockers allow it.
  const w = window.open('', '_blank');
  Store.fileUrl(path).then(url => {
    if (w) w.location = url; else location.href = url;
  }).catch(e => { if (w) w.close(); toast(friendlyError(e), true); });
}

// ---------- appearance ----------
// 'system' follows the phone/computer setting; 'light'/'dark' override it.
// Saved per device (like the calendar's device settings). index.html applies
// it before the page draws; this handles changes from Settings.
function getTheme() {
  try { return localStorage.getItem('ck-theme') || 'system'; } catch { return 'system'; }
}
function setTheme(theme) {
  try {
    if (theme === 'system') localStorage.removeItem('ck-theme'); else localStorage.setItem('ck-theme', theme);
  } catch { /* storage blocked: still applies for this visit */ }
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// ---------- card ----------
const CARD_SIDES = ['front', 'back'];
const CARD_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="11" r="2" fill="currentColor"/><path d="M5 16c.6-1.6 1.7-2.3 3-2.3s2.4.7 3 2.3M14 10h4.5M14 13.5h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const hasCard = c => !!(c.card && (c.card.front || c.card.back));
const isPdf = f => f.contentType === 'application/pdf';

// Pops up the current card, with the number and expiration underneath.
function openCardModal(c) {
  if (!c) return;
  const sides = CARD_SIDES.filter(s => c.card && c.card[s]);
  const t = Dates.today();
  openModal(`
    <h2>${esc(label(c))} card</h2>
    <div class="card-view">${sides.map(s => `
      <figure>
        ${isPdf(c.card[s])
          ? `<button class="btn block" data-open="${esc(c.card[s].path)}">Open ${s} (PDF) ↗</button>`
          : `<img data-img="${esc(c.card[s].path)}" alt="${esc(label(c))} card, ${s}">`}
        ${sides.length > 1 ? `<figcaption>${s === 'front' ? 'Front' : 'Back'}</figcaption>` : ''}
      </figure>`).join('')}
    </div>
    <dl class="card-facts">
      ${c.certNumber ? `<div><dt>Number</dt><dd>${esc(c.certNumber)}</dd></div>` : ''}
      ${c.expiresOn ? `<div><dt>Expires</dt><dd>${Dates.pretty(c.expiresOn)} <span class="muted">· ${daysText(Dates.status(c, t).days)}</span></dd></div>` : ''}
    </dl>
    <div class="modal-actions">
      <a class="btn ghost" href="#/cert/${c.id}" data-close>Cert page</a>
      <button class="btn primary" data-close>Done</button>
    </div>`, m => {
    $$('[data-open]', m).forEach(b => { b.onclick = () => openFile(b.dataset.open); });
    $$('[data-img]', m).forEach(img => {
      img.title = 'Tap to open full size';
      img.onclick = () => openFile(img.dataset.img);
      Store.fileUrl(img.dataset.img).then(url => { img.src = url; })
        .catch(e => { img.replaceWith(Object.assign(document.createElement('p'), { className: 'error-text', textContent: friendlyError(e) })); });
    });
  });
}

// ---------- date picker ----------
// The browser's own calendar can't be styled, so date fields become a
// rounded button that opens this one. The original <input> stays in the form
// (as a hidden input with the same name), so code reads and sets it as before.
const monthNames = style => [...Array(12)].map((_, i) =>
  new Date(Date.UTC(2000, i, 1)).toLocaleDateString('en-US', { month: style, timeZone: 'UTC' }));
const CAL_ICON = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

function enhanceDateInputs(root) {
  const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  $$('input[type="date"]', root).forEach(input => {
    const { min, max, required } = input;
    input.type = 'hidden';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'date-field';
    const aria = input.getAttribute('aria-label');
    if (aria) btn.setAttribute('aria-label', aria);
    input.after(btn);

    const draw = () => {
      const v = valueProp.get.call(input);
      btn.innerHTML = `<span class="${v ? '' : 'placeholder'}">${v ? Dates.pretty(v) : 'Select date'}</span>${CAL_ICON}`;
    };
    // Setting .value from code (fill-ins, suggestions) redraws the button too.
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => valueProp.get.call(input),
      set: v => { valueProp.set.call(input, v); draw(); },
    });
    input.focus = () => btn.focus();
    draw();

    btn.onclick = () => openDatePicker(input.value, { min, max, clearable: !required }, v => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      btn.focus();
    });
  });
}

function openDatePicker(value, { min, max, clearable }, onPick) {
  const t = Dates.today();
  const start = Dates.isValid(value) ? value : (max && t > max ? max : min && t < min ? min : t);
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  const firstYear = min ? Number(min.slice(0, 4)) : 1960;
  const lastYear = max ? Number(max.slice(0, 4)) : Number(t.slice(0, 4)) + 15;
  const allowed = d => (!min || d >= min) && (!max || d <= max);
  const pad = n => String(n).padStart(2, '0');

  openModal(`
    <div class="dp-head">
      <button type="button" class="dp-arrow" data-step="-1" aria-label="Previous month">‹</button>
      <select class="dp-month" aria-label="Month">${monthNames(innerWidth < 380 ? 'short' : 'long').map((n, i) => `<option value="${i + 1}">${n}</option>`).join('')}</select>
      <select class="dp-year" aria-label="Year">${Array.from({ length: lastYear - firstYear + 1 }, (_, i) => lastYear - i).map(yr => `<option>${yr}</option>`).join('')}</select>
      <button type="button" class="dp-arrow" data-step="1" aria-label="Next month">›</button>
    </div>
    <div class="dp-weekdays" aria-hidden="true"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
    <div class="dp-grid"></div>
    <div class="dp-foot">
      ${clearable ? '<button type="button" class="btn ghost small" data-clear>Clear</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn ghost small" data-today${allowed(t) ? '' : ' disabled'}>Today</button>
    </div>`, (modal, close) => {
    modal.classList.add('dp-modal');
    const monthSel = $('.dp-month', modal), yearSel = $('.dp-year', modal), grid = $('.dp-grid', modal);
    const pick = v => { close(); onPick(v); };

    function draw() {
      monthSel.value = String(m);
      yearSel.value = String(y);
      const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      let html = '<span></span>'.repeat(lead);
      for (let d = 1; d <= days; d++) {
        const iso = `${y}-${pad(m)}-${pad(d)}`;
        html += `<button type="button" class="dp-day${iso === value ? ' selected' : ''}${iso === t ? ' today' : ''}" data-date="${iso}"${allowed(iso) ? '' : ' disabled'} aria-label="${Dates.pretty(iso)}">${d}</button>`;
      }
      grid.innerHTML = html;
      $$('[data-date]', grid).forEach(b => { b.onclick = () => pick(b.dataset.date); });
      $$('[data-step]', modal).forEach(b => {
        const step = Number(b.dataset.step);
        const ny = m + step < 1 ? y - 1 : m + step > 12 ? y + 1 : y;
        b.disabled = ny < firstYear || ny > lastYear;
      });
    }
    $$('[data-step]', modal).forEach(b => {
      b.onclick = () => {
        m += Number(b.dataset.step);
        if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
        draw();
      };
    });
    monthSel.onchange = () => { m = Number(monthSel.value); draw(); };
    yearSel.onchange = () => { y = Number(yearSel.value); draw(); };
    $('[data-today]', modal).onclick = () => pick(t);
    if ($('[data-clear]', modal)) $('[data-clear]', modal).onclick = () => pick('');
    draw();
    const focusDay = $('.dp-day.selected', grid) || $('.dp-day.today', grid);
    if (focusDay) focusDay.focus();
  });
}

// ---------- pop-up modal ----------
function openModal(html, onMount) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => {
    const modals = $$('.modal-backdrop');
    if (e.key === 'Escape' && modals[modals.length - 1] === wrap) close();
  };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  const modal = $('.modal', wrap);
  if (onMount) onMount(modal, close);
  const first = $('input, select, textarea, button', modal);
  if (first && !modal.contains(document.activeElement)) first.focus();
  return close;
}

// ---------- routing ----------
function parseHash() {
  const [path, q] = (location.hash.replace(/^#/, '') || '/').split('?');
  return { path: path || '/', params: new URLSearchParams(q || '') };
}
const inviteFromUrl = () => new URLSearchParams(location.search).get('invite') || '';

function route() {
  const { path, params } = parseHash();
  if (!state.user) {
    const invite = inviteFromUrl();
    if (path === '/reset') return renderReset();
    if (path === '/signup' || invite) return renderSignup(invite || params.get('code') || '');
    return renderLogin();
  }
  if (!state.profile) return renderFinishSignup(inviteFromUrl());
  if (path === '/new') return renderEdit(null);
  if (path === '/settings') return renderSettings();
  const m = path.match(/^\/cert\/([^/]+)(\/edit)?$/);
  if (m) return m[2] ? renderEdit(m[1]) : renderDetail(m[1]);
  renderDashboard();
}

async function loadSession() {
  state.profile = await Store.getProfile().catch(e => { console.error(e); return null; });
  if (!state.profile) return;
  state.unwatch = Store.watchCerts(certs => {
    const first = !state.certsLoaded;
    state.certs = certs;
    state.certsLoaded = true;
    // Only the dashboard re-draws live; other screens re-draw after their own saves.
    if (first || parseHash().path === '/') route();
  }, e => toast(friendlyError(e), true));
}

function stopWatching() {
  if (state.unwatch) { state.unwatch(); state.unwatch = null; }
}

// ---------- shared pieces ----------
const LOGO = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor"/><path d="m8.5 12 2.5 2.5 4.5-5" fill="none" stroke="var(--surface)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const BRAND = `<a class="brand" href="#/">${LOGO}<span>CertKeeper</span></a>`;
const PRIVACY_NOTE = `<p class="privacy">Your certifications and files are private to your account. Nobody else who uses CertKeeper, including the person who invited you, can see them.</p>`;

const topbar = (left, right = '') => `<header class="topbar">${left}<div class="topbar-actions">${right}</div></header>`;
const back = (href, text) => `<a class="back" href="${href}">← ${text}</a>`;
const authShell = inner => `<div class="auth"><div class="auth-card"><div class="brand big">${LOGO}<span>CertKeeper</span></div>${inner}</div></div>`;

function renderLoading() {
  view.innerHTML = `<p class="loading">Loading…</p>`;
}
function renderNotFound() {
  view.innerHTML = topbar(back('#/', 'All certs')) + `<div class="empty"><p>That certification wasn’t found. It may have been deleted.</p></div>`;
}
function renderSetupNeeded() {
  view.innerHTML = authShell(`
    <h1>Setup needed</h1>
    <p>CertKeeper isn’t connected to Firebase yet. Paste your project’s config into <code>firebase-config.js</code>. The README walks through it step by step.</p>`);
}

// ---------- sign in / sign up ----------
function renderLogin() {
  view.innerHTML = authShell(`
    <h1>Sign in</h1>
    <form id="f" class="stack">
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary block">Sign in</button>
    </form>
    <p class="small"><a href="#/reset">Forgot password?</a></p>
    <p class="small muted">New here? Use the invite link from whoever shared CertKeeper with you.</p>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    const f = e.target.elements;
    busy($('#f button'), () => Store.signIn(f.email.value.trim(), f.password.value));
  };
}

function renderSignup(code) {
  view.innerHTML = authShell(`
    <h1>Create your account</h1>
    <form id="f" class="stack">
      <label>Your name<input name="fullName" autocomplete="name" required></label>
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password <span class="muted">(8+ characters)</span><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      ${code
        ? `<input type="hidden" name="code" value="${esc(code)}"><p class="ok-note">✓ Invite link applied</p>`
        : `<label>Invite code<input name="code" autocomplete="off" required></label>`}
      <button class="btn primary block">Create account</button>
    </form>
    <p class="small">Already have an account? <a href="#/login">Sign in</a></p>
    ${PRIVACY_NOTE}`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    const f = e.target.elements;
    busy($('#f button'), () => signUp(f.fullName.value.trim(), f.email.value.trim(), f.password.value, f.code.value.trim()));
  };
}

async function signUp(name, email, password, code) {
  state.signingUp = true;
  try {
    const { user } = await Store.signUp(email, password);
    try {
      await Store.createProfile({ name, inviteCode: code });
    } catch (e) {
      // Wrong code: don't leave a half-made login behind.
      await user.delete().catch(() => {});
      throw e.code === 'permission-denied'
        ? new Error('That invite code isn’t valid. Ask whoever shared CertKeeper for the current link.')
        : e;
    }
  } finally {
    state.signingUp = false;
  }
  history.replaceState(null, '', location.pathname + '#/');
  state.user = Store.currentUser();
  await loadSession();
  route();
}

// Signed in but no profile yet (e.g. the invite code step failed earlier).
function renderFinishSignup(code) {
  view.innerHTML = authShell(`
    <h1>Almost done</h1>
    <p class="small muted">Signed in as ${esc(state.user.email)}. Enter your invite code to finish setting up.</p>
    <form id="f" class="stack">
      <label>Your name<input name="fullName" autocomplete="name" required></label>
      <label>Invite code<input name="code" value="${esc(code)}" autocomplete="off" required></label>
      <button class="btn primary block">Finish</button>
    </form>
    <p class="small"><a href="#" id="out">Sign out</a></p>`);
  $('#out').onclick = e => { e.preventDefault(); Store.signOut(); };
  $('#f').onsubmit = e => {
    e.preventDefault();
    const f = e.target.elements;
    busy($('#f button'), async () => {
      try {
        await Store.createProfile({ name: f.fullName.value.trim(), inviteCode: f.code.value.trim() });
      } catch (err) {
        throw err.code === 'permission-denied' ? new Error('That invite code isn’t valid.') : err;
      }
      history.replaceState(null, '', location.pathname + '#/');
      await loadSession();
      route();
    });
  };
}

function renderReset() {
  view.innerHTML = authShell(`
    <h1>Reset password</h1>
    <form id="f" class="stack">
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <button class="btn primary block">Send reset link</button>
    </form>
    <p class="small"><a href="#/login">Back to sign in</a></p>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    busy($('#f button'), async () => {
      await Store.resetPassword(e.target.elements.email.value.trim());
      toast('If that email has an account, a reset link is on its way.');
    });
  };
}

// ---------- dashboard ----------
function renderDashboard() {
  if (!state.certsLoaded) return renderLoading();
  const t = Dates.today();
  const certs = sortedCerts();
  const attention = certs.filter(c => needsAttention(c, t));

  view.innerHTML = topbar(BRAND,
    `<a class="btn primary" href="#/new">+ Add cert</a><a class="btn ghost icon" href="#/settings" aria-label="Settings" title="Settings">⚙︎</a>`) + `
    ${attention.length ? `
      <section class="banner">
        <strong>${attention.length === 1 ? '1 certification needs' : `${attention.length} certifications need`} attention</strong>
        <ul>${attention.map(c => `<li><a href="#/cert/${c.id}">${esc(label(c))}</a>: ${esc(daysText(Dates.status(c, t).days))}</li>`).join('')}</ul>
      </section>` : ''}
    ${certs.length ? `<div class="cards">${certs.map(c => certCard(c, t)).join('')}</div>` : `
      <div class="empty">
        <h2>No certifications yet</h2>
        <p>Add your first one. Pick a template and just fill in your number and dates.</p>
        <a class="btn primary" href="#/new">+ Add a certification</a>
      </div>`}`;

  $$('[data-renewed]', view).forEach(b => { b.onclick = () => openRenewModal(certById(b.dataset.renewed)); });
  $$('[data-card]', view).forEach(b => { b.onclick = () => openCardModal(certById(b.dataset.card)); });
  maybeShowDailyPopup(attention);
}

function certCard(c, t) {
  const s = Dates.status(c, t);
  const renew = safeUrl(c.renewLink);
  const meta = [c.issuer, c.certNumber && `#${c.certNumber}`].filter(Boolean).join(' · ');
  return `
    <article class="cert-card st-${s.key}">
      <a class="cert-main" href="#/cert/${c.id}">
        <div class="cert-top"><span class="cert-abbr">${esc(label(c))}</span><span class="pill st-${s.key}">${STATUS_TEXT[s.key]}</span></div>
        ${c.abbr && c.abbr !== c.name ? `<div class="cert-name">${esc(c.name)}</div>` : ''}
        ${meta ? `<div class="cert-meta">${esc(meta)}</div>` : ''}
        ${c.firstIssuedOn && Dates.tenure(c.firstIssuedOn) ? `<div class="tenure">Held ${esc(Dates.tenure(c.firstIssuedOn))}</div>` : ''}
        <div class="cert-exp">${c.expiresOn ? `Expires <strong>${Dates.pretty(c.expiresOn)}</strong> <span class="countdown">${daysText(s.days)}${isSnoozed(c, t) && s.key !== 'ok' ? ' · <span class="muted">snoozed</span>' : ''}</span>` : 'No expiration date'}</div>
      </a>
      <div class="cert-actions">
        ${renew ? `<a class="btn small" href="${esc(renew)}" target="_blank" rel="noopener">Renew ↗</a>` : ''}
        <button class="btn small" data-renewed="${c.id}">I renewed</button>
        ${hasCard(c) ? `<button class="btn small card-btn" data-card="${c.id}">${CARD_ICON}Card</button>` : ''}
      </div>
    </article>`;
}

// The "heads up" pop-up shows once a day per device when something is due.
function maybeShowDailyPopup(attention) {
  if (!attention.length || $('.modal-backdrop')) return;
  const key = `ck-popup-${state.user.uid}`;
  const t = Dates.today();
  if (maybeShowDailyPopup.shownOn === t) return;
  try {
    if (localStorage.getItem(key) === t) return;
    localStorage.setItem(key, t);
  } catch { /* storage blocked (private mode): fall back to once per page load */ }
  maybeShowDailyPopup.shownOn = t;

  openModal(`
    <h2>Heads up</h2>
    <p class="small muted">${attention.length === 1 ? 'This certification needs' : 'These certifications need'} your attention:</p>
    <ul class="attn-list">${attention.map(c => {
      const s = Dates.status(c, t);
      const renew = safeUrl(c.renewLink);
      return `<li class="st-${s.key}">
        <div><strong>${esc(label(c))}</strong><div class="small muted">${Dates.pretty(c.expiresOn)} · ${daysText(s.days)}</div></div>
        <div class="row wrap">
          ${renew ? `<a class="btn small" href="${esc(renew)}" target="_blank" rel="noopener">Renew ↗</a>` : ''}
          <button class="btn small" data-renewed="${c.id}">I renewed</button>
          <button class="btn small ghost" data-snooze="${c.id}">Snooze</button>
        </div></li>`;
    }).join('')}</ul>
    <div class="modal-actions"><button class="btn primary" data-close>Got it</button></div>`, (m, close) => {
    $$('[data-renewed]', m).forEach(b => { b.onclick = () => { close(); openRenewModal(certById(b.dataset.renewed)); }; });
    $$('[data-snooze]', m).forEach(b => {
      b.onclick = () => openSnoozeModal(certById(b.dataset.snooze), () => {
        b.closest('li').remove();
        if (!$('.attn-list li', m)) close();
        if (parseHash().path === '/') renderDashboard();
      });
    });
  });
}

// ---------- snooze ("remind me again in ...") ----------
const SNOOZE_CHOICES = [[3, '3 days'], [7, '1 week'], [14, '2 weeks']];

function openSnoozeModal(cert, done) {
  const t = Dates.today();
  const expired = Dates.status(cert, t).key === 'expired';
  const fits = n => expired || Dates.addDays(t, n) < cert.expiresOn;
  const emailed = !expired && state.profile.emailReminders !== false;
  openModal(`
    <h2>Remind me later</h2>
    <p class="small muted">${esc(label(cert))} ${expired ? 'expired' : 'expires'} ${Dates.pretty(cert.expiresOn)}. The heads-up hides until the date you pick${emailed ? ', and you’ll get a fresh reminder email that morning' : ''}.</p>
    <div class="row wrap">${SNOOZE_CHOICES.filter(([n]) => fits(n)).map(([n, text]) => `<button class="btn" data-days="${n}">${text}</button>`).join('')}</div>
    <form id="sz" class="inline custom-rem">
      <span class="small">Or in</span>
      <input type="number" name="n" min="1" max="60" placeholder="10" aria-label="How many" inputmode="numeric" required>
      <select name="u" aria-label="Days or weeks"><option value="d">days</option><option value="w">weeks</option></select>
      <button class="btn small">Snooze</button>
    </form>
    <div class="modal-actions"><button class="btn ghost" data-close>Cancel</button></div>`, (m, close) => {
    const go = (days, btn) => {
      const until = Dates.addDays(Dates.today(), days);
      if (!fits(days)) return toast(`That’s after it expires (${Dates.pretty(cert.expiresOn)}). Pick a shorter time.`, true);
      busy(btn, async () => {
        await Store.snooze(cert.id, until);
        applyLocal(cert.id, { snoozedUntil: until, remindAgainOn: until });
        close();
        toast(`Snoozed. We’ll remind you again on ${Dates.pretty(until)}.`);
        if (done) done();
      });
    };
    $$('[data-days]', m).forEach(b => { b.onclick = () => go(Number(b.dataset.days), b); });
    $('#sz', m).onsubmit = e => {
      e.preventDefault();
      const f = e.target.elements;
      const n = parseInt(f.n.value, 10);
      if (!(n >= 1)) return;
      go(f.u.value === 'w' ? n * 7 : n, $('button', e.target));
    };
  });
}

// ---------- "I renewed" ----------
function openRenewModal(cert) {
  if (!cert) return;
  const t = Dates.today();
  openModal(`
    <h2>Renewed ${esc(label(cert))}?</h2>
    <p class="small muted">Current expiration: ${cert.expiresOn ? Dates.pretty(cert.expiresOn) : '—'}</p>
    <form id="rn" class="stack">
      <label>Date you renewed / took the class<input type="date" name="renewedOn" value="${t}" max="${t}" required></label>
      <label>New expiration date<input type="date" name="expiresOn" required></label>
      <p class="hint" id="rn-hint"></p>
      <label>New card <span class="muted">(photo or PDF, optional)</span><input type="file" name="cardFront" accept="image/*,application/pdf"></label>
      <label>Back of card <span class="muted">(optional)</span><input type="file" name="cardBack" accept="image/*,application/pdf"></label>
      <p class="small muted">${listText(['This cycle’s documents', hasCard(cert) && 'your current card', cert.trackerEnabled && esc((cert.trackerLabel || 'log').toLowerCase())])} move to <em>Past cycles</em>. Nothing is deleted.</p>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn primary" id="rn-ok">Confirm renewal</button>
      </div>
    </form>`, (m, close) => {
    enhanceDateInputs(m);
    const f = $('#rn', m).elements;
    const hint = $('#rn-hint', m);
    let typed = false;
    const refresh = () => {
      if (typed) return;
      const s = Dates.suggestExpiration(cert.renewalRule, cert.expiresOn, f.renewedOn.value, cert.validityMonths);
      f.expiresOn.value = s;
      hint.textContent = s
        ? `Suggested from this cert’s rule (${Dates.RULES[cert.renewalRule].toLowerCase()}). Check it against your new card.`
        : 'Enter the expiration date from your new card.';
    };
    f.renewedOn.oninput = refresh;
    f.expiresOn.oninput = () => { typed = true; hint.textContent = 'Using the date you entered.'; };
    refresh();

    $('#rn', m).onsubmit = e => {
      e.preventDefault();
      const renewedOn = f.renewedOn.value, expiresOn = f.expiresOn.value;
      if (!Dates.isValid(renewedOn) || !Dates.isValid(expiresOn)) return toast('Pick both dates.', true);
      if (expiresOn <= renewedOn) return toast('The new expiration should be after the renewal date.', true);
      const newCard = { front: f.cardFront.files[0], back: f.cardBack.files[0] };
      busy($('#rn-ok', m), async () => {
        Store.checkFiles(CARD_SIDES.map(s => newCard[s]).filter(Boolean));
        const cycleId = await Store.renewCert(cert, { renewedOn, expiresOn });
        applyLocal(cert.id, { issuedOn: renewedOn, expiresOn, lastRenewedOn: renewedOn, currentCycleId: cycleId, card: null, remindersSent: [], snoozedUntil: null });
        for (const side of CARD_SIDES) {
          if (!newCard[side]) continue;
          const c = certById(cert.id) || cert;
          const meta = await Store.setCardFile(c, side, newCard[side]);
          applyLocal(cert.id, { card: { ...(c.card || {}), [side]: meta } });
        }
        close();
        toast(`${label(cert)} renewed. Next expiration ${Dates.pretty(expiresOn)}.`);
        route();
      });
    };
  });
}

// ---------- cert detail ----------
function renderDetail(id) {
  if (!state.certsLoaded) return renderLoading();
  const c = certById(id);
  if (!c) return renderNotFound();
  const t = Dates.today();
  const s = Dates.status(c, t);
  const renew = safeUrl(c.renewLink), instr = safeUrl(c.instructionsLink);
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;

  view.innerHTML = topbar(back('#/', 'All certs'), `<a class="btn ghost" href="#/cert/${c.id}/edit">Edit</a>`) + `
    <section class="detail-head st-${s.key}">
      <div class="cert-top"><h1>${esc(label(c))}</h1><span class="pill st-${s.key}">${STATUS_TEXT[s.key]}</span></div>
      ${c.abbr && c.abbr !== c.name ? `<div class="cert-name">${esc(c.name)}</div>` : ''}
      ${c.issuer ? `<div class="cert-meta">${esc(c.issuer)}</div>` : ''}
      ${tenureText(c) ? `<div class="tenure">${esc(tenureText(c))}</div>` : ''}
      <p class="big-exp">${c.expiresOn ? `Expires ${Dates.pretty(c.expiresOn)} <span class="muted">· ${daysText(s.days)}</span>` : 'No expiration date'}</p>
      ${isSnoozed(c, t) && s.key !== 'ok' ? `<p class="small muted snoozed-note">Snoozed until ${Dates.pretty(c.snoozedUntil)}.</p>` : ''}
      <div class="row wrap">
        ${renew ? `<a class="btn primary" href="${esc(renew)}" target="_blank" rel="noopener">Renew ↗</a>` : ''}
        <button class="btn" id="renewed">I renewed</button>
        ${hasCard(c) ? `<button class="btn" id="view-card">${CARD_ICON}Card</button>` : ''}
        ${instr ? `<a class="btn" href="${esc(instr)}" target="_blank" rel="noopener">Instructions ↗</a>` : ''}
        ${c.instructionsFile ? `<button class="btn" id="instr-pdf">Instructions PDF</button>` : ''}
        ${needsAttention(c, t) ? `<button class="btn ghost" id="snooze">Snooze</button>` : ''}
      </div>
    </section>

    <section class="panel">
      <h2>Card</h2>
      <div class="card-slots">${CARD_SIDES.map(side => {
        const file = c.card && c.card[side];
        const name = side === 'front' ? 'Front' : 'Back';
        return file ? `
          <div class="card-slot">
            ${isPdf(file) ? `<button class="card-thumb pdf" data-view="${esc(file.path)}">PDF</button>` : `<button class="card-thumb" data-view="${esc(file.path)}"><img data-thumb="${esc(file.path)}" alt="${esc(label(c))} card, ${side}"></button>`}
            <div class="small"><strong>${name}</strong></div>
            <div class="row">
              <label class="link">Replace<input type="file" hidden accept="image/*,application/pdf" data-card-side="${side}"></label>
              <button class="link danger" data-card-rm="${side}">Remove</button>
            </div>
          </div>` : `
          <label class="card-slot empty">
            <span>+ ${side === 'front' ? 'Add card' : 'Add back (optional)'}</span>
            <input type="file" hidden accept="image/*,application/pdf" data-card-side="${side}">
          </label>`;
      }).join('')}</div>
      <p class="small muted">Your current card. When you renew, it moves to <em>Past cycles</em> and you add the new one.</p>
    </section>

    <section class="panel">
      <h2>Details</h2>
      <dl class="details">
        ${row('Cert / license #', c.certNumber ? `${esc(c.certNumber)} <button class="link" id="copy-num">Copy</button>` : '—')}
        ${c.licenseState ? row('State', esc(stateName(c.licenseState))) : ''}
        ${c.firstIssuedOn ? row('First certified', Dates.pretty(c.firstIssuedOn)) : ''}
        ${row('Issued / last renewed', c.issuedOn ? Dates.pretty(c.issuedOn) : '—')}
        ${row('Good for', validityText(c.validityMonths))}
        ${row('When I renew', esc(Dates.RULES[c.renewalRule] || '—'))}
        ${row('Reminders', (c.reminders || []).length ? c.reminders.map(o => esc(Dates.offsetLabel(o))).join(', ') : 'None')}
        ${c.requirements ? row('Needed to recert', `<span class="pre">${esc(c.requirements)}</span>`) : ''}
        ${c.notes ? row('Notes', `<span class="pre">${esc(c.notes)}</span>`) : ''}
      </dl>
    </section>
    <div id="cycles"><p class="muted loading">Loading documents…</p></div>`;

  $('#renewed').onclick = () => openRenewModal(c);
  if ($('#view-card')) $('#view-card').onclick = () => openCardModal(c);
  $$('.card-slots [data-view]').forEach(b => { b.onclick = () => openFile(b.dataset.view); });
  $$('[data-thumb]').forEach(img => { Store.fileUrl(img.dataset.thumb).then(url => { img.src = url; }).catch(() => {}); });
  $$('[data-card-side]').forEach(input => {
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const side = input.dataset.cardSide;
      toast('Uploading…');
      Store.setCardFile(c, side, file)
        .then(meta => { applyLocal(c.id, { card: { ...(c.card || {}), [side]: meta } }); toast('Card saved'); renderDetail(c.id); })
        .catch(e => { console.error(e); toast(friendlyError(e), true); });
    };
  });
  $$('[data-card-rm]').forEach(b => {
    b.onclick = () => {
      const side = b.dataset.cardRm;
      if (!confirm(`Remove the ${side} of this card? This deletes the file.`)) return;
      busy(b, async () => {
        await Store.removeCardFile(c, side);
        const card = { ...(c.card || {}) };
        delete card[side];
        applyLocal(c.id, { card });
        renderDetail(c.id);
      });
    };
  });
  if ($('#instr-pdf')) $('#instr-pdf').onclick = () => openFile(c.instructionsFile.path);
  if ($('#copy-num')) $('#copy-num').onclick = () => navigator.clipboard.writeText(c.certNumber).then(() => toast('Cert number copied'));
  if ($('#snooze')) $('#snooze').onclick = () => openSnoozeModal(c, () => renderDetail(c.id));
  loadCycles(c.id);
}

async function loadCycles(certId) {
  try {
    const cycles = await Store.getCycles(certId);
    const c = certById(certId);
    if (!c || parseHash().path !== `/cert/${certId}`) return; // navigated away meanwhile
    renderCycles(c, cycles);
  } catch (e) {
    console.error(e);
    const box = $('#cycles');
    if (box) box.innerHTML = `<p class="error-text">Couldn’t load documents: ${esc(friendlyError(e))}</p>`;
  }
}

function cycleRange(cy) {
  const a = cy.startOn ? Dates.pretty(cy.startOn) : '?', b = cy.expiresOn ? Dates.pretty(cy.expiresOn) : '?';
  return `${a} → ${b}`;
}

const uploadButton = (cycleId, text = 'Upload') =>
  `<label class="btn small">${text}<input type="file" hidden multiple accept="image/*,application/pdf" data-upload="${cycleId}"></label>`;

function fileList(cy) {
  if (!cy.files.length) return `<p class="small muted">No documents yet.</p>`;
  return `<ul class="files">${cy.files.map(f => `
    <li>
      <span class="file-kind">${f.contentType === 'application/pdf' ? 'PDF' : 'IMG'}</span>
      <button class="link file-name" data-view="${esc(f.path)}">${esc(f.name)}</button>
      <span class="small muted">${fmtSize(f.size)}</span>
      <button class="link danger" data-del-file="${cy.id}/${f.id}" aria-label="Delete ${esc(f.name)}">Delete</button>
    </li>`).join('')}</ul>`;
}

function trackerTotal(c, cy) {
  return c.trackerUnit === 'hours' ? cy.entries.reduce((sum, e) => sum + (Number(e.amount) || 0), 0) : cy.entries.length;
}

function entryList(c, cy) {
  if (!cy.entries.length) return `<p class="small muted">Nothing logged yet.</p>`;
  const hours = c.trackerUnit === 'hours';
  return `<ul class="entries">${cy.entries.map(e => `
    <li>
      <span class="entry-date">${Dates.pretty(e.date)}</span>
      <span class="entry-title">${esc(e.title)}${e.notes ? ` <span class="muted">· ${esc(e.notes)}</span>` : ''}</span>
      <span class="small muted">${hours ? `${fmtNum(Number(e.amount) || 0)} hrs` : (e.students ? `${e.students} students` : '')}</span>
      ${e.file ? `<button class="link" data-view="${esc(e.file.path)}">Proof</button>` : ''}
      <button class="link danger" data-del-entry="${cy.id}/${e.id}" aria-label="Delete entry">Delete</button>
    </li>`).join('')}</ul>`;
}

function renderCycles(c, cycles) {
  const current = cycles.find(x => x.id === c.currentCycleId) || { id: c.currentCycleId, files: [], entries: [] };
  const past = cycles.filter(x => x.id !== c.currentCycleId);
  const hours = c.trackerUnit === 'hours';
  const unit = hours ? 'hours' : 'classes';
  const open = new Set($$('#cycles details[open]').map(d => d.dataset.cycle));

  $('#cycles').innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>Documents <span class="muted">· this cycle</span></h2>${uploadButton(current.id)}</div>
      <p class="small muted">${cycleRange(current)}. Keep proof here: training trackers, CE certificates, class rosters.</p>
      ${fileList(current)}
    </section>

    ${c.trackerEnabled ? `
    <section class="panel">
      <div class="panel-head"><h2>${esc(c.trackerLabel || 'Tracker')}</h2></div>
      <p class="tally"><strong>${fmtNum(trackerTotal(c, current))}</strong>${c.trackerTarget ? ` of ${c.trackerTarget}` : ''} ${unit} this cycle</p>
      ${c.trackerTarget ? `<div class="meter"><span style="width:${Math.min(100, trackerTotal(c, current) / c.trackerTarget * 100)}%"></span></div>` : ''}
      <form id="entry-form" class="entry-form">
        <input type="date" name="date" value="${Dates.today()}" aria-label="Date" required>
        <input name="title" placeholder="${hours ? 'What you taught' : 'Course (e.g. BLS Provider)'}" aria-label="What" required>
        ${hours
          ? `<input type="number" name="amount" step="0.25" min="0" placeholder="Hours" aria-label="Hours" required>`
          : `<input type="number" name="students" min="0" placeholder="# students" aria-label="Number of students">`}
        <input name="notes" placeholder="Location / notes" aria-label="Notes">
        <label class="btn small file-pick"><span>Roster / proof</span><input type="file" name="proof" hidden accept="image/*,application/pdf"></label>
        <button class="btn small primary">Add</button>
      </form>
      ${entryList(c, current)}
    </section>` : ''}

    <section class="panel">
      <h2>Past cycles</h2>
      ${past.length ? past.map(p => `
        <details class="cycle" data-cycle="${p.id}"${open.has(p.id) ? ' open' : ''}>
          <summary>${cycleRange(p)}<span class="small muted"> · ${p.files.length} file${p.files.length === 1 ? '' : 's'}${p.entries.length ? ` · ${fmtNum(trackerTotal(c, p))} ${unit}` : ''}</span></summary>
          <div class="cycle-body">
            ${p.renewedOn ? `<p class="small muted">Renewed ${Dates.pretty(p.renewedOn)}</p>` : ''}
            ${fileList(p)}
            ${uploadButton(p.id, 'Add file to this cycle')}
            ${p.entries.length ? `<h3>${esc(c.trackerLabel || 'Log')}</h3>${entryList(c, p)}` : ''}
          </div>
        </details>`).join('') : `<p class="small muted">When you renew, this cycle moves here with all its documents, so you have everything if you’re audited.</p>`}
    </section>`;

  const reload = () => loadCycles(c.id);
  const byId = Object.fromEntries(cycles.map(cy => [cy.id, cy]));

  $$('[data-view]', view).forEach(b => { b.onclick = () => openFile(b.dataset.view); });

  $$('[data-upload]', view).forEach(input => {
    input.onchange = () => {
      const files = [...input.files];
      if (!files.length) return;
      const btn = input.closest('label');
      btn.classList.add('disabled');
      Promise.resolve().then(() => Store.uploadFiles(c.id, input.dataset.upload, files))
        .then(() => { toast(files.length === 1 ? 'Uploaded' : `${files.length} files uploaded`); reload(); })
        .catch(e => { console.error(e); toast(friendlyError(e), true); btn.classList.remove('disabled'); });
    };
  });

  $$('[data-del-file]', view).forEach(b => {
    b.onclick = () => {
      const [cycleId, fileId] = b.dataset.delFile.split('/');
      const file = byId[cycleId].files.find(f => f.id === fileId);
      if (!confirm(`Delete "${file.name}"? This can’t be undone.`)) return;
      busy(b, async () => { await Store.deleteFile(c.id, cycleId, file); reload(); });
    };
  });

  $$('[data-del-entry]', view).forEach(b => {
    b.onclick = () => {
      const [cycleId, entryId] = b.dataset.delEntry.split('/');
      const entry = byId[cycleId].entries.find(e => e.id === entryId);
      if (!confirm(`Delete "${entry.title}" from ${Dates.pretty(entry.date)}?`)) return;
      busy(b, async () => { await Store.deleteEntry(c.id, cycleId, entry); reload(); });
    };
  });

  const form = $('#entry-form');
  if (form) {
    enhanceDateInputs(form);
    const f = form.elements;
    f.proof.onchange = () => { $('.file-pick span', form).textContent = f.proof.files[0] ? f.proof.files[0].name : 'Roster / proof'; };
    form.onsubmit = e => {
      e.preventDefault();
      if (!Dates.isValid(f.date.value)) return toast('Pick a date.', true);
      const entry = { date: f.date.value, title: f.title.value.trim(), notes: f.notes.value.trim() };
      if (hours) entry.amount = Number(f.amount.value) || 0;
      else if (f.students.value) entry.students = Number(f.students.value);
      busy($('button.primary', form), async () => {
        await Store.addEntry(c.id, current.id, entry, f.proof.files[0] || null);
        toast('Added');
        reload();
      });
    };
  }
}

// ---------- add / edit ----------
function renderEdit(certId) {
  if (certId && !state.certsLoaded) return renderLoading();
  const editing = certId ? certById(certId) : null;
  if (certId && !editing) return renderNotFound();
  const cancelHref = editing ? `#/cert/${editing.id}` : '#/';
  const groups = [...new Set(TEMPLATES.map(t => t.group))];

  view.innerHTML = topbar(back(cancelHref, editing ? 'Back' : 'Cancel')) + `
    <h1 class="page-title">${editing ? `Edit ${esc(label(editing))}` : 'Add a certification'}</h1>
    <form id="cf" class="form" novalidate>
      ${editing ? '' : `
      <section class="panel stack">
        <label>Start from a template
          <select name="template">
            <option value="">Custom (start blank)</option>
            ${groups.map(g => `<optgroup label="${esc(g)}">${TEMPLATES.filter(t => t.group === g).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}
          </select>
        </label>
        <p class="hint">Fills in the issuer, links and renewal rule. You add your number and dates.</p>
      </section>`}

      <section class="panel stack">
        <h2>The basics</h2>
        <label>Certification name *<input name="name" required placeholder="e.g. National Registry EMT"></label>
        <div class="grid2">
          <label>Short name<input name="abbr" placeholder="e.g. NREMT"></label>
          <label>Issued by<input name="issuer" placeholder="e.g. National Registry"></label>
        </div>
        <div class="grid2">
          <label>Cert / license number<input name="certNumber" autocomplete="off"></label>
          <label><span>State <span class="muted" id="state-hint">(if it’s a state license)</span></span>
            <select name="licenseState">
              <option value="">Not state-specific</option>
              ${Object.entries(US_STATES).map(([code, n]) => `<option value="${code}">${esc(stateName(code))}</option>`).join('')}
            </select>
          </label>
        </div>
      </section>

      <section class="panel stack">
        <h2>Dates & renewal</h2>
        <div class="grid2">
          <label>Issued / last renewed<input type="date" name="issuedOn"></label>
          <label>Expires *<input type="date" name="expiresOn" required></label>
        </div>
        <button type="button" class="link add-first" id="show-first">+ Add the date you were first certified</button>
        <label id="first-field" hidden>First certified <span class="hint">The very first time you earned it (it never changes when you renew). Shows how long you’ve held it.</span>
          <input type="date" name="firstIssuedOn" max="${Dates.today()}">
        </label>
        <div class="grid2">
          <label>Good for
            <span class="inline"><input type="number" name="validityN" min="1" max="120" inputmode="numeric"><select name="validityUnit"><option value="y">years</option><option value="m">months</option></select></span>
          </label>
          <label>When I renew, the new expiration is…
            <select name="renewalRule">${Object.entries(Dates.RULES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
          </label>
        </div>
        <label>What’s needed to recert<textarea name="requirements" rows="3" placeholder="e.g. 40 hrs CE, skills check"></textarea></label>
      </section>

      <section class="panel stack">
        <h2>Where to renew</h2>
        <label>Renewal website<input type="url" name="renewLink" placeholder="https://"></label>
        <label>Step-by-step instructions link<input type="url" name="instructionsLink" placeholder="https://"></label>
        <div class="stack tight">
          <span class="field-label">Instructions PDF</span>
          ${editing && editing.instructionsFile ? `
            <p class="small">Current: <button type="button" class="link" id="instr-view">${esc(editing.instructionsFile.name)}</button>
            <label class="check inline-check"><input type="checkbox" name="removeInstr"> Remove</label></p>` : ''}
          <input type="file" name="instrFile" accept="application/pdf,image/*">
        </div>
      </section>

      <section class="panel stack">
        <h2>Remind me</h2>
        <div class="chips" id="rem-chips"></div>
        <div class="inline custom-rem">
          <span class="small">Custom:</span>
          <input type="number" id="rem-n" min="1" max="365" placeholder="10" aria-label="Custom reminder amount" inputmode="numeric">
          <select id="rem-u" aria-label="Custom reminder unit"><option value="d">days</option><option value="w">weeks</option><option value="m">months</option></select>
          <span class="small">before</span>
          <button type="button" class="btn small" id="rem-add">Add</button>
        </div>
        <p class="hint">You get an email on each date you pick, plus a heads-up in CertKeeper.</p>
      </section>

      <section class="panel stack">
        <h2>Optional tracker</h2>
        <label class="check"><input type="checkbox" name="trackerEnabled"> Track classes I teach or hours here</label>
        <div id="tracker-fields" class="grid3">
          <label>Call it<input name="trackerLabel" placeholder="e.g. Courses taught"></label>
          <label>Count<select name="trackerUnit"><option value="classes">classes</option><option value="hours">hours</option></select></label>
          <label>Goal per cycle<input type="number" name="trackerTarget" min="0" step="any" placeholder="e.g. 4"></label>
        </div>
      </section>

      <section class="panel stack">
        <h2>Notes</h2>
        <textarea name="notes" rows="3" aria-label="Notes"></textarea>
      </section>

      <div class="form-actions">
        ${editing ? `<button type="button" class="btn danger ghost" id="del">Delete cert</button>` : ''}
        <span class="spacer"></span>
        <a class="btn ghost" href="${cancelHref}">Cancel</a>
        <button class="btn primary" id="save">Save</button>
      </div>
    </form>`;

  const form = $('#cf');
  enhanceDateInputs(form);
  const f = form.elements;
  let reminders = new Set(editing ? editing.reminders || [] : ['1m']);

  function fill(c) {
    for (const k of ['name', 'abbr', 'issuer', 'certNumber', 'licenseState', 'firstIssuedOn', 'issuedOn', 'expiresOn', 'requirements', 'renewLink', 'instructionsLink', 'notes', 'trackerLabel']) {
      if (c[k] !== undefined) f[k].value = c[k] || '';
    }
    if (c.renewalRule) f.renewalRule.value = c.renewalRule;
    if (c.validityMonths !== undefined) {
      const m = c.validityMonths;
      f.validityUnit.value = m && m % 12 === 0 ? 'y' : 'm';
      f.validityN.value = m ? (m % 12 === 0 ? m / 12 : m) : '';
    }
    if (c.firstIssuedOn) showFirst(true);
    if (c.trackerEnabled !== undefined) f.trackerEnabled.checked = !!c.trackerEnabled;
    if (c.trackerUnit) f.trackerUnit.value = c.trackerUnit;
    if (c.trackerTarget !== undefined) f.trackerTarget.value = c.trackerTarget || '';
    syncTracker();
  }

  function showFirst(show) {
    $('#first-field').hidden = !show;
    $('#show-first').hidden = show;
  }
  $('#show-first').onclick = () => { showFirst(true); f.firstIssuedOn.focus(); };

  function syncTracker() {
    $('#tracker-fields').hidden = !f.trackerEnabled.checked;
  }

  function drawChips() {
    const custom = [...reminders].filter(o => !Dates.PRESET_OFFSETS.includes(o));
    const nice = o => Dates.offsetLabel(o).replace(/ before$/, '');
    $('#rem-chips').innerHTML =
      Dates.PRESET_OFFSETS.map(o => `<button type="button" class="chip" aria-pressed="${reminders.has(o)}" data-off="${o}">${nice(o)}</button>`).join('') +
      Dates.sortOffsets(custom).map(o => `<span class="chip on">${nice(o)}<button type="button" class="chip-x" data-rm="${o}" aria-label="Remove ${nice(o)}">×</button></span>`).join('');
    $$('[data-off]', form).forEach(b => {
      b.onclick = () => { reminders.has(b.dataset.off) ? reminders.delete(b.dataset.off) : reminders.add(b.dataset.off); drawChips(); };
    });
    $$('[data-rm]', form).forEach(b => { b.onclick = () => { reminders.delete(b.dataset.rm); drawChips(); }; });
  }

  $('#rem-add').onclick = () => {
    const n = parseInt($('#rem-n').value, 10);
    if (!n || n < 1) return toast('Enter how many days, weeks or months before.', true);
    reminders.add(`${n}${$('#rem-u').value}`);
    $('#rem-n').value = '';
    drawChips();
  };

  const validityMonths = () => {
    const n = parseInt(f.validityN.value, 10);
    return n > 0 ? (f.validityUnit.value === 'y' ? n * 12 : n) : null;
  };

  // New cert: once there's an issue date, fill an empty expiration for them.
  f.issuedOn.addEventListener('change', () => {
    if (f.expiresOn.value || !f.issuedOn.value) return;
    const rule = f.renewalRule.value === 'classDateEOM' ? 'classDateEOM' : 'classDate';
    const s = Dates.suggestExpiration(rule, null, f.issuedOn.value, validityMonths());
    if (s) { f.expiresOn.value = s; toast('Expiration filled in from the issue date. Double-check it against your card.'); }
  });

  f.trackerEnabled.onchange = syncTracker;

  if (f.template) {
    const chosen = () => TEMPLATES.find(x => x.id === f.template.value);
    f.template.onchange = () => {
      const t = chosen();
      $('#state-hint').textContent = t && t.askState ? '(pick yours)' : '(if it’s a state license)';
      if (!t) return;
      fill(templateFields(t, f.licenseState.value));
      if (t.askState && !f.licenseState.value) f.licenseState.focus();
    };
    // State licenses (RN): switching the state swaps in that state's board.
    f.licenseState.addEventListener('change', () => {
      const t = chosen();
      if (t && t.askState) fill(templateFields(t, f.licenseState.value));
    });
  }

  if (editing) {
    fill(editing);
    if ($('#instr-view')) $('#instr-view').onclick = () => openFile(editing.instructionsFile.path);
    $('#del').onclick = e => {
      if (!confirm(`Delete ${label(editing)} and ALL its documents and past cycles? This can’t be undone.\n\nTip: Settings → Download all saves a copy first.`)) return;
      busy(e.target, async () => {
        await Store.deleteCert(editing);
        toast(`${label(editing)} deleted`);
        location.hash = '#/';
      });
    };
  } else {
    fill({ renewalRule: 'classDate', validityMonths: 24 });
  }
  drawChips();

  form.onsubmit = e => {
    e.preventDefault();
    const name = f.name.value.trim();
    const expiresOn = f.expiresOn.value;
    if (!name) return toast('Give the certification a name.', true);
    if (!Dates.isValid(expiresOn)) return toast('Add the expiration date.', true);
    for (const k of ['renewLink', 'instructionsLink']) {
      if (f[k].value.trim() && !safeUrl(f[k].value.trim())) return toast('Links need to start with https://', true);
    }
    if (f.firstIssuedOn.value && f.firstIssuedOn.value > Dates.today()) return toast('First certified can’t be in the future.', true);
    const instrFile = f.instrFile.files[0] || null;
    const data = {
      name,
      abbr: f.abbr.value.trim(),
      issuer: f.issuer.value.trim(),
      certNumber: f.certNumber.value.trim(),
      licenseState: f.licenseState.value,
      firstIssuedOn: f.firstIssuedOn.value || null,
      issuedOn: f.issuedOn.value || null,
      expiresOn,
      validityMonths: validityMonths(),
      renewalRule: f.renewalRule.value,
      requirements: f.requirements.value.trim(),
      renewLink: f.renewLink.value.trim(),
      instructionsLink: f.instructionsLink.value.trim(),
      reminders: Dates.sortOffsets([...reminders]),
      trackerEnabled: f.trackerEnabled.checked,
      trackerLabel: f.trackerLabel.value.trim(),
      trackerUnit: f.trackerUnit.value,
      trackerTarget: Number(f.trackerTarget.value) || null,
      notes: f.notes.value.trim(),
    };
    busy($('#save'), async () => {
      if (instrFile) Store.checkFiles([instrFile]);
      let id;
      if (editing) {
        await Store.updateCert(editing, data);
        id = editing.id;
        applyLocal(id, data);
      } else {
        id = await Store.createCert(data);
        await waitForCert(id);
      }
      const saved = { id, instructionsFile: editing ? editing.instructionsFile : null };
      if (instrFile) applyLocal(id, { instructionsFile: await Store.setInstructionsFile(saved, instrFile) });
      else if (f.removeInstr && f.removeInstr.checked) {
        await Store.removeInstructionsFile(saved);
        applyLocal(id, { instructionsFile: null });
      }
      toast('Saved');
      location.hash = `#/cert/${id}`;
    });
  };
}

// ---------- settings ----------
function renderSettings() {
  const p = state.profile, u = state.user;
  view.innerHTML = topbar(back('#/', 'All certs')) + `
    <h1 class="page-title">Settings</h1>

    <section class="panel stack">
      <h2>Profile</h2>
      <form id="pf" class="stack">
        <label>Name<input name="fullName" autocomplete="name" value="${esc(p.name || '')}"></label>
        <p class="small muted">Signed in as ${esc(u.email)}</p>
        <div><button class="btn">Save name</button></div>
      </form>
    </section>

    <section class="panel stack">
      <h2>Appearance</h2>
      <div class="segmented" role="group" aria-label="Appearance">
        ${[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, t]) =>
          `<button type="button" data-theme-pick="${k}" aria-pressed="${getTheme() === k}">${t}</button>`).join('')}
      </div>
      <p class="small muted">Saved on this device only.</p>
    </section>

    <section class="panel stack">
      <h2>Reminders</h2>
      <label class="check"><input type="checkbox" id="email-on"${p.emailReminders !== false ? ' checked' : ''}> Email me reminders</label>
      <p class="small muted">Sent to ${esc(u.email)} around 8 AM Eastern on each reminder date you set for a cert. When you open CertKeeper you’ll also see a heads-up for anything coming due.</p>
    </section>

    <section class="panel stack">
      <h2>Your files</h2>
      <p class="small muted">Download every document you’ve uploaded as one ZIP, organized by certification and cycle. Useful for an audit or as a backup.</p>
      <div><button class="btn" id="zip">Download all (ZIP)</button></div>
    </section>

    <section class="panel stack">
      <h2>Account</h2>
      <div class="row wrap">
        <button class="btn" id="pw">Email me a password reset link</button>
        <button class="btn" id="out">Sign out</button>
      </div>
    </section>

    <section class="panel stack danger-zone">
      <h2>Delete account</h2>
      <p class="small muted">Permanently deletes your account, certifications and every uploaded file. Download your files first if you want to keep them.</p>
      <div><button class="btn danger" id="delacct">Delete my account</button></div>
    </section>
    ${PRIVACY_NOTE}`;

  $('#pf').onsubmit = e => {
    e.preventDefault();
    const name = e.target.elements.fullName.value.trim();
    busy($('#pf button'), async () => { await Store.updateProfile({ name }); state.profile.name = name; toast('Saved'); });
  };
  $$('[data-theme-pick]').forEach(b => {
    b.onclick = () => {
      setTheme(b.dataset.themePick);
      $$('[data-theme-pick]').forEach(x => x.setAttribute('aria-pressed', x === b));
    };
  });
  $('#email-on').onchange = e => {
    const on = e.target.checked;
    Store.updateProfile({ emailReminders: on })
      .then(() => { state.profile.emailReminders = on; toast(on ? 'Email reminders on' : 'Email reminders off'); })
      .catch(err => { e.target.checked = !on; toast(friendlyError(err), true); });
  };
  $('#pw').onclick = e => busy(e.target, async () => { await Store.resetPassword(u.email); toast(`Reset link sent to ${u.email}`); });
  $('#out').onclick = () => Store.signOut();
  $('#zip').onclick = e => busy(e.target, downloadZip);
  $('#delacct').onclick = openDeleteAccount;
}

async function downloadZip() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  const certs = sortedCerts();
  const files = await Store.listAllFiles(certs, label);
  const zip = new JSZip();
  const used = new Set();
  for (const item of files) {
    let p = item.zipPath;
    for (let i = 2; used.has(p); i++) p = item.zipPath.replace(/(\.[^./]+)?$/, ` (${i})$1`);
    used.add(p);
    const res = await fetch(await Store.fileUrl(item.path));
    if (!res.ok) throw new Error(`Couldn’t download ${item.zipPath}`);
    zip.file(p, await res.blob());
  }
  const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  zip.file('certifications.csv', [
    ['Certification', 'Short name', 'Number', 'Issued by', 'Issued / last renewed', 'Expires'].map(csvCell).join(','),
    ...certs.map(c => [c.name, c.abbr, c.certNumber, c.issuer, c.issuedOn, c.expiresOn].map(csvCell).join(',')),
  ].join('\n'));
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `CertKeeper-${Dates.today()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Downloaded ${files.length} file${files.length === 1 ? '' : 's'}`);
}

function openDeleteAccount() {
  openModal(`
    <h2>Delete your account?</h2>
    <p>This permanently deletes your account, all ${state.certs.length} certification${state.certs.length === 1 ? '' : 's'} and every uploaded file. It can’t be undone.</p>
    <form id="da" class="stack">
      <label>Enter your password to confirm<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn danger" id="da-ok">Delete everything</button>
      </div>
    </form>`, (m, close) => {
    $('#da', m).onsubmit = e => {
      e.preventDefault();
      busy($('#da-ok', m), async () => {
        await Store.reauth(e.target.elements.password.value);
        stopWatching();
        await Store.deleteAccount();
        close();
        toast('Your account and files were deleted.');
      });
    };
  });
}

// ---------- start ----------
window.addEventListener('hashchange', () => { if (!Store.configured) return; route(); });

if (!Store.configured) {
  renderSetupNeeded();
} else {
  Store.onAuth(async user => {
    stopWatching();
    Object.assign(state, { user, profile: null, certs: [], certsLoaded: false });
    if (state.signingUp) return; // signUp() finishes the session itself
    if (user) await loadSession();
    route();
  });
}
