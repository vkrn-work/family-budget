/* Конверты — семейный бюджет.
   Данные: data/budget.json (выгружает основной репозиторий, без адресов, счетов и имён) + data/edits.json (правки отсюда).
   Правки сохраняются в репозиторий через GitHub API токеном, который хранится только на этом устройстве. */
(function () {
'use strict';

const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = v => nf.format(Math.round(v));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = a => a.reduce((x, y) => x + y, 0);
const MON = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const mName = m => cap(MON[+m.slice(5) - 1]) + ' ' + m.slice(0, 4);
const dimOf = m => new Date(+m.slice(0, 4), +m.slice(5), 0).getDate();
const wd = (m, d) => new Date(+m.slice(0, 4), +m.slice(5) - 1, d).getDay();
const plural = (n, f) => { n = Math.abs(Math.round(n)) % 100; const d = n % 10; return n > 10 && n < 20 ? f[2] : d === 1 ? f[0] : d >= 2 && d <= 4 ? f[1] : f[2]; };
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const store = {
  get(k, d) { try { const v = localStorage.getItem('fb.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fb.' + k, JSON.stringify(v)); } catch (e) { /* хранилище недоступно — работаем в памяти */ } }
};

// ---------- состояние ----------
let D = null, BASE = [], REMOTE = [], ENVS = [], EXTRA = [], SUB = {}, ENVBY = {};
let PENDING = store.get('pending', []);
let TOKEN = store.get('token', '');
let WHO = store.get('who', 'я');
let fromLink = false;
(function readLink() {  // ссылка вида …/#t=<токен>&who=жена настраивает устройство одним нажатием
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('t')) { TOKEN = h.get('t'); store.set('token', TOKEN); fromLink = true; }
  if (h.get('who') === 'жена' || h.get('who') === 'я') { WHO = h.get('who'); store.set('who', WHO); }
  if (h.get('t') || h.get('who')) history.replaceState(null, '', location.pathname + location.search);
})();
const S = { view: store.get('view', 'env'), month: null, f: { env: '', who: '', fr: '', when: '', src: '', nat: '' }, q: '', sub: '' };
let syncState = 'idle', syncMsg = '', flushTimer = null;

// ---------- загрузка ----------
async function loadRemoteEdits() {
  const repo = D.repo;
  if (repo) {
    try {
      const h = { Accept: 'application/vnd.github+json' };
      if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
      const r = await fetch('https://api.github.com/repos/' + repo + '/contents/data/edits.json?ref=main&t=' + Date.now(), { headers: h, cache: 'no-store' });
      if (r.ok) { const j = await r.json(); return JSON.parse(b64dec(j.content)); }
    } catch (e) { /* сеть или лимит — ниже запасной путь */ }
  }
  try { return await fetch('data/edits.json?v=' + Date.now(), { cache: 'no-store' }).then(r => r.json()); } catch (e) { return []; }
}
async function load() {
  D = await fetch('data/budget.json?v=' + Date.now(), { cache: 'no-store' }).then(r => r.json());
  BASE = D.tx.map(row => Object.fromEntries(D.fields.map((f, i) => [f, row[i]])));
  ENVS = D.envelopes; EXTRA = D.extra;
  ENVS.concat(EXTRA).forEach(e => { ENVBY[e.id] = e; (e.subs || []).forEach(s => { SUB[s.id] = Object.assign({ env: e.id }, s); }); });
  REMOTE = await loadRemoteEdits();
  // правки, которые уже попали в репозиторий, из очереди убираем
  const seen = new Set(REMOTE.map(e => e.uid));
  PENDING = PENDING.filter(e => !seen.has(e.uid)); store.set('pending', PENDING);
  const months = monthsList();
  S.month = store.get('month', null);
  if (!months.includes(S.month)) S.month = months[months.length - 1];
  setSync(PENDING.length ? (TOKEN ? 'pending' : 'local') : 'ok');
  if (PENDING.length && TOKEN) scheduleFlush();
  render();
  if (fromLink) toast('Устройство настроено: траты будут сохраняться' + (WHO === 'жена' ? ' и подписываться «Жена»' : ''));
}

// ---------- данные с правками ----------
function applyEdit(map, ev) {
  if (ev.op === 'add') {
    const s = SUB[ev.sub] || SUB.r_other;
    map.set(ev.id, { id: ev.id, date: ev.date, time: '', amount: +ev.amount, env: ev.who === 'жена' ? 'wifeside' : s.env, sub: s.id, label: ev.label || s.name, note: ev.note || '',
      who: ev.who || 'я', joint: ev.joint ? 1 : 0, source: 'вручную', nature: 'unknown', added: true });
  } else if (ev.op === 'assign') {
    const t = map.get(ev.id), s = SUB[ev.sub];
    if (t && s) { t.sub = s.id; t.env = t.who === 'жена' ? 'wifeside' : s.env; t.edited = true; }
  } else if (ev.op === 'del') {
    const t = map.get(ev.id);
    if (t && t.source !== 'карта') t.deleted = true;
  }
}
let _txCache = null;
function allTx() {
  if (_txCache) return _txCache;
  const map = new Map(BASE.map(t => [t.id, Object.assign({}, t)]));
  REMOTE.concat(PENDING).forEach(ev => applyEdit(map, ev));
  _txCache = [...map.values()].filter(t => !t.deleted).map(t => Object.assign(t, { month: t.date.slice(0, 7), day: +t.date.slice(8) }));
  return _txCache;
}
const invalidate = () => { _txCache = null; };

function monthsList() {
  const ms = D.months.slice();
  const first = BASE.filter(t => t.date.slice(0, 7) === ms[0]).map(t => t.date).sort()[0];
  if (ms.length > 1 && first && +first.slice(8) > 1) ms.shift();  // первый месяц выписки неполный
  return ms;
}
const throughDay = m => { const tm = D.through.slice(0, 7); return m < tm ? dimOf(m) : m === tm ? +D.through.slice(8) : 0; };
function units(m, per, upto) {
  let n = 0;
  for (let d = 1; d <= upto; d++) { const w = wd(m, d); if (per === 'workday' ? (w >= 1 && w <= 5) : per === 'weekend' ? (w === 0 || w === 6) : true) n++; }
  return n;
}
const whenOf = t => { const w = new Date(t.date + 'T12:00:00').getDay(); if (w === 0 || w === 6) return 'выходные'; if (t.time && +t.time.slice(0, 2) >= 9 && +t.time.slice(0, 2) < 18) return 'работа'; return 'будни'; };
const forOf = t => t.joint ? 'семья' : t.env === 'me' || t.env === 'work' ? 'я' : t.env === 'wife' ? 'жена' : t.env === 'kids' ? 'дети' : t.who === 'жена' ? 'жена' : 'семья';
const isEnv = id => !!ENVBY[id] && ENVBY[id].limit != null;
const OUTSIDE = new Set(['savings', 'review']);

// ---------- конверты: план, факт, тренд ----------
function monthStat(m) {
  const tx = allTx(), start = D.envelopes_start;
  const moves = {}; (D.moves || []).forEach(mv => { moves[mv.month + '|' + mv.id] = mv.amount; });
  const spentIn = mm => { const s = {}; tx.forEach(t => { if (t.month === mm && t.env !== 'wifeside') s[t.env] = (s[t.env] || 0) + t.amount; }); return s; };
  const limits = sum(ENVS.map(e => e.limit));
  if (m < start) {
    const sp = spentIn(m);
    return { pre: true, rows: ENVS.map(e => ({ e, carry: 0, plan: e.limit, fact: sp[e.id] || 0 })), outside: (sp.savings || 0) + (sp.review || 0), income: D.income[m] || 0, limits };
  }
  const carry = Object.fromEntries(ENVS.map(e => [e.id, 0]));
  let bank = D.bank_start.amount, res = null;
  monthsList().filter(mm => mm >= start && mm <= m).forEach(mm => {
    const sp = spentIn(mm);
    const rows = ENVS.map(e => ({ e, carry: carry[e.id], plan: carry[e.id] + e.limit, fact: sp[e.id] || 0 }));
    let moved = 0;
    rows.forEach(o => {
      const left = o.plan - o.fact;
      let mv = moves[mm + '|' + o.e.id] || 0; mv = mv === 'all' ? Math.max(left, 0) : Math.min(mv, Math.max(left, 0));
      carry[o.e.id] = left - mv; moved += mv;
    });
    const outside = (sp.savings || 0) + (sp.review || 0), income = D.income[mm] || 0;
    const bankStart = bank; bank = bank + income - limits - outside + moved;
    if (mm === m) res = { pre: false, rows, outside, income, limits, bankStart, bankEnd: bank, moved };
  });
  return res;
}
function withTrend(m, rows) {
  const dim = dimOf(m), thr = throughDay(m), done = thr >= dim;
  rows.forEach(o => {
    const e = o.e;
    if (done) o.trend = o.fact;
    else if (e.trend === 'pace') { const el = units(m, e.per || 'day', thr), tot = units(m, e.per || 'day', dim); o.trend = el > 0 ? o.fact / el * tot : Math.max(o.fact, o.plan); }
    else if (e.trend === 'plan') o.trend = Math.max(o.fact, o.plan);
    else o.trend = o.fact;
    o.left = o.plan - o.fact;
    const canSave = done || e.trend === 'pace';
    o.st = o.fact > o.plan + 0.005 ? 'over' : o.trend > o.plan * 1.02 + 0.5 ? 'risk' : canSave && o.trend < o.plan * 0.85 ? 'save' : 'ok';
    const unitsLeft = done ? 0 : units(m, e.per || 'day', dim) - units(m, e.per || 'day', thr);
    o.perUnit = !done && e.per && unitsLeft > 0 && o.left > 0 ? o.left / unitsLeft : null;
    o.unitsLeft = unitsLeft;
    o.norm = done ? 1 : (units(m, e.per || 'day', thr) / Math.max(units(m, e.per || 'day', dim), 1));
  });
  return rows;
}
const ST = { over: ['▲', 'Перерасход'], risk: ['↗', 'Выйдет за план'], ok: ['●', 'В плане'], save: ['✓', 'Экономия'] };
const stPill = s => '<span class="st ' + s + '"><i aria-hidden="true">' + ST[s][0] + '</i>' + ST[s][1] + '</span>';
const PER_W = { day: 'в день', workday: 'на рабочий день', weekend: 'на выходной день' };

// ---------- отрисовка ----------
function render() {
  invalidate();
  const months = monthsList(), i = months.indexOf(S.month);
  $('mLabel').textContent = mName(S.month);
  $('mPrev').disabled = i <= 0; $('mNext').disabled = i >= months.length - 1;
  document.querySelectorAll('#views button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + S.view));
  if (S.view === 'env') renderEnv();
  if (S.view === 'ana') renderAna();
  if (S.view === 'ops') renderOps();
}

function renderEnv() {
  const m = S.month, st = monthStat(m), rows = withTrend(m, st.rows);
  const dim = dimOf(m), thr = throughDay(m), left = dim - thr;
  const plan = sum(rows.map(o => o.plan)), fact = sum(rows.map(o => o.fact)), trend = sum(rows.map(o => o.trend));
  $('heroTitle').textContent = mName(m);
  $('heroSub').innerHTML = st.pre ? 'До конвертов: траты сравниваются с нынешними лимитами' : left > 0 ? 'Учтено по ' + thr + ' ' + MONG[+m.slice(5) - 1] + ' · впереди ' + left + ' ' + plural(left, ['день', 'дня', 'дней']) : 'Месяц закрыт';
  $('mpFill').style.width = Math.round(thr / dim * 100) + '%';
  $('mpText').textContent = Math.round(thr / dim * 100) + '% месяца';
  const d = trend - plan;
  const pct = plan ? Math.round(fact / plan * 100) : 0;
  $('pft').innerHTML = [
    ['План месяца', money(plan), 'лимиты ' + money(st.limits) + (plan !== st.limits ? ' · перенос ' + (plan - st.limits > 0 ? '+' : '') + money(plan - st.limits) : '')],
    ['Факт', money(fact), pct + '% плана за ' + Math.round(thr / dim * 100) + '% месяца'],
    ['Тренд', money(trend), left > 0 ? '<span class="delta ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '▲ +' : '✓ −') + money(Math.abs(d)) + '</span> ' + (d > 0 ? 'выше плана' : 'ниже плана') : 'итог месяца'],
  ].map(c => '<div class="pft-c"><div class="pft-l">' + c[0] + '</div><div class="pft-v num">' + c[1] + '<small>' + D.currency + '</small></div><div class="pft-s">' + c[2] + '</div></div>').join('');
  const save = st.income - trend - st.outside;
  const goal = (D.goals || {}).save_per_month || 0;
  $('heroFoot').innerHTML = [
    'Из накоплений: <b class="num">' + money(st.outside) + '</b>',
    (() => { const w = sum(allTx().filter(t => t.month === m && t.env === 'wifeside').map(t => t.amount)); return w ? 'Траты жены: <b class="num">' + money(w) + '</b>' : ''; })(),
    'Отложится за месяц по тренду: <b class="num">' + money(save) + '</b>' + (goal ? ' из цели ' + money(goal) : ''),
    st.pre ? '' : 'Банк к концу месяца ≈ <b class="num">' + money(st.bankStart + st.income - trend - st.outside) + '</b>',
  ].filter(Boolean).map(x => '<span>' + x + '</span>').join('');

  // поднос
  const tray = allTx().filter(t => t.month === m && t.env === 'review').sort((a, b) => (a.date < b.date ? 1 : -1));
  $('trayChips').innerHTML = tray.length ? tray.map(chipHTML).join('') : '';
  $('tray').classList.toggle('empty', !tray.length);
  $('trayHint').textContent = tray.length ? 'Перетащи трату в конверт или нажми на неё' : 'Всё разложено по конвертам ✓ Новые траты — кнопкой «＋ Трата»';

  // конверты
  const order = { over: 0, risk: 1, ok: 2, save: 3 };
  const cards = rows.slice().sort((a, b) => order[a.st] - order[b.st] || (b.fact / Math.max(b.plan, 1)) - (a.fact / Math.max(a.plan, 1)));
  const subsIn = id => { const s = {}; allTx().forEach(t => { if (t.month === m && t.env === id) s[t.sub] = (s[t.sub] || 0) + t.amount; }); return Object.entries(s).sort((a, b) => b[1] - a[1]); };
  let html = cards.map(o => {
    const e = o.e, mx = Math.max(o.plan, o.trend, o.fact, 1), subs = subsIn(e.id).slice(0, 3);
    const per = o.perUnit == null ? '' : o.perUnit < 1 ? 'почти всё потрачено' : '≈ ' + money(o.perUnit) + ' ' + PER_W[e.per];
    return '<button class="env glass ' + o.st + '" data-drop="' + e.id + '" data-open="' + e.id + '" aria-label="' + esc(e.letter + ' ' + e.name + ': осталось ' + money(o.left) + ' ' + D.currency + ', ' + ST[o.st][1]) + '">' +
      '<div class="env-flap"></div><div class="env-in">' +
      '<div class="env-h"><span class="env-l">' + esc(e.letter) + '</span><span class="env-n">' + esc(e.name) + '</span>' + stPill(o.st) + '</div>' +
      '<div class="env-left"><b class="num">' + money(o.left) + '<small>осталось</small></b><span class="sub">' + esc(per) + '</span></div>' +
      '<div class="bul' + (o.st === 'over' ? ' over' : '') + '"><div class="tr" style="width:' + Math.min(100, o.trend / mx * 100) + '%"></div><div class="fa" style="width:' + Math.min(100, o.fact / mx * 100) + '%"></div>' +
      (o.norm < 1 && e.per ? '<div class="nw" style="left:calc(' + (o.plan * o.norm / mx * 100) + '% - 1px)"></div>' : '') + '<div class="pl" style="left:calc(' + (Math.max(o.plan, 0) / mx * 100) + '% - 1px)"></div></div>' +
      '<div class="env-nums"><span>факт<b class="num">' + money(o.fact) + '</b></span><span>план<b class="num">' + money(o.plan) + '</b></span><span>тренд<b class="num">' + money(o.trend) + '</b></span></div>' +
      (subs.length ? '<ul class="env-subs">' + subs.map(([s, v]) => '<li><span>' + esc((SUB[s] || {}).name || s) + '</span><span class="num">' + money(v) + '</span></li>').join('') + '</ul>' : '<div class="env-hint">' + esc(e.hint || '') + '</div>') +
      '</div></button>';
  }).join('');
  const sv = ENVBY.savings, svs = subsIn('savings');
  html += '<button class="env glass saving" data-drop="savings" data-open="savings" aria-label="Из накоплений"><div class="env-flap"></div><div class="env-in">' +
    '<div class="env-h"><span class="env-l">' + esc(sv.letter) + '</span><span class="env-n">' + esc(sv.name) + '</span><span class="st ok"><i aria-hidden="true">○</i>без лимита</span></div>' +
    '<div class="env-left"><b class="num">' + money(st.outside) + '<small>за ' + MON[+m.slice(5) - 1] + '</small></b><span class="sub">' + esc(sv.hint) + '</span></div>' +
    (svs.length ? '<ul class="env-subs">' + svs.map(([s, v]) => '<li><span>' + esc((SUB[s] || {}).name || s) + '</span><span class="num">' + money(v) + '</span></li>').join('') + '</ul>' : '') + '</div></button>';
  const wifeTx = allTx().filter(t => t.month === m && t.env === 'wifeside');
  if (wifeTx.length) {
    const ws = {}; wifeTx.forEach(t => { const k = (SUB[t.sub] || {}).name || 'Прочее'; ws[k] = (ws[k] || 0) + t.amount; });
    html += '<button class="env glass saving" data-open="wifeside" aria-label="Траты жены"><div class="env-flap"></div><div class="env-in">' +
      '<div class="env-h"><span class="env-l">Ж</span><span class="env-n">Траты жены</span><span class="st ok"><i aria-hidden="true">○</i>из её денег</span></div>' +
      '<div class="env-left"><b class="num">' + money(sum(wifeTx.map(t => t.amount))) + '<small>за ' + MON[+m.slice(5) - 1] + ' · ' + wifeTx.length + ' опер.</small></b><span class="sub">не уменьшают конверты из твоей зарплаты</span></div>' +
      '<ul class="env-subs">' + Object.entries(ws).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => '<li><span>' + esc(k) + '</span><span class="num">' + money(v) + '</span></li>').join('') + '</ul></div></button>';
  }
  $('envGrid').innerHTML = html;
}
const chipHTML = t => '<div class="chip' + (t.added ? ' new' : '') + '" role="button" tabindex="0" data-drag="' + esc(t.id) + '" aria-label="' + esc(t.label + ', ' + nf2.format(t.amount) + ' ' + D.currency + ' — выбрать конверт') + '"><b class="num">' + nf2.format(t.amount) + '</b><span>' + esc(t.label) + '</span><em>' + t.date.slice(8) + '.' + t.date.slice(5, 7) + (t.note ? ' · ' + esc(t.note) : '') + '</em></div>';

// ---------- фильтры ----------
const FDEF = [
  ['who', 'Кто платил', [['', 'Все'], ['я', 'Я'], ['жена', 'Жена']]],
  ['fr', 'Для кого', [['', 'Все'], ['я', 'Я'], ['жена', 'Жена'], ['дети', 'Дети'], ['семья', 'Семья']]],
  ['when', 'Когда', [['', 'Все'], ['работа', 'Будни 9–18'], ['будни', 'Будни'], ['выходные', 'Выходные']]],
  ['src', 'Источник', [['', 'Все'], ['карта', 'Карта'], ['вручную', 'Вручную'], ['таблица', 'Таблица']]],
];
function filtersHTML() {
  const envOpts = [['', 'Все конверты']].concat(ENVS.map(e => [e.id, e.letter + ' · ' + e.name])).concat([['savings', 'Из накоплений'], ['review', 'Разобрать']]);
  const nat = Object.entries(D.natures || {}).filter(([k]) => allTx().some(t => t.nature === k));
  let h = '<div class="f-grp"><span class="f-l">Конверт</span><select class="fchip" id="fEnv" aria-label="Конверт">' + envOpts.map(([v, l]) => '<option value="' + v + '"' + (S.f.env === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>';
  h += FDEF.map(([k, l, opts]) => '<div class="f-grp" role="group" aria-label="' + l + '"><span class="f-l">' + l + '</span>' + opts.map(([v, t]) => '<button class="fchip" data-f="' + k + '" data-v="' + v + '" aria-pressed="' + (S.f[k] === v) + '">' + t + '</button>').join('') + '</div>').join('');
  h += '<div class="f-grp"><span class="f-l">Природа</span><select class="fchip" id="fNat" aria-label="Природа трат"><option value="">Все</option>' + nat.map(([k, n]) => '<option value="' + k + '"' + (S.f.nat === k ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select></div>';
  if (S.sub) h += '<div class="f-grp"><button class="fchip" aria-pressed="true" data-clear-sub>' + esc((SUB[S.sub] || {}).name || S.sub) + ' ✕</button></div>';
  const n = Object.values(S.f).filter(Boolean).length + (S.sub ? 1 : 0);
  if (n) h += '<button class="f-reset" data-reset>Сбросить</button>';
  return '<button class="f-toggle" data-ftoggle aria-expanded="' + !!S.fOpen + '">Фильтры' + (n ? ' · ' + n : '') + '<span aria-hidden="true">▾</span></button><div class="f-body">' + h + '</div>';
}
function bindFilters(root) {
  root.classList.toggle('open', !!S.fOpen);
  const tg = root.querySelector('[data-ftoggle]'); if (tg) tg.onclick = () => { S.fOpen = !S.fOpen; root.classList.toggle('open', S.fOpen); tg.setAttribute('aria-expanded', String(S.fOpen)); };
  root.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.f[b.dataset.f] = b.dataset.v; render(); });
  const fe = root.querySelector('#fEnv'); if (fe) fe.onchange = () => { S.f.env = fe.value; render(); };
  const fn = root.querySelector('#fNat'); if (fn) fn.onchange = () => { S.f.nat = fn.value; render(); };
  const r = root.querySelector('[data-reset]'); if (r) r.onclick = () => { S.f = { env: '', who: '', fr: '', when: '', src: '', nat: '' }; S.sub = ''; render(); };
  const cs = root.querySelector('[data-clear-sub]'); if (cs) cs.onclick = () => { S.sub = ''; render(); };
}
function pass(t, skipEnv) {
  const f = S.f;
  if (!skipEnv && f.env && t.env !== f.env) return false;
  if (f.who && t.who !== f.who) return false;
  if (f.fr && forOf(t) !== f.fr) return false;
  if (f.when && whenOf(t) !== f.when) return false;
  if (f.src && t.source !== f.src) return false;
  if (f.nat && t.nature !== f.nat) return false;
  if (S.sub && t.sub !== S.sub) return false;
  return true;
}
const inScope = t => S.f.env ? true : isEnv(t.env);  // без выбранного конверта графики считают только конверты

// ---------- анализ ----------
const charts = {};
function chartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = '#a39b98';
  Chart.defaults.animation = false;
}
function tipOpts() { return { backgroundColor: 'rgba(30,32,42,.95)', borderColor: 'rgba(255,255,255,.12)', borderWidth: 1, padding: 10, cornerRadius: 12, titleColor: '#f4f0ee', bodyColor: '#d2cbc7', displayColors: false }; }
function renderAna() {
  $('filters').innerHTML = filtersHTML(); bindFilters($('filters'));
  const m = S.month, st = monthStat(m), rows = withTrend(m, st.rows);
  const dim = dimOf(m), thr = throughDay(m);
  // план · факт · тренд по конвертам (учитывает фильтры, кроме конверта)
  const factF = {}; allTx().forEach(t => { if (t.month === m && pass(t, true)) factF[t.env] = (factF[t.env] || 0) + t.amount; });
  const filtered = Object.entries(S.f).some(([k, v]) => k !== 'env' && v) || S.sub;
  const order = { over: 0, risk: 1, ok: 2, save: 3 };
  $('bulBadge').textContent = filtered ? 'с фильтрами: факт по выбранным тратам' : rows.filter(o => o.st === 'over').length + ' перерасход · ' + rows.filter(o => o.st === 'risk').length + ' выйдут за план';
  $('bullets').innerHTML = rows.slice().sort((a, b) => order[a.st] - order[b.st] || b.fact - a.fact).map(o => {
    const f = filtered ? (factF[o.e.id] || 0) : o.fact, tr = filtered ? f * (o.fact ? o.trend / o.fact : 1) : o.trend;
    const mx = Math.max(o.plan, tr, f, 1);
    return '<div class="brow' + (S.f.env === o.e.id ? ' sel' : '') + '" data-env="' + o.e.id + '" role="button" tabindex="0"><div class="brow-n">' + esc(o.e.letter + ' · ' + o.e.name) + '<small>' + ST[o.st][1].toLowerCase() + '</small></div>' +
      '<div class="bul' + (f > o.plan ? ' over' : '') + '"><div class="tr" style="width:' + Math.min(100, tr / mx * 100) + '%"></div><div class="fa" style="width:' + Math.min(100, f / mx * 100) + '%"></div><div class="pl" style="left:calc(' + (Math.max(o.plan, 0) / mx * 100) + '% - 1px)"></div></div>' +
      '<div class="brow-v"><b class="num">' + money(f) + '</b> / ' + money(o.plan) + ' · ' + money(tr) + '</div></div>';
  }).join('');
  $('bullets').querySelectorAll('[data-env]').forEach(el => el.onclick = () => { S.f.env = S.f.env === el.dataset.env ? '' : el.dataset.env; render(); });

  // накопленные траты по дням
  const scopeTx = allTx().filter(t => t.month === m && inScope(t) && pass(t));
  const planScope = S.f.env ? (rows.find(o => o.e.id === S.f.env) || { plan: 0 }).plan : sum(rows.map(o => o.plan));
  const trendScope = S.f.env ? (rows.find(o => o.e.id === S.f.env) || { trend: sum(scopeTx.map(t => t.amount)) }).trend : sum(rows.map(o => o.trend));
  const daily = Array(dim + 1).fill(0); scopeTx.forEach(t => { daily[t.day] += t.amount; });
  const cum = []; let acc = 0; for (let d = 1; d <= dim; d++) { acc += daily[d]; cum.push(d <= thr ? Math.round(acc) : null); }
  const factNow = acc;
  const planLine = Array.from({ length: dim }, (_, i) => Math.round(planScope * (i + 1) / dim));
  const trendLine = Array.from({ length: dim }, (_, i) => (i + 1 < thr ? null : Math.round(factNow + (trendScope - factNow) * (i + 1 - thr) / Math.max(dim - thr, 1))));
  $('burnTitle').textContent = 'Как тратим по дням' + (S.f.env ? ' · ' + ENVBY[S.f.env].name : '');
  $('burnBadge').textContent = 'факт ' + money(factNow) + ' · план ' + money(planScope);
  const labels = Array.from({ length: dim }, (_, i) => String(i + 1));
  const base = () => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: tipOpts() },
    scales: { x: { grid: { display: false }, border: { color: 'rgba(255,255,255,.1)' }, ticks: { maxTicksLimit: 10 } }, y: { grid: { color: 'rgba(255,255,255,.06)' }, border: { display: false }, ticks: { callback: v => nf.format(v) } } } });
  const o1 = base();
  o1.plugins.tooltip.callbacks = { title: it => it[0].label + ' ' + MONG[+m.slice(5) - 1], label: it => it.raw == null ? null : ' ' + it.dataset.label + ': ' + nf.format(it.raw) + ' ' + D.currency };
  draw('burn', 'burnChart', { type: 'line', data: { labels, datasets: [
    { label: 'Факт', data: cum, borderColor: '#3987e5', backgroundColor: 'rgba(57,135,229,.14)', fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .25 },
    { label: 'План', data: planLine, borderColor: '#d2cbc7', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false },
    { label: 'Тренд', data: trendLine, borderColor: '#3987e5', borderDash: [2, 4], borderWidth: 2, pointRadius: 0, fill: false, spanGaps: true }
  ] }, options: o1 });

  // по месяцам
  const months = monthsList();
  const limScope = S.f.env ? ((ENVBY[S.f.env] || {}).limit || 0) : sum(ENVS.map(e => e.limit));
  const byM = months.map(mm => Math.round(sum(allTx().filter(t => t.month === mm && inScope(t) && pass(t)).map(t => t.amount))));
  $('monBadge').textContent = S.f.env ? ENVBY[S.f.env].name : 'все конверты';
  $('monNote').textContent = 'До ' + MONG[+D.envelopes_start.slice(5) - 1] + ' ' + D.envelopes_start.slice(0, 4) + ' конвертов не было: старые месяцы сравниваются с нынешним планом. ' + (throughDay(months[months.length - 1]) < dimOf(months[months.length - 1]) ? 'Последний месяц ещё идёт.' : '') + ' Нажми на столбец, чтобы открыть месяц.';
  const o2 = base();
  o2.interaction = { mode: 'index', intersect: false };
  o2.plugins.tooltip.callbacks = { label: it => ' ' + it.dataset.label + ': ' + nf.format(it.raw) + ' ' + D.currency };
  o2.onClick = (ev, els) => { if (els.length) { S.month = months[els[0].index]; store.set('month', S.month); render(); } };
  draw('mon', 'monChart', { type: 'bar', data: { labels: months.map(mm => cap(MONS[+mm.slice(5) - 1]) + (throughDay(mm) < dimOf(mm) ? '*' : '')), datasets: [
    { type: 'line', label: 'План', data: months.map(() => limScope), borderColor: '#d2cbc7', borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, order: 0 },
    { label: 'Траты', data: byM, backgroundColor: months.map(mm => mm === m ? '#3987e5' : 'rgba(57,135,229,.55)'), borderRadius: 6, maxBarThickness: 44, order: 1 }
  ] }, options: o2 });

  // подкатегории
  const bySub = {}; allTx().forEach(t => { if (t.month === m && pass(t) && (S.f.env || isEnv(t.env) || OUTSIDE.has(t.env))) { const o = bySub[t.sub] || (bySub[t.sub] = { v: 0, n: 0 }); o.v += t.amount; o.n++; } });
  const subs = Object.entries(bySub).sort((a, b) => b[1].v - a[1].v).slice(0, 14);
  const smx = subs.length ? subs[0][1].v : 1;
  $('subBadge').textContent = subs.length + ' · ' + MON[+m.slice(5) - 1];
  $('subBars').innerHTML = subs.length ? subs.map(([s, o]) => '<div class="hbar' + (S.sub === s ? ' sel' : '') + '" data-sub="' + s + '" role="button" tabindex="0" title="Показать операции"><span class="n">' + esc((SUB[s] || {}).name || s) + '<small>' + esc((ENVBY[(SUB[s] || {}).env] || {}).letter || '') + ' · ' + o.n + ' опер.</small></span><span class="b" style="width:' + (o.v / smx * 100) + '%"></span><span class="v num">' + money(o.v) + '</span></div>').join('') : '<p class="note">Нет трат с такими фильтрами.</p>';
  $('subBars').querySelectorAll('[data-sub]').forEach(el => el.onclick = () => { S.sub = el.dataset.sub; S.view = 'ops'; store.set('view', S.view); render(); });

  // места
  const pl = {}; allTx().forEach(t => { if (t.month === m && inScope(t) && pass(t)) { const o = pl[t.label] || (pl[t.label] = { v: 0, n: 0, sub: t.sub }); o.v += t.amount; o.n++; } });
  const places = Object.entries(pl).sort((a, b) => b[1].v - a[1].v).slice(0, 12);
  $('placeBadge').textContent = Object.keys(pl).length + ' мест · ' + MON[+m.slice(5) - 1];
  $('places').innerHTML = '<thead><tr><th>Место</th><th>Подкатегория</th><th class="r">Раз</th><th class="r">Средний чек</th><th class="r">Сумма</th></tr></thead><tbody>' +
    places.map(([k, o]) => '<tr><td>' + esc(k) + '</td><td class="sub">' + esc((SUB[o.sub] || {}).name || '') + '</td><td class="r">' + o.n + '</td><td class="r">' + money(o.v / o.n) + '</td><td class="r"><b>' + money(o.v) + '</b></td></tr>').join('') + '</tbody>';
}
function draw(key, id, cfg) {
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart($(id), cfg);
}

