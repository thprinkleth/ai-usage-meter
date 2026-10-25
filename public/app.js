import { ansiToHtml } from './ansi.js';
import { normalizeReport, prettyProject, sessionLabel, sumRows, toCSV, TOKEN_TYPES } from './data.js';
import {
	$, $$, agentLabel, barChart, barList, colorOf, copy, destroyCharts, download, esc, fmtDate, fmtDuration,
	fmtInt, fmtPct, fmtTok, fmtUSD, h, ICONS, legendHtml, registerModels, shortModel, slotOf,
} from './ui.js';

const SERVER_FLAGS = new Set(['help', 'version', 'color', 'no-color', 'json']);
const VIEW_PARAM = '_view';
const store = {
	get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
	set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = { catalog: null, timer: null, renderId: 0 };

// Model colors are scoped per agent group so one agent's models don't exhaust another's slots.
let modelKind = 'model';
const mColor = (n) => colorOf(modelKind, n);

// ---------- api ----------

async function api(path, body) {
	const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
	const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
	if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

async function runReport(command, flags = {}, { fresh = false } = {}) {
	const r = await api('/api/run', { command, flags, json: true, fresh });
	if (r.code !== 0 || !r.data) throw new Error((r.stderr || r.stdout || `ccusage exited with ${r.code}`).trim());
	return r;
}

const findCmd = (path) => state.catalog.commands.find((c) => c.path.join(' ') === path.join(' '));
const hasFlag = (cmd, name) => cmd.flags.some((f) => f.name === name);

// ---------- formatting helpers ----------

const todayKey = () => new Date().toLocaleDateString('en-CA');
function periodLabel(label) {
	if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return new Date(label + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	if (/^\d{4}-\d{2}$/.test(label)) return new Date(label + '-15T12:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
	return label;
}
const isoToYmd = (v) => (v ? v.replaceAll('-', '') : '');
const ymdToIso = (v) => (/^\d{8}$/.test(v || '') ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v || '');

// ---------- routing ----------

function parseHash() {
	const raw = location.hash.replace(/^#\/?/, '');
	const [p, q = ''] = raw.split('?');
	const parts = p.split('/').filter(Boolean);
	return { view: parts[0] || 'overview', path: parts.slice(1), params: new URLSearchParams(q) };
}

function setHash(view, path = [], params, replace = true) {
	const q = params && [...params].length ? `?${params}` : '';
	const url = `#/${[view, ...path].join('/')}${q}`;
	if (replace) history.replaceState(null, '', url);
	else location.hash = url;
}

const main = () => $('#main');

async function render() {
	const id = ++state.renderId;
	clearInterval(state.timer);
	destroyCharts(main());
	const { view, path, params } = parseHash();
	modelKind = view === 'r' && path.length > 1 ? `model:${path[0]}` : 'model';
	highlightNav();
	try {
		if (view === 'overview') await renderOverview(id);
		else if (view === 'r') await renderExplorer(path, params, id);
		else if (view === 'coverage') renderCoverage();
		else main().innerHTML = `<div class="empty">Unknown page</div>`;
	} catch (e) {
		if (id === state.renderId) main().innerHTML = `<div class="err">${esc(e.message)}</div>`;
	}
}

function highlightNav() {
	const cur = location.hash.split('?')[0] || '#/';
	const full = location.hash || '#/';
	for (const a of $$('.nav a')) {
		const href = a.getAttribute('href');
		a.classList.toggle('active', href.includes('?') ? full === href : cur === href && !(full.includes('instances=1') && href === '#/r/claude/daily'));
	}
}

// ---------- sidebar ----------

function buildSidebar() {
	const c = state.catalog;
	const otherGroups = [...new Set(c.commands.map((x) => x.group))].filter((g) => !['all', 'claude', 'codex'].includes(g));
	const link = (href, label, icon = '') => `<a href="${href}">${icon}<span>${esc(label)}</span></a>`;
	const dot = (agent) => `<i class="dot" style="background:${colorOf('agent', agent)}"></i>`;
	const sub = (group) => c.commands.filter((x) => x.group === group);
	const names = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', session: 'Sessions', blocks: '5-hour blocks', statusline: 'Statusline' };
	$('#sidebar').innerHTML = `
		<div class="brand"><div class="brand-mark">◔</div><div><b>AI Usage Meter</b><span>Claude Code · Codex</span></div></div>
		<nav class="nav">
			${link('#/', 'Overview', ICONS.overview)}
			<div class="nav-label">Claude Code</div>
			${sub('claude').filter((x) => x.name !== 'statusline' && x.name !== 'blocks').map((x) => link(`#/r/claude/${x.name}`, names[x.name] ?? x.name, dot('claude'))).join('')}
			${link('#/r/claude/daily?instances=1', 'Projects', dot('claude'))}
			${link('#/r/claude/blocks', '5-hour blocks', ICONS.clock)}
			${link('#/r/claude/statusline', 'Statusline', ICONS.term)}
			<div class="nav-label">Codex</div>
			${sub('codex').map((x) => link(`#/r/codex/${x.name}`, names[x.name] ?? x.name, dot('codex'))).join('')}
			<div class="nav-label">All agents</div>
			${sub('all').filter((x) => !['blocks', 'statusline'].includes(x.name)).map((x) => link(`#/r/${x.name}`, names[x.name] ?? x.name, ICONS.layers)).join('')}
			${otherGroups.length ? link(`#/r/${otherGroups[0]}/daily`, `Other agents (${otherGroups.length})`, ICONS.grid) : ''}
			<div class="nav-label">Reference</div>
			${link('#/coverage', 'ccusage coverage', ICONS.check)}
		</nav>
		<div class="sidebar-foot">
			<div>ccusage <b>${esc(c.version)}</b> · ${c.commands.length} commands</div>
			<button class="btn small" id="theme-btn">${ICONS.sun}<span>Theme</span></button>
		</div>`;
	$('#theme-btn').onclick = () => {
		const root = document.documentElement;
		const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
		root.dataset.theme = dark ? 'light' : 'dark';
		store.set('theme', root.dataset.theme);
		render();
	};
}

// ---------- overview ----------

async function renderOverview(id) {
	const auto = store.get('autoRefresh', true);
	main().innerHTML = `
		<div class="topbar">
			<div><h1>Overview</h1><div class="sub">Every agent ccusage detects, with Claude Code and Codex up front</div></div>
			<div class="spacer"></div>
			<label class="check"><input type="checkbox" id="auto" ${auto ? 'checked' : ''}> Auto-refresh (60s)</label>
			<button class="btn" id="refresh">${ICONS.refresh}Refresh</button>
		</div>
		<div class="grid cols-4" id="tiles"><div class="card span-all center"><span class="spinner"></span>Loading usage…</div></div>
		<div class="grid cols-3" style="margin-top:14px">
			<div class="card span-2" id="daily-card"></div>
			<div class="card block-card" id="block-card"></div>
		</div>
		<div class="grid cols-3" style="margin-top:14px">
			<div class="card" id="agents-card"></div>
			<div class="card" id="models-card"></div>
			<div class="card" id="tokens-card"></div>
		</div>
		<div class="grid cols-3" style="margin-top:14px">
			<div class="card span-2" id="monthly-card"></div>
			<div class="card" id="projects-card"></div>
		</div>
		<div class="grid" style="margin-top:14px"><div class="card" id="sessions-card"></div></div>`;
	$('#auto').onchange = (e) => { store.set('autoRefresh', e.target.checked); render(); };
	$('#refresh').onclick = () => load(true);
	if (auto) state.timer = setInterval(() => document.visibilityState === 'visible' && load(false), 60_000);

	async function load(fresh) {
		const [daily, monthly, block, sessions, claudeSessions] = await Promise.allSettled([
			runReport(['daily'], { 'by-agent': true }, { fresh }),
			runReport(['monthly'], { 'by-agent': true }, { fresh }),
			runReport(['claude', 'blocks'], { active: true }, { fresh }),
			runReport(['session'], {}, { fresh }),
			runReport(['claude', 'session'], {}, { fresh }),
		]);
		if (id !== state.renderId) return;
		destroyCharts(main());
		const fail = (sel, r) => ($(sel).innerHTML = `<div class="err">${esc(r.reason?.message ?? 'Failed')}</div>`);

		if (daily.status === 'fulfilled') {
			const rows = normalizeReport(daily.value.data).sections[0].rows;
			const mt = new Map();
			for (const r of rows) for (const m of r.models) mt.set(m.name, (mt.get(m.name) ?? 0) + (m.cost ?? 0));
			registerModels(mt);
			overviewTiles(rows);
			overviewDaily(rows);
			overviewAgents(rows);
			overviewModels(mt);
			overviewTokens(rows);
		} else ['#tiles', '#daily-card', '#agents-card', '#models-card', '#tokens-card'].forEach((s) => fail(s, daily));
		if (monthly.status === 'fulfilled') overviewMonthly(normalizeReport(monthly.value.data).sections[0].rows); else fail('#monthly-card', monthly);
		if (block.status === 'fulfilled') $('#block-card').innerHTML = activeBlockHtml(block.value.data.blocks?.find((b) => b.isActive), null, true); else fail('#block-card', block);
		if (sessions.status === 'fulfilled') overviewSessions(normalizeReport(sessions.value.data).sections[0].rows); else fail('#sessions-card', sessions);
		if (claudeSessions.status === 'fulfilled') overviewProjects(normalizeReport(claudeSessions.value.data).sections[0].rows); else fail('#projects-card', claudeSessions);
	}
	await load(false);
}

function agentSplit(rows) {
	const m = new Map();
	for (const r of rows) {
		const parts = r.agents.length ? r.agents : [{ ...r, agent: r.agentsUsed[0] ?? 'all' }];
		for (const a of parts) {
			const cur = m.get(a.agent) ?? { cost: 0, total: 0 };
			cur.cost += a.cost ?? 0; cur.total += a.total;
			m.set(a.agent, cur);
		}
	}
	return [...m].sort((a, b) => b[1].cost - a[1].cost);
}

function overviewTiles(rows) {
	const today = rows.filter((r) => r.label === todayKey());
	const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
	const week = rows.filter((r) => r.label >= weekStart.toLocaleDateString('en-CA'));
	const monthKey = todayKey().slice(0, 7);
	const month = rows.filter((r) => r.label.startsWith(monthKey));
	const all = sumRows(rows);
	const tile = (label, subset, extra = '') => {
		const s = sumRows(subset);
		const split = agentSplit(subset).filter(([, v]) => v.cost > 0.005).slice(0, 3);
		return `<div class="card stat">
			<div class="label">${label}</div>
			<div class="value">${fmtUSD(s.cost ?? 0)}</div>
			<div class="meta">${split.map(([a, v]) => `<span><i class="swatch" style="background:${colorOf('agent', a)}"></i>${esc(agentLabel(a))} ${fmtUSD(v.cost)}</span>`).join('') || '<span>No usage</span>'}</div>
			<div class="meta" style="margin-top:4px;color:var(--muted)">${fmtTok(s.total)} tokens${extra}</div>
		</div>`;
	};
	const days = rows.length;
	$('#tiles').innerHTML = [
		tile('Today', today),
		tile('Last 7 days', week, ` · ${fmtUSD((sumRows(week).cost ?? 0) / 7)}/day`),
		tile('This month', month),
		tile('All time', rows, ` · ${days} active days · ${fmtUSD((all.cost ?? 0) / Math.max(days, 1))}/day`),
	].join('');
}

function overviewDaily(rows) {
	const range = store.get('ovRange', 30);
	const metric = store.get('ovMetric', 'cost');
	const el = $('#daily-card');
	el.innerHTML = `
		<div class="card-head"><h2>Daily ${metric === 'cost' ? 'cost' : 'tokens'} by agent</h2><div class="spacer"></div>
			<div class="seg" id="ov-metric">${[['cost', 'Cost'], ['tokens', 'Tokens']].map(([k, l]) => `<button data-k="${k}" class="${metric === k ? 'on' : ''}">${l}</button>`).join('')}</div>
			<div class="seg" id="ov-range">${[[7, '7D'], [30, '30D'], [90, '90D'], [0, 'All']].map(([k, l]) => `<button data-k="${k}" class="${range === k ? 'on' : ''}">${l}</button>`).join('')}</div>
		</div>
		<div id="ov-legend"></div>
		<div class="chart-box"><canvas></canvas></div>`;
	$$('#ov-range button', el).forEach((b) => (b.onclick = () => { store.set('ovRange', +b.dataset.k); overviewDaily(rows); }));
	$$('#ov-metric button', el).forEach((b) => (b.onclick = () => { store.set('ovMetric', b.dataset.k); overviewDaily(rows); }));
	const filled = fillDays(rows, range);
	const agents = agentSplit(rows).map(([a]) => a);
	const series = agents.map((a) => ({
		label: agentLabel(a), color: colorOf('agent', a),
		data: filled.map((r) => {
			const x = r?.agents.find((y) => y.agent === a);
			return x ? (metric === 'cost' ? x.cost ?? 0 : x.total) : 0;
		}),
	}));
	const chart = barChart($('canvas', el), {
		labels: filled.map((r, i) => periodLabel(r?.label ?? filled.keys[i])), series,
		format: metric === 'cost' ? fmtUSD : fmtTok,
		tooltipTitle: (i) => new Date(filled.keys[i] + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
		onClick: (i) => setHash('r', ['daily'], new URLSearchParams({ since: isoToYmd(filled.keys[i]), until: isoToYmd(filled.keys[i]), 'by-agent': '1' }), false),
	});
	$('#ov-legend', el).replaceWith(legendHtml(series, chart));
}

// Calendar-continuous days so idle days show as gaps instead of disappearing.
function fillDays(rows, range) {
	if (!rows.length) return Object.assign([], { keys: [] });
	const by = new Map(rows.map((r) => [r.label, r]));
	const end = new Date(todayKey() + 'T12:00');
	const start = range ? new Date(end.getTime() - (range - 1) * 864e5) : new Date(rows[0].label + 'T12:00');
	const out = [], keys = [];
	for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
		const k = d.toLocaleDateString('en-CA');
		keys.push(k);
		out.push(by.get(k) ?? null);
	}
	out.keys = keys;
	return out;
}

function overviewAgents(rows) {
	const split = agentSplit(rows);
	const total = split.reduce((s, [, v]) => s + v.cost, 0);
	$('#agents-card').innerHTML = `<div class="card-head"><h2>Cost by agent</h2><span class="hint">all time</span></div>` +
		barList(split.map(([a, v]) => ({ label: agentLabel(a), value: v.cost, color: colorOf('agent', a), swatch: colorOf('agent', a), sub: fmtPct(v.cost / total) })));
}

function overviewModels(mt) {
	const items = [...mt].sort((a, b) => b[1] - a[1]);
	const total = items.reduce((s, [, v]) => s + v, 0);
	$('#models-card').innerHTML = `<div class="card-head"><h2>Top models</h2><span class="hint">by cost, all time</span></div>` +
		barList(items.slice(0, 8).map(([n, v]) => ({ label: shortModel(n), title: n, value: v, color: mColor(n), swatch: mColor(n), sub: fmtPct(v / total) })));
}

function overviewTokens(rows) {
	const s = sumRows(rows);
	const items = TOKEN_TYPES.filter((t) => s[t.key] > 0).map((t, i) => ({ label: t.label, value: s[t.key], color: `var(--s${i + 1})`, swatch: `var(--s${i + 1})`, sub: fmtPct(s[t.key] / s.total) }));
	const cacheHit = s.cacheRead / Math.max(1, s.cacheRead + s.input + s.cacheCreate);
	$('#tokens-card').innerHTML = `<div class="card-head"><h2>Token mix</h2><span class="hint">${fmtTok(s.total)} total · ${fmtPct(cacheHit)} of input from cache</span></div>` +
		barList(items, { format: fmtTok });
}

function overviewMonthly(rows) {
	const el = $('#monthly-card');
	el.innerHTML = `<div class="card-head"><h2>Monthly cost by agent</h2><div class="spacer"></div><a class="btn small" href="#/r/monthly?by-agent=1">Open report</a></div><div id="mo-legend"></div><div class="chart-box short"><canvas></canvas></div>`;
	const agents = agentSplit(rows).map(([a]) => a);
	const series = agents.map((a) => ({ label: agentLabel(a), color: colorOf('agent', a), data: rows.map((r) => r.agents.find((x) => x.agent === a)?.cost ?? 0) }));
	const chart = barChart($('canvas', el), { labels: rows.map((r) => periodLabel(r.label)), series });
	$('#mo-legend', el).replaceWith(legendHtml(series, chart));
}

function overviewProjects(rows) {
	const m = new Map();
	for (const r of rows) {
		const k = r.project ?? 'unknown';
		const cur = m.get(k) ?? { cost: 0, sessions: 0 };
		cur.cost += r.cost ?? 0; cur.sessions++;
		m.set(k, cur);
	}
	const items = [...m].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8);
	$('#projects-card').innerHTML = `<div class="card-head"><h2>Top Claude projects</h2><div class="spacer"></div><a class="btn small" href="#/r/claude/daily?instances=1">All projects</a></div>` +
		barList(items.map(([p, v]) => ({ label: prettyProject(p), title: p, value: v.cost, color: colorOf('agent', 'claude'), sub: `${v.sessions} sessions` })));
}

function overviewSessions(rows) {
	const top = [...rows].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 10);
	const el = $('#sessions-card');
	el.innerHTML = `<div class="card-head"><h2>Most expensive sessions</h2><span class="hint">across all agents</span><div class="spacer"></div><a class="btn small" href="#/r/session">All sessions</a></div><div></div>`;
	table(el.lastElementChild, {
		rows: top,
		columns: [
			{ key: 'label', label: 'Session', fmt: (r) => `<span class="mono" title="${esc(r.label)}">${esc(sessionLabel(r))}</span>` },
			{ key: 'agent', label: 'Agent', fmt: (r) => agentTag(r.agent) },
			{ key: 'models', label: 'Models', fmt: (r) => modelTags(r.models), sort: (r) => r.models.length },
			{ key: 'lastActivity', label: 'Last activity', fmt: (r) => fmtDate(r.lastActivity) },
			{ key: 'total', label: 'Tokens', num: true, fmt: (r) => fmtTok(r.total) },
			{ key: 'cost', label: 'Cost', num: true, fmt: (r) => fmtUSD(r.cost) },
		],
		sub: modelSubRows,
		initialSort: ['cost', -1],
		maxHeight: 'none',
	});
}

// ---------- active block ----------

function activeBlockHtml(b, limit, withLink) {
	const head = `<div class="card-head"><h2>Current 5-hour block</h2><span class="hint">Claude Code</span><div class="spacer"></div>${withLink ? '<a class="btn small" href="#/r/claude/blocks?recent=1">Blocks</a>' : ''}</div>`;
	if (!b) return head + `<div class="empty">No active block right now.<br><small>A block starts with your next Claude Code message.</small></div>`;
	const start = new Date(b.startTime), end = new Date(b.endTime), now = Date.now();
	const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
	const proj = b.projection;
	const limitPct = limit ? (proj?.totalTokens ?? b.totalTokens) / limit : null;
	const usedPct = limit ? b.totalTokens / limit : null;
	const status = limitPct == null ? '' : limitPct > 1 ? '<span class="pill crit">⚠ Projected over limit</span>' : limitPct > 0.8 ? '<span class="pill warn">▲ Near limit</span>' : '<span class="pill live">Within limit</span>';
	return head + `
		<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
			<div class="stat"><div class="value">${fmtUSD(b.costUSD)}</div></div>
			${proj ? `<div style="color:var(--ink-2)">→ ${fmtUSD(proj.totalCost)} projected</div>` : ''}
			<span class="pill live">Active</span>${status}
		</div>
		<div class="progress" title="${fmtPct(elapsed)} of the block elapsed"><b style="left:0;width:${elapsed * 100}%"></b><i style="width:${Math.min(1, (b.costUSD / (proj?.totalCost || b.costUSD || 1))) * elapsed * 100}%"></i></div>
		<div style="display:flex;justify-content:space-between;color:var(--muted);font-size:12px"><span>${fmtDate(b.startTime, { hour: '2-digit', minute: '2-digit' })}</span><span>${proj ? fmtDuration(proj.remainingMinutes) + ' left' : ''}</span><span>${fmtDate(b.endTime, { hour: '2-digit', minute: '2-digit' })}</span></div>
		${limit ? `<div style="margin-top:12px"><div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink-2)"><span>Token limit ${fmtTok(limit)}</span><span>${fmtPct(usedPct)} used · ${fmtPct(limitPct)} projected</span></div>
			<div class="progress"><b style="left:0;width:${Math.min(100, limitPct * 100)}%;background:color-mix(in srgb, ${limitPct > 1 ? 'var(--crit)' : 'var(--s1)'} 30%, transparent)"></b><i style="width:${Math.min(100, usedPct * 100)}%;background:${limitPct > 1 ? 'var(--crit)' : 'var(--s1)'}"></i></div></div>` : ''}
		<dl class="kv">
			<div><dt>Tokens</dt><dd>${fmtTok(b.totalTokens)}</dd></div>
			<div><dt>Projected tokens</dt><dd>${fmtTok(proj?.totalTokens)}</dd></div>
			<div><dt>Burn rate</dt><dd>${b.burnRate ? fmtUSD(b.burnRate.costPerHour) + '/h' : '—'}</dd></div>
			<div><dt>Tokens / min</dt><dd>${b.burnRate ? fmtTok(b.burnRate.tokensPerMinute) : '—'}</dd></div>
			<div><dt>Entries</dt><dd>${fmtInt(b.entries)}</dd></div>
			<div><dt>Models</dt><dd>${(b.models || []).map(shortModel).join(', ') || '—'}</dd></div>
		</dl>`;
}

// ---------- generic table ----------

function table(container, { rows, columns, sub, initialSort, total, maxHeight }) {
	let [sortKey, dir] = initialSort ?? [null, 1];
	const open = new Set();
	const wrap = h(`<div class="table-wrap"${maxHeight ? ` style="max-height:${maxHeight}"` : ''}><table><thead></thead><tbody></tbody></table></div>`);
	container.replaceChildren(wrap);
	const val = (c, r) => (c.sort ? c.sort(r) : r[c.key]);
	function draw() {
		const sorted = sortKey ? [...rows].sort((a, b) => {
			const c = columns.find((x) => x.key === sortKey);
			const va = val(c, a), vb = val(c, b);
			return (va == null) - (vb == null) || (va < vb ? -dir : va > vb ? dir : 0);
		}) : rows;
		$('thead', wrap).innerHTML = `<tr>${sub ? '<th style="width:20px"></th>' : ''}${columns.map((c) => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)} <span class="arrow">${sortKey === c.key ? (dir > 0 ? '▲' : '▼') : ''}</span></th>`).join('')}</tr>`;
		const html = [];
		sorted.forEach((r) => {
			const idx = rows.indexOf(r);
			const subs = sub ? sub(r) : [];
			html.push(`<tr>${sub ? `<td>${subs.length ? `<button class="expander" data-i="${idx}">${open.has(idx) ? '▾' : '▸'}</button>` : ''}</td>` : ''}${columns.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls ?? ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}</tr>`);
			if (open.has(idx)) for (const s of subs) html.push(`<tr class="sub"><td></td>${columns.map((c, ci) => `<td class="${c.num ? 'num' : ''}">${s[c.key] ?? (ci === 0 ? '' : '')}</td>`).join('')}</tr>`);
		});
		if (total) html.push(`<tr class="total">${sub ? '<td></td>' : ''}${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${total[c.key] ?? ''}</td>`).join('')}</tr>`);
		$('tbody', wrap).innerHTML = html.join('') || `<tr><td colspan="${columns.length + 1}" class="empty">No rows</td></tr>`;
	}
	wrap.addEventListener('click', (e) => {
		const th = e.target.closest('th[data-k]');
		if (th) { const k = th.dataset.k; dir = sortKey === k ? -dir : columns.find((c) => c.key === k).num ? -1 : 1; sortKey = k; draw(); return; }
		const ex = e.target.closest('.expander');
		if (ex) { const i = +ex.dataset.i; open.has(i) ? open.delete(i) : open.add(i); draw(); }
	});
	draw();
	return { setRows: (r) => { rows = r; open.clear(); draw(); } };
}

const agentTag = (a) => (a ? `<span class="tag"><i class="swatch" style="background:${colorOf('agent', a)}"></i>${esc(agentLabel(a))}</span>` : '');
const modelTags = (models) => `<div class="models">${models.map((m) => `<span class="tag" title="${esc(m.name)}${m.isFallback ? ' (fallback pricing)' : ''}"><i class="swatch" style="background:${mColor(m.name)}"></i>${esc(shortModel(m.name))}${m.isFallback ? '*' : ''}</span>`).join('')}</div>`;

function tokenCells(x) {
	return { input: fmtInt(x.input), output: fmtInt(x.output), cacheCreate: fmtInt(x.cacheCreate), cacheRead: fmtInt(x.cacheRead), reasoning: fmtInt(x.reasoning), total: fmtInt(x.total), cost: x.cost == null ? '—' : fmtUSD(x.cost) };
}

function modelSubRows(r) {
	const out = [];
	for (const a of r.agents) out.push({ label: `↳ ${esc(agentLabel(a.agent))}`, agent: agentTag(a.agent), models: modelTags(a.models), ...tokenCells(a) });
	for (const m of r.models) out.push({ label: `<span title="${esc(m.name)}">${r.agents.length ? '&nbsp;&nbsp;' : ''}↳ ${esc(shortModel(m.name))}${m.isFallback ? ' <span class="tag">fallback pricing</span>' : ''}</span>`, ...tokenCells(m) });
	return out;
}

function tokenColumns(rows) {
	const hasReasoning = rows.some((r) => r.reasoning > 0);
	const hasCache = rows.some((r) => r.cacheCreate > 0);
	return [
		{ key: 'input', label: 'Input', num: true, fmt: (r) => fmtInt(r.input) },
		{ key: 'output', label: 'Output', num: true, fmt: (r) => fmtInt(r.output) },
		...(hasReasoning ? [{ key: 'reasoning', label: 'Reasoning', num: true, fmt: (r) => fmtInt(r.reasoning) }] : []),
		...(hasCache ? [{ key: 'cacheCreate', label: 'Cache write', num: true, fmt: (r) => fmtInt(r.cacheCreate) }] : []),
		{ key: 'cacheRead', label: 'Cache read', num: true, fmt: (r) => fmtInt(r.cacheRead) },
		{ key: 'total', label: 'Total tokens', num: true, fmt: (r) => fmtInt(r.total) },
		{ key: 'cost', label: 'Cost', num: true, fmt: (r) => fmtUSD(r.cost) },
	];
}

// ---------- explorer ----------

function defaultsFor(cmd) {
	// Visual mode needs per-agent splits for stacking; still a visible, toggleable flag.
	return cmd.group === 'all' && ['daily', 'weekly', 'monthly'].includes(cmd.name) ? { 'by-agent': '1' } : {};
}

function flagsFromParams(cmd, params) {
	const p = { ...defaultsFor(cmd), ...Object.fromEntries([...params].filter(([k]) => k !== VIEW_PARAM)) };
	const flags = {};
	for (const [k, v] of Object.entries(p)) {
		const spec = cmd.flags.find((f) => f.name === k);
		if (!spec || SERVER_FLAGS.has(k)) continue;
		flags[k] = spec.type === 'boolean' ? v === '1' : v;
	}
	return flags;
}

async function renderExplorer(path, params, id) {
	if (!path.length) path = ['daily'];
	let cmd = findCmd(path);
	if (!cmd && path.length === 1) cmd = findCmd([path[0], 'daily']) ?? state.catalog.commands.find((c) => c.group === path[0]);
	if (!cmd) throw new Error(`Unknown ccusage command "${path.join(' ')}"`);
	const isStatus = cmd.name === 'statusline';
	const supportsJson = hasFlag(cmd, 'json');
	let view = params.get(VIEW_PARAM) || (isStatus ? 'preview' : supportsJson ? 'visual' : 'terminal');

	const groups = [...new Set(state.catalog.commands.map((c) => c.group))];
	const others = groups.filter((g) => !['all', 'claude', 'codex'].includes(g));
	const siblings = state.catalog.commands.filter((c) => c.group === cmd.group);
	const title = `${cmd.group === 'all' ? 'All agents' : agentLabel(cmd.group)} · ${cmd.name[0].toUpperCase() + cmd.name.slice(1)}`;
	const views = isStatus ? [['preview', 'Preview'], ['help', 'Help']] : [...(supportsJson ? [['visual', 'Visual'], ['json', 'JSON']] : []), ['terminal', 'Terminal'], ['help', 'Help']];
	if (!views.some(([k]) => k === view)) view = views[0][0];

	main().innerHTML = `
		<div class="topbar">
			<div><h1>${esc(title)}</h1><div class="sub">${esc(cmd.description)}</div></div>
			<div class="spacer"></div>
			<div class="seg" id="views">${views.map(([k, l]) => `<button data-k="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
			<button class="btn primary" id="run">${ICONS.refresh}Run</button>
		</div>
		<div class="card">
			<div class="cmd-tabs">
				${['all', 'claude', 'codex'].filter((g) => groups.includes(g)).map((g) => `<button class="btn small ${cmd.group === g ? 'on' : ''}" data-group="${g}">${g === 'all' ? 'All agents' : agentLabel(g)}</button>`).join('')}
				${others.length ? `<select class="input" id="other-group" style="height:26px;font-size:12.5px"><option value="">Other agents…</option>${others.map((g) => `<option value="${g}" ${cmd.group === g ? 'selected' : ''}>${esc(agentLabel(g))}</option>`).join('')}</select>` : ''}
				<span style="width:14px"></span>
				${siblings.map((c) => `<button class="btn small ${c === cmd ? 'on' : ''}" data-cmd="${c.name}">${c.name}</button>`).join('')}
			</div>
			<details id="opts-box" ${store.get('optsOpen', true) ? 'open' : ''}>
				<summary style="cursor:pointer;color:var(--ink-2);font-size:13px;margin:6px 0 10px">Options <span id="changed-count" style="color:var(--muted)"></span> <button class="btn small" id="reset" style="margin-left:8px">Reset</button></summary>
				<div class="opts" id="opts"></div>
			</details>
			<div class="cmdline"><code id="cmdline"></code><button class="btn small" id="copy-cmd">${ICONS.copy}Copy</button></div>
		</div>
		<div id="result" style="margin-top:14px"></div>`;

	const params2 = new URLSearchParams(params);
	const defaults = defaultsFor(cmd);
	for (const [k, v] of Object.entries(defaults)) if (!params2.has(k)) params2.set(k, v);

	$('#opts-box').ontoggle = (e) => store.set('optsOpen', e.target.open);
	$$('[data-group]').forEach((b) => (b.onclick = () => switchCmd(b.dataset.group, cmd.name)));
	$('#other-group')?.addEventListener('change', (e) => e.target.value && switchCmd(e.target.value, cmd.name));
	$$('[data-cmd]').forEach((b) => (b.onclick = () => switchCmd(cmd.group, b.dataset.cmd)));
	$$('#views button').forEach((b) => (b.onclick = () => { params2.set(VIEW_PARAM, b.dataset.k); setHash('r', cmd.path, params2); render(); }));
	$('#reset').onclick = (e) => { e.preventDefault(); const v = params2.get(VIEW_PARAM); setHash('r', cmd.path, new URLSearchParams(v ? { [VIEW_PARAM]: v } : {})); render(); };
	$('#run').onclick = () => execute(true);
	$('#copy-cmd').onclick = () => copy($('#cmdline').textContent);

	function switchCmd(group, name) {
		const target = findCmd(group === 'all' ? [name] : [group, name]) ?? state.catalog.commands.find((c) => c.group === group);
		const keep = new URLSearchParams();
		for (const [k, v] of params2) if (k !== VIEW_PARAM && target.flags.some((f) => f.name === k) && !(k in defaults)) keep.set(k, v);
		setHash('r', target.path, keep, false);
	}

	buildOptions(cmd, params2, () => { setHash('r', cmd.path, params2); updateCmdline(); execute(false); });
	updateCmdline();

	function updateCmdline() {
		const flags = flagsFromParams(cmd, params2);
		const parts = ['ccusage', ...cmd.path];
		for (const [k, v] of Object.entries(flags)) {
			const spec = cmd.flags.find((f) => f.name === k);
			if (spec.type === 'boolean') { if (v) parts.push(`--${k}`); else if (spec.negatable) parts.push(`--no-${k}`); }
			else if (v !== '') parts.push(`--${k}=${/\s/.test(v) ? `"${v}"` : v}`);
		}
		if (view === 'json' || view === 'visual') parts.push('--json');
		$('#cmdline').textContent = parts.join(' ');
		const n = Object.keys(flags).length;
		$('#changed-count').textContent = n ? `(${n} set)` : '';
	}

	let seq = 0;
	async function execute(fresh) {
		const my = ++seq;
		const out = $('#result');
		if (!out) return;
		destroyCharts(out);
		if (view === 'help') { out.innerHTML = `<pre class="term">${esc(cmd.help)}</pre>`; return; }
		if (isStatus) return renderStatusline(out, cmd, flagsFromParams(cmd, params2));
		out.innerHTML = `<div class="card center"><span class="spinner"></span>Running ccusage…</div>`;
		const flags = flagsFromParams(cmd, params2);
		try {
			const r = await api('/api/run', { command: cmd.path, flags, json: view !== 'terminal', fresh });
			if (my !== seq || id !== state.renderId) return;
			const meta = `<div class="toolbar" style="margin-bottom:10px;color:var(--muted);font-size:12.5px"><span>exit ${r.code} · ${r.ms} ms${r.cached ? ' · cached' : ''}</span><div class="spacer" style="flex:1"></div>
				${view !== 'terminal' && r.data ? `<button class="btn small" id="dl-json">${ICONS.download}JSON</button>` : ''}
				${view === 'visual' && r.data ? `<button class="btn small" id="dl-csv">${ICONS.download}CSV</button>` : ''}
				${view === 'terminal' ? `<button class="btn small" id="copy-out">${ICONS.copy}Copy output</button>` : ''}</div>`;
			const stderr = r.stderr.trim() ? `<details class="raw" style="margin-top:12px" ${r.code ? 'open' : ''}><summary>stderr</summary><pre class="term wrap">${ansiToHtml(r.stderr)}</pre></details>` : '';
			if (view === 'terminal') {
				out.innerHTML = r.stdout.trim()
					? meta + `<pre class="term">${ansiToHtml(r.stdout)}</pre>` + stderr
					: meta + `<pre class="term">${ansiToHtml(r.stderr) || '<span style="opacity:.6">(no output)</span>'}</pre>`;
				$('#copy-out').onclick = () => copy(r.stdout.replace(/\x1b\[[\d;]*m/g, ''));
				return;
			}
			if (!r.data) { out.innerHTML = meta + `<div class="err">${esc((r.stderr || r.stdout || 'No JSON output').trim())}</div>`; return; }
			const base = `ccusage-${cmd.path.join('-')}`;
			if (view === 'json') {
				out.innerHTML = meta + `<pre class="term wrap">${esc(JSON.stringify(r.data, null, 2))}</pre>` + stderr;
			} else {
				out.innerHTML = meta + `<div id="vis"></div>` + stderr;
				renderVisual($('#vis'), r.data, cmd, flags);
				$('#dl-csv').onclick = () => {
					const rep = normalizeReport(r.data);
					download(`${base}.csv`, toCSV(rep.sections.flatMap((s) => s.rows)), 'text/csv');
				};
			}
			$('#dl-json').onclick = () => download(`${base}.json`, JSON.stringify(r.data, null, 2));
		} catch (e) {
			if (my === seq) out.innerHTML = `<div class="err">${esc(e.message)}</div>`;
		}
	}
	await execute(false);
}

function buildOptions(cmd, params, onChange) {
	const box = $('#opts');
	const tzs = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();
	const visible = cmd.flags.filter((f) => !SERVER_FLAGS.has(f.name));
	box.innerHTML = visible.map((f) => {
		const id = `opt-${f.name}`;
		const v = params.get(f.name);
		const changed = v != null;
		const name = `--${f.name}${f.short ? ` <em>-${f.short}</em>` : ''}`;
		if (f.type === 'boolean') {
			const checked = v != null ? v === '1' : f.default === 'true';
			return `<div class="opt bool ${changed ? 'changed' : ''}"><input type="checkbox" id="${id}" data-f="${f.name}" ${checked ? 'checked' : ''}><div><label class="name" for="${id}">${name}</label><div class="desc">${esc(f.description)}${f.negatable ? ' (negatable)' : ''}</div></div></div>`;
		}
		if (f.type === 'choice') {
			const cur = v ?? f.default ?? '';
			return `<div class="opt ${changed ? 'changed' : ''}"><label class="name" for="${id}">${name}</label><select class="input" id="${id}" data-f="${f.name}">${f.default == null ? '<option value=""></option>' : ''}${f.choices.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select><div class="desc">${esc(f.description)}</div></div>`;
		}
		const isDate = (f.name === 'since' || f.name === 'until');
		const list = f.name === 'timezone' ? 'tz-list' : f.name === 'sections' ? 'sections-list' : f.name === 'token-limit' ? 'limit-list' : '';
		const ph = f.default ?? (f.name === 'last' ? 'e.g. 7' : f.name === 'project-aliases' ? 'name=Alias,…' : '');
		return `<div class="opt ${changed ? 'changed' : ''}"><label class="name" for="${id}">${name}</label><input class="input" id="${id}" data-f="${f.name}" ${isDate ? 'type="date"' : ''} ${list ? `list="${list}"` : ''} value="${esc(isDate ? ymdToIso(v) : v ?? '')}" placeholder="${esc(ph)}"><div class="desc">${esc(f.description)}</div></div>`;
	}).join('') + `
		<datalist id="tz-list">${tzs.map((t) => `<option value="${t}">`).join('')}</datalist>
		<datalist id="sections-list"><option value="daily,weekly,monthly,session"><option value="daily,monthly"><option value="weekly,monthly"></datalist>
		<datalist id="limit-list"><option value="max"><option value="500000"><option value="1000000"></datalist>`;

	box.addEventListener('change', (e) => {
		const el = e.target.closest('[data-f]');
		if (!el) return;
		const f = cmd.flags.find((x) => x.name === el.dataset.f);
		let v;
		if (f.type === 'boolean') {
			v = el.checked ? '1' : '0';
			if ((f.default === 'true') === el.checked && !(f.name in defaultsFor(cmd))) v = null;
		} else if (f.type === 'choice') v = el.value === (f.default ?? '') ? null : el.value;
		else v = el.type === 'date' ? isoToYmd(el.value) : el.value.trim();
		if (v == null || v === '') params.delete(f.name); else params.set(f.name, v);
		el.closest('.opt').classList.toggle('changed', params.has(f.name));
		onChange();
	});
}

// ---------- visual renderers ----------

function renderVisual(el, json, cmd, flags) {
	const rep = normalizeReport(json);
	if (!rep) { el.innerHTML = '<div class="empty">Nothing to show</div>'; return; }
	if (rep.kind === 'blocks') return renderBlocks(el, rep, flags);
	if (rep.kind === 'instances') return renderInstances(el, rep);
	if (!rep.sections.length || rep.sections.every((s) => !s.rows.length)) {
		el.innerHTML = `<div class="card empty">No usage found for this report and filter.</div>`;
		return;
	}
	const multi = rep.sections.length > 1;
	el.innerHTML = rep.sections.map((s, i) => `<div data-sec="${i}" style="margin-bottom:22px">${multi ? `<h2 style="font-size:16px;margin:0 0 10px;text-transform:capitalize">${esc(s.key)}</h2>` : ''}</div>`).join('');
	rep.sections.forEach((s, i) => {
		const box = $(`[data-sec="${i}"]`, el);
		const sub = h('<div></div>');
		box.append(sub);
		if (s.kind === 'session') renderSessions(sub, s.rows, cmd);
		else renderPeriods(sub, s.rows, cmd, s.key, flags);
	});
}

function tilesHtml(rows, unit) {
	const s = sumRows(rows);
	const cacheHit = s.cacheRead / Math.max(1, s.cacheRead + s.input + s.cacheCreate);
	const peak = rows.reduce((m, r) => ((r.cost ?? 0) > (m?.cost ?? -1) ? r : m), null);
	return `<div class="grid cols-4" style="margin-bottom:14px">
		<div class="card stat"><div class="label">Total cost</div><div class="value">${fmtUSD(s.cost)}</div><div class="meta">${rows.length} ${unit}${s.cost == null ? '' : ` · ${fmtUSD(s.cost / Math.max(1, rows.length))} avg`}</div></div>
		<div class="card stat"><div class="label">Total tokens</div><div class="value">${fmtTok(s.total)}</div><div class="meta"><span>in ${fmtTok(s.input)}</span><span>out ${fmtTok(s.output)}</span>${s.reasoning ? `<span>reasoning ${fmtTok(s.reasoning)}</span>` : ''}</div></div>
		<div class="card stat"><div class="label">Cache</div><div class="value">${fmtPct(cacheHit)}</div><div class="meta"><span>read ${fmtTok(s.cacheRead)}</span><span>write ${fmtTok(s.cacheCreate)}</span></div></div>
		<div class="card stat"><div class="label">Peak ${unit.replace(/s$/, '')}</div><div class="value">${fmtUSD(peak?.cost)}</div><div class="meta">${esc(peak ? (unit === 'sessions' ? sessionLabel(peak) : periodLabel(peak.label)) : '—')}</div></div>
	</div>`;
}

function renderPeriods(el, rows, cmd, key, flags) {
	const unit = { daily: 'days', weekly: 'weeks', monthly: 'months' }[key] ?? 'periods';
	const chrono = flags.order === 'desc' ? [...rows].reverse() : rows;
	const hasAgents = chrono.some((r) => r.agents.length);
	const modelCost = chrono.every((r) => r.models.every((m) => m.cost != null));
	const stackOpts = [...(hasAgents ? [['agent', 'Agent']] : []), ['model', 'Model'], ['token', 'Token type'], ['none', 'Total']];
	let stack = store.get(`stack:${cmd.group}`, stackOpts[0][0]);
	if (!stackOpts.some(([k]) => k === stack)) stack = stackOpts[0][0];
	let metric = rows.every((r) => r.cost == null) ? 'tokens' : store.get('metric', 'cost');

	const mt = new Map();
	for (const r of chrono) for (const m of r.models) mt.set(m.name, (mt.get(m.name) ?? 0) + (m.cost ?? m.total));
	registerModels(mt, modelKind);

	el.innerHTML = tilesHtml(rows, unit) + `
		<div class="card">
			<div class="card-head"><h2 id="ch-title"></h2><div class="spacer"></div>
				<div class="seg" id="metric">${[['cost', 'Cost'], ['tokens', 'Tokens']].map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
				<div class="seg" id="stack">${stackOpts.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
			</div>
			<div id="lg"></div><div class="chart-box tall"><canvas></canvas></div>
		</div>
		<div class="card" style="margin-top:14px"><div class="card-head"><h2>Breakdown</h2><span class="hint">click a column to sort · ▸ expands ${hasAgents ? 'agents and ' : ''}models</span></div><div id="tbl"></div></div>`;

	function drawChart() {
		const m = stack === 'token' ? 'tokens' : metric;
		const val = (x) => (m === 'cost' ? x.cost ?? 0 : x.total);
		let series;
		if (stack === 'agent') {
			const agents = [...new Set(chrono.flatMap((r) => r.agents.map((a) => a.agent)))];
			series = agents.map((a) => ({ label: agentLabel(a), color: colorOf('agent', a), data: chrono.map((r) => val(r.agents.find((x) => x.agent === a) ?? { cost: 0, total: 0 })) }));
		} else if (stack === 'model' && (m === 'tokens' || modelCost)) {
			const names = [...mt.keys()];
			const named = names.filter((n) => slotOf(modelKind, n) >= 0);
			const rest = names.filter((n) => !named.includes(n));
			series = named.map((n) => ({ label: shortModel(n), color: mColor(n), data: chrono.map((r) => val(r.models.find((x) => x.name === n) ?? { cost: 0, total: 0 })) }));
			if (rest.length) series.push({ label: `Other (${rest.length})`, color: 'var(--other)', data: chrono.map((r) => r.models.filter((x) => rest.includes(x.name)).reduce((s, x) => s + val(x), 0)) });
		} else if (stack === 'token') {
			series = TOKEN_TYPES.filter((t) => chrono.some((r) => r[t.key] > 0)).map((t, i) => ({ label: t.label, color: getComputedStyle(document.documentElement).getPropertyValue(`--s${i + 1}`).trim(), data: chrono.map((r) => r[t.key]) }));
		} else {
			series = [{ label: m === 'cost' ? 'Cost' : 'Tokens', color: colorOf('agent', cmd.group === 'all' ? 'codex' : cmd.group), data: chrono.map(val) }];
		}
		$$('#metric button', el).forEach((b) => { b.classList.toggle('on', b.dataset.k === m); b.disabled = stack === 'token'; });
		$$('#stack button', el).forEach((b) => b.classList.toggle('on', b.dataset.k === stack));
		$('#ch-title', el).textContent = `${m === 'cost' ? 'Cost' : 'Tokens'} per ${unit.replace(/s$/, '')}${stack !== 'none' ? ` by ${stack === 'token' ? 'token type' : stack}` : ''}${stack === 'model' && m === 'cost' && !modelCost ? ' (per-model cost not reported here, showing totals)' : ''}`;
		const chart = barChart($('canvas', el), { labels: chrono.map((r) => periodLabel(r.label)), series, format: m === 'cost' ? fmtUSD : fmtTok, tooltipTitle: (i) => chrono[i].label });
		const lg = series.length > 1 ? legendHtml(series, chart) : h('<div></div>');
		lg.id = 'lg';
		$('#lg', el).replaceWith(lg);
	}
	$$('#metric button', el).forEach((b) => (b.onclick = () => { metric = b.dataset.k; store.set('metric', metric); drawChart(); }));
	$$('#stack button', el).forEach((b) => (b.onclick = () => { stack = b.dataset.k; store.set(`stack:${cmd.group}`, stack); drawChart(); }));
	drawChart();

	const tot = sumRows(rows);
	table($('#tbl', el), {
		rows,
		columns: [
			{ key: 'label', label: { daily: 'Date', weekly: 'Week of', monthly: 'Month' }[key] ?? 'Period', fmt: (r) => `<b>${esc(r.label)}</b>` },
			...(hasAgents || cmd.group === 'all' ? [{ key: 'agentsUsed', label: 'Agents', fmt: (r) => (r.agents.length ? r.agents.map((a) => a.agent) : r.agentsUsed).map(agentTag).join(' '), sort: (r) => r.agentsUsed.length }] : []),
			{ key: 'models', label: 'Models', fmt: (r) => modelTags(r.models), sort: (r) => r.models.length },
			...tokenColumns(rows),
		],
		sub: modelSubRows,
		total: { label: '<b>Total</b>', ...tokenCells(tot) },
	});
}

function renderSessions(el, rows, cmd) {
	const mt = new Map();
	for (const r of rows) for (const m of r.models) mt.set(m.name, (mt.get(m.name) ?? 0) + (m.cost ?? m.total));
	registerModels(mt, modelKind);
	const showAgent = cmd.group === 'all';
	const showProject = rows.some((r) => r.project);
	el.innerHTML = tilesHtml(rows, 'sessions') + `
		<div class="grid cols-3">
			<div class="card span-2"><div class="card-head"><h2>Top 15 sessions by cost</h2><span class="hint">click a bar to filter the table</span></div><div class="chart-box tall"><canvas></canvas></div></div>
			<div class="card"><div class="card-head"><h2>${showProject ? 'By project' : showAgent ? 'By agent' : 'By model'}</h2></div><div id="side"></div></div>
		</div>
		<div class="card" style="margin-top:14px"><div class="card-head"><h2>Sessions</h2><span class="hint" id="count"></span><div class="spacer"></div><input class="input" id="q" placeholder="Filter by id, project, model…" style="width:260px"></div><div id="tbl"></div></div>`;

	const top = [...rows].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 15);
	barChart($('canvas', el), {
		labels: top.map((r) => (showProject ? prettyProject(r.project) + ' · ' : '') + sessionLabel(r)),
		series: [{ label: 'Cost', color: colorOf('agent', cmd.group === 'all' ? 'codex' : cmd.group), data: top.map((r) => r.cost ?? 0) }],
		horizontal: true, stacked: false,
		onClick: (i) => { $('#q', el).value = top[i].label; filter(); },
	});

	const groupBy = showProject ? (r) => r.project ?? '—' : showAgent ? (r) => r.agent ?? '—' : null;
	if (groupBy) {
		const m = new Map();
		for (const r of rows) { const k = groupBy(r); const c = m.get(k) ?? { cost: 0, n: 0 }; c.cost += r.cost ?? 0; c.n++; m.set(k, c); }
		$('#side', el).innerHTML = barList([...m].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10).map(([k, v]) => ({
			label: showProject ? prettyProject(k) : agentLabel(k), title: k, value: v.cost, sub: `${v.n}`,
			color: showProject ? colorOf('agent', 'claude') : colorOf('agent', k), swatch: showProject ? null : colorOf('agent', k),
		})));
	} else {
		$('#side', el).innerHTML = barList([...mt].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, v]) => ({ label: shortModel(n), title: n, value: v, color: mColor(n), swatch: mColor(n) })), { format: rows.every((r) => r.models.every((m) => m.cost != null)) ? fmtUSD : fmtTok });
	}

	const t = table($('#tbl', el), {
		rows,
		columns: [
			{ key: 'label', label: 'Session', fmt: (r) => `<span class="mono" title="${esc(r.label)}">${esc(sessionLabel(r))}</span>` },
			...(showAgent ? [{ key: 'agent', label: 'Agent', fmt: (r) => agentTag(r.agent) }] : []),
			...(showProject ? [{ key: 'project', label: 'Project', cls: 'trunc', fmt: (r) => `<span title="${esc(r.project)}">${esc(prettyProject(r.project))}</span>` }] : []),
			...(rows.some((r) => r.directory) ? [{ key: 'directory', label: 'Directory' }] : []),
			{ key: 'models', label: 'Models', fmt: (r) => modelTags(r.models), sort: (r) => r.models.length },
			...(rows.some((r) => r.firstActivity) ? [{ key: 'firstActivity', label: 'Started', fmt: (r) => fmtDate(r.firstActivity) }] : []),
			{ key: 'lastActivity', label: 'Last activity', fmt: (r) => fmtDate(r.lastActivity) },
			...tokenColumns(rows),
		],
		sub: modelSubRows,
		initialSort: ['lastActivity', -1],
	});
	function filter() {
		const q = $('#q', el).value.toLowerCase().trim();
		const f = q ? rows.filter((r) => [r.label, r.project, r.agent, r.directory, r.file, ...r.models.map((m) => m.name)].some((x) => x && String(x).toLowerCase().includes(q))) : rows;
		t.setRows(f);
		$('#count', el).textContent = `${f.length} of ${rows.length}`;
	}
	$('#q', el).oninput = filter;
	filter();
}

function renderInstances(el, rep) {
	const rows = rep.sections[0].rows;
	const byProject = new Map();
	for (const r of rows) { const c = byProject.get(r.project) ?? []; c.push(r); byProject.set(r.project, c); }
	const ranked = [...byProject].map(([p, rs]) => ({ project: p, rows: rs, ...sumRows(rs) })).sort((a, b) => b.cost - a.cost);
	const dates = [...new Set(rows.map((r) => r.label))].sort();
	const named = ranked.slice(0, 7);
	const rest = ranked.slice(7);
	named.forEach((p) => colorOf('project', p.project));
	const series = named.map((p) => ({ label: prettyProject(p.project), color: colorOf('project', p.project), data: dates.map((d) => p.rows.find((r) => r.label === d)?.cost ?? 0) }));
	if (rest.length) series.push({ label: `Other (${rest.length})`, color: 'var(--other)', data: dates.map((d) => rest.reduce((s, p) => s + (p.rows.find((r) => r.label === d)?.cost ?? 0), 0)) });

	el.innerHTML = tilesHtml(rows, 'project-days') + `
		<div class="grid cols-3">
			<div class="card span-2"><div class="card-head"><h2>Daily cost by project</h2></div><div id="lg"></div><div class="chart-box tall"><canvas></canvas></div></div>
			<div class="card"><div class="card-head"><h2>Projects</h2><span class="hint">${ranked.length} total</span></div>${barList(ranked.slice(0, 12).map((p) => ({ label: prettyProject(p.project), title: p.project, value: p.cost, color: colorOf('project', p.project), sub: `${p.rows.length}d` })))}</div>
		</div>
		<div class="card" style="margin-top:14px"><div class="card-head"><h2>Per project</h2><span class="hint">▸ expands days</span></div><div id="tbl"></div></div>`;
	const chart = barChart($('canvas', el), { labels: dates.map(periodLabel), series });
	$('#lg', el).replaceWith(legendHtml(series, chart));
	table($('#tbl', el), {
		rows: ranked.map((p) => ({ ...p, label: p.project, models: [...new Map(p.rows.flatMap((r) => r.models).map((m) => [m.name, m])).values()] })),
		columns: [
			{ key: 'label', label: 'Project', cls: 'trunc', fmt: (r) => `<i class="swatch" style="background:${colorOf('project', r.project)}"></i> <b title="${esc(r.project)}">${esc(prettyProject(r.project))}</b>` },
			{ key: 'days', label: 'Days', num: true, fmt: (r) => r.rows.length, sort: (r) => r.rows.length },
			{ key: 'models', label: 'Models', fmt: (r) => modelTags(r.models), sort: (r) => r.models.length },
			...tokenColumns(rows),
		],
		sub: (p) => [...p.rows].sort((a, b) => (a.label < b.label ? 1 : -1)).map((r) => ({ label: esc(r.label), days: '', models: modelTags(r.models), ...tokenCells(r) })),
		initialSort: ['cost', -1],
		total: { label: '<b>Total</b>', ...tokenCells(sumRows(rows)) },
	});
}

function renderBlocks(el, rep, flags) {
	const blocks = rep.blocks;
	const real = blocks.filter((b) => !b.isGap);
	if (!real.length) { el.innerHTML = `<div class="card empty">No blocks found for this filter.</div>`; return; }
	const active = blocks.find((b) => b.isActive);
	const tl = flags['token-limit'];
	const limit = !tl ? null : tl === 'max' ? Math.max(...real.filter((b) => !b.isActive).map((b) => b.totalTokens), 0) || null : Number(tl) || null;
	const chrono = [...real].sort((a, b) => a.startTime.localeCompare(b.startTime));
	const totCost = real.reduce((s, b) => s + (b.costUSD ?? 0), 0);
	const totTok = real.reduce((s, b) => s + b.totalTokens, 0);
	const peak = real.reduce((m, b) => (b.costUSD > (m?.costUSD ?? -1) ? b : m), null);
	const hours = real.reduce((s, b) => s + (new Date(b.actualEndTime ?? b.endTime) - new Date(b.startTime)) / 36e5, 0);

	el.innerHTML = `
		<div class="grid cols-4" style="margin-bottom:14px">
			<div class="card stat"><div class="label">Blocks</div><div class="value">${real.length}</div><div class="meta">${blocks.length - real.length} gaps · ${fmtDuration(hours * 60)} active</div></div>
			<div class="card stat"><div class="label">Total cost</div><div class="value">${fmtUSD(totCost)}</div><div class="meta">${fmtUSD(totCost / real.length)} avg per block</div></div>
			<div class="card stat"><div class="label">Total tokens</div><div class="value">${fmtTok(totTok)}</div><div class="meta">${fmtTok(totTok / real.length)} avg per block</div></div>
			<div class="card stat"><div class="label">Peak block</div><div class="value">${fmtUSD(peak?.costUSD)}</div><div class="meta">${fmtDate(peak?.startTime)} · ${fmtTok(peak?.totalTokens)}</div></div>
		</div>
		<div class="grid cols-3">
			<div class="card span-2"><div class="card-head"><h2>Cost per block</h2><span class="hint">${active ? 'active block highlighted' : ''}${limit ? ` · token limit ${fmtTok(limit)}` : ''}</span></div><div class="chart-box tall"><canvas></canvas></div></div>
			<div class="card block-card">${activeBlockHtml(active, limit, false)}</div>
		</div>
		<div class="card" style="margin-top:14px"><div class="card-head"><h2>Blocks</h2></div><div id="tbl"></div></div>`;

	const s1 = getComputedStyle(document.documentElement).getPropertyValue('--s1').trim();
	const s2 = getComputedStyle(document.documentElement).getPropertyValue('--s2').trim();
	const chart = barChart($('canvas', el), {
		labels: chrono.map((b) => fmtDate(b.startTime, { month: 'short', day: 'numeric', hour: '2-digit' })),
		series: [{ label: 'Cost', color: s1, data: chrono.map((b) => b.costUSD ?? 0) }],
		stacked: false,
		tooltipTitle: (i) => `${fmtDate(chrono[i].startTime)} – ${fmtDate(chrono[i].actualEndTime ?? chrono[i].endTime, { hour: '2-digit', minute: '2-digit' })}${chrono[i].isActive ? ' (active)' : ''} · ${fmtTok(chrono[i].totalTokens)} tokens`,
	});
	chart.data.datasets[0].backgroundColor = chrono.map((b) => (b.isActive ? s2 : s1));
	chart.update();

	const rows = blocks.map((b) => ({
		...b, label: b.startTime, cost: b.costUSD, total: b.totalTokens,
		...(b.isGap ? { tokenCounts: null, entries: null, totalTokens: null } : {}),
		models: (b.models || []).map((n) => ({ name: n })),
		duration: (new Date(b.actualEndTime ?? b.endTime) - new Date(b.startTime)) / 6e4,
	}));
	table($('#tbl', el), {
		rows,
		columns: [
			{ key: 'label', label: 'Start', fmt: (r) => fmtDate(r.startTime, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
			{ key: 'status', label: 'Status', fmt: (r) => (r.isActive ? '<span class="pill live">Active</span>' : r.isGap ? '<span class="pill">Gap</span>' : '<span class="pill">Done</span>'), sort: (r) => (r.isActive ? 2 : r.isGap ? 0 : 1) },
			{ key: 'duration', label: 'Duration', num: true, fmt: (r) => fmtDuration(r.duration) },
			{ key: 'models', label: 'Models', fmt: (r) => (r.isGap ? '' : modelTags(r.models)), sort: (r) => r.models.length },
			{ key: 'entries', label: 'Entries', num: true, fmt: (r) => fmtInt(r.entries) },
			{ key: 'input', label: 'Input', num: true, fmt: (r) => fmtInt(r.tokenCounts?.inputTokens), sort: (r) => r.tokenCounts?.inputTokens },
			{ key: 'output', label: 'Output', num: true, fmt: (r) => fmtInt(r.tokenCounts?.outputTokens), sort: (r) => r.tokenCounts?.outputTokens },
			{ key: 'cw', label: 'Cache write', num: true, fmt: (r) => fmtInt(r.tokenCounts?.cacheCreationInputTokens), sort: (r) => r.tokenCounts?.cacheCreationInputTokens },
			{ key: 'cr', label: 'Cache read', num: true, fmt: (r) => fmtInt(r.tokenCounts?.cacheReadInputTokens), sort: (r) => r.tokenCounts?.cacheReadInputTokens },
			{ key: 'total', label: 'Total tokens', num: true, fmt: (r) => fmtInt(r.totalTokens) },
			...(limit ? [{ key: 'pct', label: '% of limit', num: true, fmt: (r) => (r.isGap ? '' : fmtPct(r.totalTokens / limit)), sort: (r) => r.totalTokens }] : []),
			{ key: 'cost', label: 'Cost', num: true, fmt: (r) => (r.isGap ? '' : fmtUSD(r.costUSD)) },
			{ key: 'burn', label: 'Burn / h', num: true, fmt: (r) => (r.burnRate ? fmtUSD(r.burnRate.costPerHour) : ''), sort: (r) => r.burnRate?.costPerHour },
		],
		initialSort: ['label', -1],
	});
}

// ---------- statusline ----------

async function renderStatusline(out, cmd, flags) {
	const saved = store.get('statusline', { modelName: 'Opus 5.5', modelId: 'claude-opus-5-5', sessionCost: '', contextTokens: '', contextSize: '200000', effort: '' });
	out.innerHTML = `<div class="card center"><span class="spinner"></span>Loading sessions…</div>`;
	let transcripts = [];
	try { transcripts = await api('/api/transcripts'); } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
	if (!transcripts.length) { out.innerHTML = `<div class="card empty">No Claude Code transcripts found.</div>`; return; }
	const pick = saved.transcript && transcripts.some((t) => t.path === saved.transcript) ? saved.transcript : transcripts[0].path;
	out.innerHTML = `
		<div class="card">
			<div class="card-head"><h2>Hook input</h2><span class="hint">ccusage reads this JSON from stdin, as Claude Code sends it</span></div>
			<div class="opts">
				<div class="opt" style="grid-column:span 2"><label class="name">session / transcript_path</label><select class="input" id="sl-t">${transcripts.map((t) => `<option value="${esc(t.path)}" ${t.path === pick ? 'selected' : ''}>${esc(prettyProject(t.project))} · ${fmtDate(new Date(t.mtime).toISOString())} · ${t.sessionId.slice(0, 8)}</option>`).join('')}</select></div>
				<div class="opt"><label class="name">model.display_name</label><input class="input" id="sl-mn" value="${esc(saved.modelName)}"></div>
				<div class="opt"><label class="name">model.id</label><input class="input" id="sl-mi" value="${esc(saved.modelId)}"></div>
				<div class="opt"><label class="name">cost.total_cost_usd</label><input class="input" id="sl-c" type="number" step="0.01" value="${esc(saved.sessionCost)}" placeholder="omit"></div>
				<div class="opt"><label class="name">context_window.total_input_tokens</label><input class="input" id="sl-ct" type="number" value="${esc(saved.contextTokens)}" placeholder="omit"></div>
				<div class="opt"><label class="name">context_window.context_window_size</label><input class="input" id="sl-cs" type="number" value="${esc(saved.contextSize)}"></div>
				<div class="opt"><label class="name">effort</label><select class="input" id="sl-e">${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option ${e === saved.effort ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
			</div>
		</div>
		<div class="card" style="margin-top:14px"><div class="card-head"><h2>Rendered statusline</h2><div class="spacer"></div><button class="btn small" id="sl-run">${ICONS.refresh}Render</button></div><pre class="term wrap" id="sl-out" style="font-size:14px;padding:18px"></pre><details class="raw" style="margin-top:10px"><summary>Hook JSON sent</summary><pre class="term wrap" id="sl-hook"></pre></details></div>
		<div class="card" style="margin-top:14px"><div class="card-head"><h2>Install</h2><span class="hint">add to ~/.claude/settings.json</span><div class="spacer"></div><button class="btn small" id="sl-copy">${ICONS.copy}Copy</button></div><pre class="term wrap" id="sl-install"></pre></div>`;

	const flagArgs = Object.entries(flags).map(([k, v]) => {
		const spec = cmd.flags.find((f) => f.name === k);
		return spec.type === 'boolean' ? (v ? `--${k}` : spec.negatable ? `--no-${k}` : '') : `--${k}=${v}`;
	}).filter(Boolean).join(' ');
	const install = JSON.stringify({ statusLine: { type: 'command', command: `npx -y ccusage@latest ${cmd.path.join(' ')}${flagArgs ? ' ' + flagArgs : ''}`, padding: 0 } }, null, 2);
	$('#sl-install', out).textContent = install;
	$('#sl-copy', out).onclick = () => copy(install);

	async function go() {
		const body = {
			command: cmd.path, flags, transcript: $('#sl-t', out).value,
			modelName: $('#sl-mn', out).value, modelId: $('#sl-mi', out).value, sessionCost: $('#sl-c', out).value,
			contextTokens: $('#sl-ct', out).value, contextSize: $('#sl-cs', out).value, effort: $('#sl-e', out).value,
		};
		store.set('statusline', { ...body, command: undefined, flags: undefined });
		$('#sl-out', out).innerHTML = '<span class="spinner"></span>';
		try {
			const r = await api('/api/statusline', body);
			$('#sl-out', out).innerHTML = ansiToHtml(r.stdout.trim()) + (r.stderr.trim() ? `\n\n<span style="opacity:.7">${ansiToHtml(r.stderr.trim())}</span>` : '') || '(no output)';
			$('#sl-hook', out).textContent = JSON.stringify(r.hook, null, 2);
		} catch (e) { $('#sl-out', out).innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`; }
	}
	out.addEventListener('change', (e) => e.target.closest('input,select') && go());
	$('#sl-run', out).onclick = go;
	go();
}

// ---------- coverage ----------

function renderCoverage() {
	const c = state.catalog;
	const groups = [...new Set(c.commands.map((x) => x.group))];
	const flagCount = c.commands.reduce((s, x) => s + x.flags.length, 0);
	const auto = { json: 'Visual / JSON views', color: 'Terminal view', 'no-color': 'Visual / JSON views', help: 'Help view', version: 'Sidebar' };
	main().innerHTML = `
		<div class="topbar"><div><h1>ccusage coverage</h1><div class="sub">Generated from <code>ccusage --help</code> at startup, so every command and flag of the installed version is reachable</div></div></div>
		<div class="grid cols-4" style="margin-bottom:18px">
			<div class="card stat"><div class="label">Installed ccusage</div><div class="value">${esc(c.version)}</div><div class="meta">update with <code>npm run update-ccusage</code></div></div>
			<div class="card stat"><div class="label">Commands</div><div class="value">${c.commands.length}</div><div class="meta">${groups.length} groups</div></div>
			<div class="card stat"><div class="label">Flag instances</div><div class="value">${flagCount}</div><div class="meta">each one rendered as a control</div></div>
			<div class="card stat"><div class="label">Coverage</div><div class="value ok">100%</div><div class="meta">every command opens in the explorer</div></div>
		</div>
		${groups.map((g) => `<div class="cov-group"><h3>${g === 'all' ? 'Unified (all agents)' : esc(agentLabel(g))} <span class="hint" style="color:var(--muted);font-weight:400">${esc(c.commands.find((x) => x.group === g).groupDescription)}</span></h3><div class="cov-cmds">
			${c.commands.filter((x) => x.group === g).map((x) => `<div class="cov-cmd"><div class="top"><b class="mono">ccusage ${esc(x.path.join(' '))}</b><div style="flex:1"></div><a class="btn small" href="#/r/${x.path.join('/')}">Open</a></div>
				<div style="color:var(--muted);font-size:12.5px;margin-bottom:6px">${esc(x.description)}</div>
				<div class="flags">${x.flags.map((f) => `<span class="tag" title="${esc(auto[f.name] ? `Handled by: ${auto[f.name]}` : f.description)}">${auto[f.name] ? '◆' : '✓'} --${esc(f.name)}${f.negatable ? ' / --no-' + esc(f.name) : ''}</span>`).join('')}</div></div>`).join('')}
		</div></div>`).join('')}
		<p style="color:var(--muted);font-size:12.5px">✓ editable control in the options panel · ◆ handled by the view switcher</p>`;
}

// ---------- boot ----------

async function boot() {
	const theme = store.get('theme', null);
	if (theme) document.documentElement.dataset.theme = theme;
	try {
		state.catalog = await api('/api/catalog');
	} catch (e) {
		main().innerHTML = `<div class="err">Could not reach the local server: ${esc(e.message)}</div>`;
		return;
	}
	buildSidebar();
	window.addEventListener('hashchange', render);
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => !document.documentElement.dataset.theme && render());
	render();
}

boot();