// ---------- операции ----------
function renderOps() {
  $('filters2').innerHTML = filtersHTML(); bindFilters($('filters2'));
  const q = S.q.trim().toLowerCase();
  const tx = allTx().filter(t => t.month === S.month && pass(t) && (!q || (t.label + ' ' + t.note + ' ' + ((SUB[t.sub] || {}).name || '')).toLowerCase().includes(q)))
    .sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  const days = {}; tx.forEach(t => { (days[t.date] = days[t.date] || []).push(t); });
  $('opsList').innerHTML = Object.keys(days).length ? Object.entries(days).map(([d, ts]) => '<div class="day-h"><span>' + (+d.slice(8)) + ' ' + MONG[+d.slice(5, 7) - 1] + '</span><span class="num">' + money(sum(ts.map(t => t.amount))) + '</span></div>' +
    ts.map(t => { const e = ENVBY[t.env] || {}, s = SUB[t.sub] || {};
      return '<div class="op"><div class="op-t"><b>' + esc(t.label) + (t.source !== 'карта' ? '<span class="tag">' + esc(t.source) + '</span>' : '') + (t.joint ? '<span class="tag">вместе</span>' : '') + (t.who === 'жена' ? '<span class="tag">жена</span>' : '') + '</b><span>' + esc(s.name || '') + (t.note ? ' · ' + esc(t.note) : '') + (t.time ? ' · ' + t.time : '') + '</span></div>' +
        '<button class="op-env" data-assign="' + esc(t.id) + '" aria-label="Сменить конверт">' + esc((e.letter ? e.letter + ' · ' : '') + (e.name || '')) + '</button><div class="op-a num">' + nf2.format(t.amount) + '</div></div>'; }).join('')).join('') : '<p class="note center" style="padding:24px">Нет операций с такими фильтрами.</p>';
  $('opsFoot').textContent = tx.length + ' ' + plural(tx.length, ['операция', 'операции', 'операций']) + ' · ' + nf2.format(sum(tx.map(t => t.amount))) + ' ' + D.currency;
}

// ---------- правки и сохранение ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function pushEdit(ev) {
  ev.uid = uid(); ev.t = new Date().toISOString(); ev.by = WHO;
  PENDING.push(ev); store.set('pending', PENDING);
  setSync(TOKEN ? 'pending' : 'local');
  if (TOKEN) scheduleFlush();
  render();
  return ev;
}
function undoEdit(ev) {
  const i = PENDING.findIndex(e => e.uid === ev.uid);
  if (i >= 0) { PENDING.splice(i, 1); store.set('pending', PENDING); setSync(PENDING.length ? (TOKEN ? 'pending' : 'local') : 'ok'); render(); return; }
  if (ev.op === 'assign' && ev.prev) pushEdit({ op: 'assign', id: ev.id, sub: ev.prev });
  if (ev.op === 'add') pushEdit({ op: 'del', id: ev.id });
}
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s) { return decodeURIComponent(escape(atob(s.replace(/\n/g, '')))); }
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1200); }
async function gh(path, opts) {
  return fetch('https://api.github.com/repos/' + D.repo + '/' + path, Object.assign({ headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, cache: 'no-store' }, opts || {}));
}
async function flush() {
  if (!TOKEN || !PENDING.length) return;
  setSync('saving');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await gh('contents/data/edits.json?ref=main&t=' + Date.now());
      let sha, remote = [];
      if (r.ok) { const j = await r.json(); sha = j.sha; remote = JSON.parse(b64dec(j.content)); }
      else if (r.status !== 404) throw new Error('GitHub ответил ' + r.status);
      const seen = new Set(remote.map(e => e.uid));
      const merged = remote.concat(PENDING.filter(e => !seen.has(e.uid)));
      const body = { message: 'Конверты: ' + PENDING.length + ' ' + plural(PENDING.length, ['правка', 'правки', 'правок']) + ' (' + WHO + ')', content: b64enc(JSON.stringify(merged, null, 1) + '\n'), branch: 'main' };
      if (sha) body.sha = sha;
      const p = await gh('contents/data/edits.json', { method: 'PUT', body: JSON.stringify(body) });
      if (p.ok) { REMOTE = merged; PENDING = []; store.set('pending', PENDING); setSync('ok'); render(); return; }
      if (p.status === 409 || p.status === 422) continue;
      if (p.status === 401 || p.status === 403) throw new Error('токен не подходит (нет доступа на запись)');
      throw new Error('GitHub ответил ' + p.status);
    } catch (e) { syncMsg = e.message; setSync('err'); return; }
  }
  syncMsg = 'не удалось сохранить, попробуй ещё раз'; setSync('err');
}
function setSync(s) {
  syncState = s;
  const b = $('syncBtn'); b.className = 'sync ' + ({ ok: 'ok', pending: 'pending', saving: 'pending', local: 'pending', err: 'err' }[s] || '');
  $('syncT').textContent = { ok: 'Сохранено', pending: 'Сохраняю…', saving: 'Сохраняю…', local: PENDING.length + ' не сохранено', err: 'Ошибка', idle: '…' }[s] || '';
}

// ---------- лист ----------
let sheetClose = null;
function openSheet(title, html, bind) {
  $('sheetT').textContent = title; $('sheetB').innerHTML = html;
  $('sheet').hidden = false; $('scrim').hidden = false;
  $('toast').hidden = true;
  if (bind) bind($('sheetB'));
  $('sheet').scrollTop = 0;
  const f = $('sheetB').querySelector('input') || $('sheetX'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
}
function closeSheet() { $('sheet').hidden = true; $('scrim').hidden = true; if (sheetClose) { sheetClose(); sheetClose = null; } }
$('sheetX').onclick = closeSheet; $('scrim').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

function envPicker(selEnv) {
  const all = ENVS.concat([ENVBY.savings, ENVBY.review]);
  return '<div class="grp"><div class="grp-l">Конверт</div><div class="pick" data-envs>' + all.map(e => '<button data-pe="' + e.id + '" aria-pressed="' + (selEnv === e.id) + '">' + esc(e.letter + ' · ' + e.name) + '<small>' + (e.limit != null ? 'лимит ' + money(e.limit) : 'без лимита') + '</small></button>').join('') + '</div></div><div class="grp" data-subs></div>';
}
function subPicker(root, envId, selSub, onPick) {
  const e = ENVBY[envId]; if (!e) return;
  root.querySelector('[data-subs]').innerHTML = '<div class="grp-l">Подкатегория</div><div class="pick">' + (e.subs || []).map(s => '<button data-ps="' + s.id + '" aria-pressed="' + (selSub === s.id) + '">' + esc(s.name) + '</button>').join('') + '</div>';
  root.querySelectorAll('[data-ps]').forEach(b => b.onclick = () => onPick(b.dataset.ps));
}
function defaultSub(t, envId) {
  const e = ENVBY[envId], cur = SUB[t.sub];
  if (cur && cur.env === envId) return cur.id;
  const same = (e.subs || []).find(s => cur && s.cat === cur.cat);
  return (same || (e.subs || [])[0] || {}).id;
}
function assignSheet(id) {
  const t = allTx().find(x => x.id === id); if (!t) return;
  openSheet(t.label + ' · ' + nf2.format(t.amount) + ' ' + D.currency, '<p class="sub" style="margin-bottom:12px">' + t.date.slice(8) + '.' + t.date.slice(5, 7) + ' · сейчас: ' + esc(((ENVBY[t.env] || {}).name || '') + ' / ' + ((SUB[t.sub] || {}).name || '')) + '</p>' + envPicker(t.env) +
    (t.source !== 'карта' ? '<button class="btn block" data-del style="margin-top:6px">Удалить эту трату</button>' : ''), root => {
    const pick = sub => { const prev = t.sub; closeSheet(); if (sub === prev) return; const ev = pushEdit({ op: 'assign', id: t.id, sub, prev }); toastAssigned(t, ev); };
    const showSubs = envId => { root.querySelectorAll('[data-pe]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pe === envId))); subPicker(root, envId, t.env === envId ? t.sub : null, pick); };
    root.querySelectorAll('[data-pe]').forEach(b => b.onclick = () => { showSubs(b.dataset.pe); root.querySelector('[data-subs]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    showSubs(t.env);
    const del = root.querySelector('[data-del]'); if (del) del.onclick = () => { closeSheet(); const ev = pushEdit({ op: 'del', id: t.id }); toast('Трата удалена', () => undoEdit(ev)); };
  });
}
function envSheet(envId) {
  const m = S.month, e = ENVBY[envId];
  const tx = allTx().filter(t => t.month === m && t.env === envId).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  const bySub = {}; tx.forEach(t => { bySub[t.sub] = (bySub[t.sub] || 0) + t.amount; });
  const subs = Object.entries(bySub).sort((a, b) => b[1] - a[1]); const mx = subs.length ? subs[0][1] : 1;
  openSheet(e.letter + ' · ' + e.name + ' — ' + MON[+m.slice(5) - 1], (e.hint ? '<p class="sub" style="margin-bottom:12px">' + esc(e.hint) + '</p>' : '') +
    (subs.length ? '<div class="grp"><div class="grp-l">Подкатегории</div>' + subs.map(([s, v]) => '<div class="hbar"><span class="n">' + esc((SUB[s] || {}).name || s) + '</span><span class="b" style="width:' + (v / mx * 100) + '%"></span><span class="v num">' + money(v) + '</span></div>').join('') + '</div>' : '<p class="note">В этом месяце трат нет.</p>') +
    (tx.length ? '<div class="grp"><div class="grp-l">Операции · нажми, чтобы переложить</div>' + tx.map(t => '<div class="op" style="padding:8px 4px"><div class="op-t"><b>' + esc(t.label) + '</b><span>' + t.date.slice(8) + '.' + t.date.slice(5, 7) + ' · ' + esc((SUB[t.sub] || {}).name || '') + '</span></div><button class="op-env" data-assign="' + esc(t.id) + '">Переложить</button><div class="op-a num">' + nf2.format(t.amount) + '</div></div>').join('') + '</div>' : ''), root => {
    root.querySelectorAll('[data-assign]').forEach(b => b.onclick = () => { const id = b.dataset.assign; closeSheet(); setTimeout(() => assignSheet(id), 60); });
  });
}
function addSheet(preEnv) {
  let who = WHO, joint = false, env = preEnv || '', sub = '';
  const today = todayISO();
  const date = today.slice(0, 7) <= monthsList().slice(-1)[0] ? today : S.month + '-01';
  openSheet('Новая трата', '<div class="field big-amount"><label for="aAmt">Сумма, ' + D.currency + '</label><input id="aAmt" inputmode="decimal" placeholder="0,00" autocomplete="off"></div>' +
    '<div class="field"><label for="aLbl">Что купили</label><input id="aLbl" placeholder="Например: Евроопт, обед, футбол" maxlength="60" autocomplete="off"></div>' +
    '<div class="row2"><div class="field"><label for="aDate">Дата</label><input id="aDate" type="date" value="' + date + '"></div>' +
    '<div class="field"><label>Кто платил</label><div class="toggle" data-who><button data-v="я" aria-pressed="' + (who === 'я') + '">Я</button><button data-v="жена" aria-pressed="' + (who === 'жена') + '">Жена</button></div></div></div>' +
    '<p class="note" data-whonote style="margin:-6px 0 12px"></p><div class="field"><label>Вместе с семьёй?</label><div class="toggle" data-joint><button data-v="0" aria-pressed="true">Нет</button><button data-v="1" aria-pressed="false">Да, вместе</button></div></div>' +
    envPicker(env) + '<p class="note" style="margin:-4px 0 12px">Конверт можно не выбирать: трата попадёт в «Неразобранное», и её можно будет перетащить.</p>' +
    '<button class="btn primary block" data-add>Добавить</button>', root => {
    const tog = (sel, cb) => root.querySelectorAll(sel + ' button').forEach(b => b.onclick = () => { root.querySelectorAll(sel + ' button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); cb(b.dataset.v); });
    const whoNote = () => { root.querySelector('[data-whonote]').textContent = who === 'жена' ? 'Траты жены из её денег (пособие) идут отдельно и не уменьшают конверты. Конверт выбери, чтобы было видно, на что: продукты, дети и т. д.' : ''; };
    tog('[data-who]', v => { who = v; whoNote(); }); tog('[data-joint]', v => { joint = v === '1'; }); whoNote();
    const showSubs = id => { env = id; root.querySelectorAll('[data-pe]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pe === id))); sub = (ENVBY[id].subs || [])[0].id; subPicker(root, id, sub, s => { sub = s; root.querySelectorAll('[data-ps]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ps === s))); }); };
    root.querySelectorAll('[data-pe]').forEach(b => b.onclick = () => { showSubs(b.dataset.pe); root.querySelector('[data-subs]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    if (env) showSubs(env);
    root.querySelector('[data-add]').onclick = () => {
      const amt = parseFloat(String($('aAmt').value).replace(/\s/g, '').replace(',', '.'));
      if (!(amt > 0)) { $('aAmt').focus(); $('aAmt').style.boxShadow = 'inset 0 0 0 1.5px var(--crit)'; return; }
      const d = $('aDate').value || date;
      const ev = pushEdit({ op: 'add', id: 'n' + uid(), date: d, amount: Math.round(amt * 100) / 100, label: $('aLbl').value.trim() || ((SUB[sub] || {}).name || 'Трата'), sub: sub || 'r_other', who, joint });
      closeSheet();
      if (d.slice(0, 7) !== S.month && monthsList().includes(d.slice(0, 7))) { S.month = d.slice(0, 7); render(); }
      toast(sub ? 'Записано в «' + ENVBY[SUB[sub].env].name + '»' : 'Трата в «Неразобранном» — перетащи её в конверт', () => undoEdit(ev));
    };
  });
}
function settingsSheet() {
  const pend = PENDING.length;
  openSheet('Сохранение', '<p class="help" style="margin-bottom:12px">' + (syncState === 'err' ? '<b style="color:var(--crit)">Ошибка: ' + esc(syncMsg) + '</b><br>' : '') +
    (pend ? 'Не сохранено правок: <b>' + pend + '</b>. ' : 'Все правки сохранены в репозитории. ') + 'Правки хранятся в <code>data/edits.json</code>; Claude переносит их в основной репозиторий и обновляет данные.</p>' +
    '<div class="field"><label>Это устройство</label><div class="toggle" data-who><button data-v="я" aria-pressed="' + (WHO === 'я') + '">Моё</button><button data-v="жена" aria-pressed="' + (WHO === 'жена') + '">Жены</button></div></div>' +
    '<div class="field"><label for="tok">Токен GitHub (хранится только на этом устройстве)</label><input id="tok" type="password" autocomplete="off" placeholder="github_pat_…" value="' + esc(TOKEN) + '"></div>' +
    '<div class="row2"><button class="btn block" data-check>Проверить и сохранить</button><button class="btn primary block" data-flush' + (pend ? '' : ' disabled') + '>Сохранить сейчас</button></div>' +
    '<p class="note" data-res></p>' +
    (TOKEN ? '<div class="field" style="margin-top:10px"><label>Ссылка, чтобы настроить телефон жены одним нажатием</label><input readonly data-link value="' + esc(location.origin + location.pathname + '#t=' + encodeURIComponent(TOKEN) + '&who=жена') + '"></div><button class="btn block" data-copy>Скопировать ссылку</button><p class="note">В ссылке токен: отправь её только жене, в личные сообщения, и потом удали сообщение. Открыть её нужно в том же браузере, где она добавляет траты: тогда сохранятся и уже внесённые.</p>' : '') +
    '<div class="help" style="margin-top:12px"><b>Как получить токен</b><ol><li>github.com → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token.</li>' +
    '<li>Repository access: <b>Only select repositories</b> → <code>' + esc(D.repo) + '</code>.</li><li>Permissions → Repository → <b>Contents: Read and write</b>. Срок — например, год.</li><li>Скопируй токен сюда. Жене — отдельный токен для её телефона.</li></ol></div>' +
    '<button class="btn block" data-reload style="margin-top:8px">Обновить данные</button>', root => {
    root.querySelectorAll('[data-who] button').forEach(b => b.onclick = () => { WHO = b.dataset.v; store.set('who', WHO); root.querySelectorAll('[data-who] button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    root.querySelector('[data-check]').onclick = async () => {
      const res = root.querySelector('[data-res]');
      TOKEN = $('tok').value.trim(); store.set('token', TOKEN);
      if (!TOKEN) { res.textContent = 'Токен удалён с этого устройства.'; setSync(PENDING.length ? 'local' : 'ok'); return; }
      res.textContent = 'Проверяю…';
      try {
        const r = await gh('');
        const j = await r.json();
        if (r.ok && j.permissions && j.permissions.push) { res.textContent = '✓ Токен работает, запись разрешена.'; if (PENDING.length) flush(); }
        else res.textContent = r.ok ? 'Токен видит репозиторий, но без права записи: включи Contents: Read and write.' : 'Токен не подходит (' + r.status + ').';
      } catch (e) { res.textContent = 'Нет связи с GitHub.'; }
    };
    root.querySelector('[data-flush]').onclick = () => { flush(); closeSheet(); };
    const cp = root.querySelector('[data-copy]');
    if (cp) cp.onclick = async () => { const inp = root.querySelector('[data-link]'); try { await navigator.clipboard.writeText(inp.value); cp.textContent = 'Скопировано ✓'; } catch (e) { inp.select(); cp.textContent = 'Выдели и скопируй вручную'; } };
    root.querySelector('[data-reload]').onclick = () => location.reload();
  });
}

// ---------- тост ----------
let toastT = null;
function toast(msg, undo, extra) {
  const t = $('toast');
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (extra ? '<button data-x>' + esc(extra[0]) + '</button>' : '') + (undo ? '<button data-u>Отменить</button>' : '');
  t.hidden = false;
  if (undo) t.querySelector('[data-u]').onclick = () => { t.hidden = true; undo(); };
  if (extra) t.querySelector('[data-x]').onclick = () => { t.hidden = true; extra[1](); };
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6000);
}
function toastAssigned(t, ev) {
  const s = SUB[ev.sub], e = ENVBY[s.env];
  toast(t.label + ' → ' + e.letter + ' · ' + e.name + ' / ' + s.name, () => undoEdit(ev), (e.subs || []).length > 1 ? ['Подкатегория', () => assignSheet(t.id)] : null);
}

// ---------- перетаскивание (мышь и палец) ----------
let drag = null;
const ghost = $('ghost');
function startDrag() {
  const t = allTx().find(x => x.id === drag.id); if (!t) { drag = null; return; }
  drag.started = true; drag.t = t;
  drag.chip.classList.add('lifted'); document.body.classList.add('dragging');
  ghost.innerHTML = '<b class="num">' + nf2.format(t.amount) + '</b>' + esc(t.label);
  ghost.style.display = 'block'; moveGhost(drag.lx, drag.ly);
  if (!scrollRAF) scrollRAF = requestAnimationFrame(autoScroll);
  if (navigator.vibrate) navigator.vibrate(12);
}
function moveGhost(x, y) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; }
// у края экрана во время перетаскивания страница прокручивается сама
let scrollRAF = null;
function autoScroll() {
  if (!drag || !drag.started) { scrollRAF = null; return; }
  const edge = 70, y = drag.ly, h = window.innerHeight;
  const v = y < edge ? -Math.ceil((edge - y) / 5) : y > h - edge ? Math.ceil((y - (h - edge)) / 5) : 0;
  if (v) {
    window.scrollBy(0, v);
    const tgt = targetAt(drag.lx, drag.ly);
    document.querySelectorAll('.drop-on').forEach(x => { if (x !== tgt) x.classList.remove('drop-on'); });
    if (tgt) tgt.classList.add('drop-on');
  }
  scrollRAF = requestAnimationFrame(autoScroll);
}
function targetAt(x, y) { ghost.style.display = 'none'; const el = document.elementFromPoint(x, y); ghost.style.display = 'block'; return el && el.closest('[data-drop]'); }
function endDrag() {
  document.querySelectorAll('.drop-on').forEach(x => x.classList.remove('drop-on'));
  if (drag && drag.chip) drag.chip.classList.remove('lifted');
  document.body.classList.remove('dragging'); ghost.style.display = 'none';
}
document.addEventListener('pointerdown', e => {
  const chip = e.target.closest('[data-drag]'); if (!chip || (e.pointerType === 'mouse' && e.button !== 0)) return;
  drag = { chip, id: chip.dataset.drag, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, started: false, touch: e.pointerType !== 'mouse' };
  if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.started) startDrag(); }, 260);
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  drag.lx = e.clientX; drag.ly = e.clientY;
  const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
  if (!drag.started) {
    if (drag.touch) { if (dist > 10) { clearTimeout(drag.timer); drag = null; } return; }
    if (dist < 6) return;
    startDrag(); if (!drag) return;
  }
  moveGhost(e.clientX, e.clientY);
  const tgt = targetAt(e.clientX, e.clientY);
  document.querySelectorAll('.drop-on').forEach(x => { if (x !== tgt) x.classList.remove('drop-on'); });
  if (tgt) tgt.classList.add('drop-on');
});
document.addEventListener('touchmove', e => { if (drag && drag.started) e.preventDefault(); }, { passive: false });
document.addEventListener('pointerup', e => {
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag;
  if (d.started) {
    const tgt = targetAt(e.clientX, e.clientY);
    endDrag(); drag = null;
    if (tgt) {
      const envId = tgt.dataset.drop, sub = defaultSub(d.t, envId);
      if (sub && sub !== d.t.sub) { const ev = pushEdit({ op: 'assign', id: d.t.id, sub, prev: d.t.sub }); toastAssigned(d.t, ev); }
    }
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
  } else { drag = null; assignSheet(d.id); }
});
document.addEventListener('pointercancel', () => { if (drag) { clearTimeout(drag.timer); endDrag(); drag = null; } });
let suppressClick = false;
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-drag]')) e.preventDefault(); });
document.addEventListener('keydown', e => { const c = e.target.closest && e.target.closest('[data-drag]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); assignSheet(c.dataset.drag); } });

// ---------- события ----------
document.addEventListener('click', e => {
  if (suppressClick) return;
  const a = e.target.closest('[data-assign]'); if (a && !a.closest('#sheet')) { assignSheet(a.dataset.assign); return; }
  const o = e.target.closest('[data-open]'); if (o) envSheet(o.dataset.open);
});
document.querySelectorAll('#views button').forEach(b => b.onclick = () => { S.view = b.dataset.view; store.set('view', S.view); render(); });
$('mPrev').onclick = () => { const ms = monthsList(), i = ms.indexOf(S.month); if (i > 0) { S.month = ms[i - 1]; store.set('month', S.month); render(); } };
$('mNext').onclick = () => { const ms = monthsList(), i = ms.indexOf(S.month); if (i < ms.length - 1) { S.month = ms[i + 1]; store.set('month', S.month); render(); } };
$('addBtn').onclick = () => addSheet('');
$('fab').onclick = () => addSheet('');
$('syncBtn').onclick = settingsSheet;
$('q').oninput = e => { S.q = e.target.value; renderOps(); };
window.addEventListener('online', () => { if (PENDING.length && TOKEN) flush(); });

chartDefaults();
load().catch(err => { document.querySelector('main').innerHTML = '<div class="card glass"><h2>Не удалось загрузить данные</h2><p class="note">' + esc(err.message) + '</p></div>'; });
})();
