export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function h(html) {
	const t = document.createElement('template');
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
}

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const fmtUSD = (v) => (v == null ? '—' : Math.abs(v) >= 10000 ? usd0.format(v) : usd2.format(v));
export const fmtInt = (v) => (v == null ? '—' : int.format(Math.round(v)));
export const fmtTok = (v) => (v == null ? '—' : compact.format(v));
export const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);

export function fmtDate(iso, opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) {
	if (!iso) return '—';
	const d = new Date(iso);
	return Number.isNaN(+d) ? iso : d.toLocaleString(undefined, opts);
}

export function fmtDuration(min) {
	if (min == null) return '—';
	const h = Math.floor(min / 60), m = Math.round(min % 60);
	return h ? `${h}h ${m}m` : `${m}m`;
}

export function shortModel(name) {
	return String(name).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// ---------- color registry: color follows the entity, assigned in fixed slot order ----------

const SLOTS = 8;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const registries = new Map();
const AGENT_ORDER = ['codex', 'claude'];

export function slotOf(kind, name) {
	if (!registries.has(kind)) registries.set(kind, new Map());
	const reg = registries.get(kind);
	if (kind === 'agent' && !reg.size) AGENT_ORDER.forEach((a, i) => reg.set(a, i));
	if (!reg.has(name)) reg.set(name, reg.size < SLOTS ? reg.size : -1);
	return reg.get(name);
}

export function colorOf(kind, name) {
	const s = slotOf(kind, name);
	return s < 0 ? cssVar('--other') : cssVar(`--s${s + 1}`);
}

// Register models by importance so the biggest spenders claim the first slots.
export function registerModels(modelTotals, kind = 'model') {
	[...modelTotals].sort((a, b) => b[1] - a[1]).forEach(([n]) => slotOf(kind, n));
}

export const agentLabel = (a) => ({ claude: 'Claude Code', codex: 'Codex', all: 'All agents' })[a] ?? (a ? a[0].toUpperCase() + a.slice(1) : '');

// ---------- charts ----------

export function destroyCharts(root) {
	for (const el of $$('.chart', root)) el._chart?.destroy();
}

function niceStep(max, count = 5) {
	const raw = max / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const n = raw / mag;
	return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

const textWidth = (s) => String(s).length * 6.4;

// Bar with only its far end rounded; (x, y) is the top-left corner.
function barPath(x, y, w, hgt, r, horizontal) {
	r = Math.max(0, Math.min(r, w / 2, hgt / 2));
	if (horizontal) return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
	return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function tipHtml(title, rows, format) {
	const total = rows.reduce((s, r) => s + r.value, 0);
	return `<div class="tt-title">${esc(title)}</div>` +
		(rows.length ? rows.map((r) => `<div class="tt-row"><i class="swatch" style="background:${r.color}"></i><span>${esc(r.label)}</span><b>${esc(format(r.value))}</b></div>`).join('') : '<div class="tt-row"><span>No usage</span></div>') +
		(rows.length > 1 ? `<div class="tt-row tt-total"><span>Total</span><b>${esc(format(total))}</b></div>` : '');
}

function placeTip(tip, host, e) {
	const r = host.getBoundingClientRect();
	const x = e.clientX - r.left, y = e.clientY - r.top;
	const tw = tip.offsetWidth, th = tip.offsetHeight;
	tip.style.left = `${x + 14 + tw > r.width ? Math.max(0, x - 14 - tw) : x + 14}px`;
	tip.style.top = `${Math.max(0, Math.min(r.height - th, y - th / 2))}px`;
}

/**
 * Inline-SVG bar chart. Canvas-free on purpose: GPU canvas bugs, fingerprinting
 * protection and page-recoloring extensions can blank a <canvas> in some browsers.
 * series: [{ label, color, data: number[] }]
 */
export function barChart(host, { labels, series, stacked = true, format = fmtUSD, horizontal = false, onClick, tooltipTitle, barColors }) {
	host._chart?.destroy();
	const hidden = new Set();
	const tip = h('<div class="chart-tip" hidden></div>');
	let geo = null;

	const visible = () => series.map((_, i) => i).filter((i) => !hidden.has(i));
	const valueAt = (i, si) => Math.max(0, Number(series[si].data[i]) || 0);

	function draw() {
		const W = host.clientWidth, H = host.clientHeight;
		if (!W || !H) return;
		const vis = visible();
		const n = labels.length;
		const totals = labels.map((_, i) => (stacked ? vis.reduce((s, si) => s + valueAt(i, si), 0) : Math.max(0, ...vis.map((si) => valueAt(i, si)))));
		const step = niceStep(Math.max(...totals, 0) || 1);
		const top = Math.ceil((Math.max(...totals, 0) || 1) / step) * step;
		const ticks = [];
		for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
		const pad = horizontal
			? { t: 4, r: 12, b: 22, l: Math.min(240, Math.max(0, ...labels.map(textWidth)) + 12) }
			: { t: 8, r: 8, b: 24, l: Math.max(...ticks.map((v) => textWidth(format(v)))) + 12 };
		const pw = Math.max(10, W - pad.l - pad.r), ph = Math.max(10, H - pad.t - pad.b);
		const band = (horizontal ? ph : pw) / Math.max(n, 1);
		const groups = stacked ? 1 : Math.max(vis.length, 1);
		const thick = Math.min(horizontal ? 18 : 28, band * 0.78);
		const scale = (v) => (v / top) * (horizontal ? pw : ph);
		const out = [];

		for (const v of ticks) {
			if (horizontal) {
				const x = pad.l + scale(v);
				out.push(`<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${pad.t + ph}" style="stroke:var(--grid)"/>`);
				out.push(`<text x="${x}" y="${H - 6}" text-anchor="middle" class="ct">${esc(format(v))}</text>`);
			} else {
				const y = pad.t + ph - scale(v);
				out.push(`<line x1="${pad.l}" x2="${pad.l + pw}" y1="${y}" y2="${y}" style="stroke:var(--grid)"/>`);
				out.push(`<text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" class="ct">${esc(format(v))}</text>`);
			}
		}
		out.push(`<rect class="hl" x="0" y="0" width="0" height="0" rx="6" style="fill:var(--surface-2)" />`);

		const every = horizontal ? Math.max(1, Math.ceil(14 / band)) : Math.max(1, Math.ceil((Math.max(0, ...labels.map(textWidth)) + 14) / band));
		labels.forEach((l, i) => {
			if (i % every) return;
			const c = (horizontal ? pad.t : pad.l) + band * i + band / 2;
			const s = horizontal && textWidth(l) > pad.l - 12 ? String(l).slice(0, Math.floor((pad.l - 12) / 6.4) - 1) + '…' : l;
			out.push(horizontal
				? `<text x="${pad.l - 8}" y="${c + 4}" text-anchor="end" class="ct">${esc(s)}</text>`
				: `<text x="${c}" y="${H - 6}" text-anchor="middle" class="ct">${esc(s)}</text>`);
		});

		labels.forEach((_, i) => {
			const c = (horizontal ? pad.t : pad.l) + band * i + band / 2;
			const segs = vis.filter((si) => valueAt(i, si) > 0);
			let acc = 0;
			segs.forEach((si, k) => {
				const len = scale(valueAt(i, si));
				const gap = stacked && k > 0 ? 2 : 0;
				const w = thick / groups;
				const offset = stacked ? 0 : (vis.indexOf(si) - (groups - 1) / 2) * w;
				const from = (stacked ? acc : 0) + gap;
				const size = Math.max(0.5, len - gap);
				const r = !stacked || k === segs.length - 1 ? 4 : 0;
				const fill = barColors?.[i] ?? series[si].color;
				const d = horizontal
					? barPath(pad.l + from, c - w / 2 + offset, size, w, r, true)
					: barPath(c - w / 2 + offset, pad.t + ph - from - size, w, size, r, false);
				out.push(`<path d="${d}" style="fill:${fill}"/>`);
				acc += len;
			});
		});
		out.push(horizontal
			? `<line x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${pad.t + ph}" style="stroke:var(--axis)"/>`
			: `<line x1="${pad.l}" x2="${pad.l + pw}" y1="${pad.t + ph}" y2="${pad.t + ph}" style="stroke:var(--axis)"/>`);

		host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${out.join('')}</svg>`;
		host.append(tip);
		geo = { pad, pw, ph, band, n, W, H };
		if (onClick) host.style.cursor = 'pointer';
	}

	function indexAt(e) {
		if (!geo) return -1;
		const r = host.getBoundingClientRect();
		const pos = horizontal ? e.clientY - r.top - geo.pad.t : e.clientX - r.left - geo.pad.l;
		const i = Math.floor(pos / geo.band);
		return i >= 0 && i < geo.n ? i : -1;
	}

	function onMove(e) {
		const i = indexAt(e);
		const hl = host.querySelector('.hl');
		if (i < 0) { tip.hidden = true; hl?.setAttribute('width', 0); return; }
		const { pad, pw, ph, band } = geo;
		if (hl) {
			if (horizontal) Object.entries({ x: pad.l, y: pad.t + band * i, width: pw, height: band }).forEach(([k, v]) => hl.setAttribute(k, v));
			else Object.entries({ x: pad.l + band * i, y: pad.t, width: band, height: ph }).forEach(([k, v]) => hl.setAttribute(k, v));
		}
		const rows = visible().map((si) => ({ label: series[si].label, color: barColors?.[i] ?? series[si].color, value: valueAt(i, si) })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
		tip.innerHTML = tipHtml(tooltipTitle ? tooltipTitle(i) : labels[i], rows, format);
		tip.hidden = false;
		placeTip(tip, host, e);
	}

	const onLeave = () => { tip.hidden = true; host.querySelector('.hl')?.setAttribute('width', 0); };
	const onClickHandler = (e) => { const i = indexAt(e); if (i >= 0) onClick(i); };
	host.addEventListener('mousemove', onMove);
	host.addEventListener('mouseleave', onLeave);
	if (onClick) host.addEventListener('click', onClickHandler);
	const ro = new ResizeObserver(() => draw());
	ro.observe(host);
	draw();

	const chart = {
		isDatasetVisible: (i) => !hidden.has(i),
		setDatasetVisibility: (i, v) => (v ? hidden.delete(i) : hidden.add(i)),
		update: draw,
		destroy() {
			ro.disconnect();
			host.removeEventListener('mousemove', onMove);
			host.removeEventListener('mouseleave', onLeave);
			host.removeEventListener('click', onClickHandler);
			host._chart = null;
		},
	};
	host._chart = chart;
	return chart;
}

const dayKey = (d) => d.toLocaleDateString('en-CA');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Daily usage is heavy-tailed, so buckets are quantiles of active days: on a linear
// scale one huge day would wash every other day out to the palest step.
function heatScale(values, format) {
	const active = values.filter((v) => v > 0).sort((a, b) => a - b);
	const round2 = (v) => { const m = 10 ** (Math.floor(Math.log10(v)) - 1); return Math.round(v / m) * m; };
	const cuts = active.length
		? [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => round2(active[Math.floor(q * active.length)])))].filter((c) => c > active[0] && c <= active.at(-1))
		: [];
	const step = (i) => (cuts.length ? 1 + Math.round((i * 4) / cuts.length) : 3);
	const bucketLabel = (i) => (!cuts.length ? 'Any usage' : i ? `${format(cuts[i - 1])}+` : `< ${format(cuts[0])}`);
	return {
		level: (v) => (v > 0 ? step(cuts.filter((c) => v >= c).length) : 0),
		legend: [[0, 'No usage'], ...(active.length ? [...Array(cuts.length + 1).keys()].map((i) => [step(i), bucketLabel(i)]) : [])],
	};
}

const HEAT_GAP = 3;

/**
 * Shared heatmap grid. values: Map of cell key to number. detail(key): tooltip rows [{ label, color, value }].
 * layout(width) returns { left, top, pitchX, pitchY, cols, rows, labels, keyAt(col, row) }, where keyAt
 * gives null for a cell that shouldn't be drawn.
 */
function heatGrid(host, { values, format = fmtUSD, color, detail, title, onClick, label = '', layout }) {
	host._chart?.destroy();
	if (color) host.style.setProperty('--heat', color);
	const tip = h('<div class="chart-tip" hidden></div>');
	const scale = heatScale([...values.values()], format);
	const legend = `<div class="legend">${scale.legend.map(([l, text]) => `<span><i class="swatch" style="background:var(--h${l})"></i>${esc(text)}</span>`).join('')}</div>`;
	let geo = null;

	function draw() {
		const W = host.clientWidth;
		if (!W) return;
		geo = layout(W);
		const { left, top, pitchX, pitchY, cols, rows, labels, keyAt } = geo;
		const cellW = pitchX - HEAT_GAP, cellH = pitchY - HEAT_GAP;
		const out = [labels];
		for (let c = 0; c < cols; c++) {
			for (let r = 0; r < rows; r++) {
				const k = keyAt(c, r);
				if (k != null) out.push(`<rect x="${left + c * pitchX}" y="${top + r * pitchY}" width="${cellW}" height="${cellH}" rx="3" style="fill:var(--h${scale.level(values.get(k) ?? 0)})"/>`);
			}
		}
		out.push(`<rect class="hm-hl" width="${cellW}" height="${cellH}" rx="3" fill="none" visibility="hidden" style="stroke:var(--ink)"/>`);
		const H = top + pitchY * rows - HEAT_GAP;
		host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${out.join('')}</svg>${legend}`;
		host.append(tip);
	}

	function cellAt(e) {
		if (!geo) return null;
		const b = host.getBoundingClientRect();
		const c = Math.floor((e.clientX - b.left - geo.left) / geo.pitchX);
		const r = Math.floor((e.clientY - b.top - geo.top) / geo.pitchY);
		if (c < 0 || c >= geo.cols || r < 0 || r >= geo.rows) return null;
		const key = geo.keyAt(c, r);
		return key == null ? null : { c, r, key };
	}

	const onLeave = () => {
		tip.hidden = true;
		host.querySelector('.hm-hl')?.setAttribute('visibility', 'hidden');
		host.style.cursor = '';
	};

	function onMove(e) {
		const cell = cellAt(e);
		if (!cell) return onLeave();
		const v = values.get(cell.key) ?? 0;
		const hl = host.querySelector('.hm-hl');
		hl.setAttribute('x', geo.left + cell.c * geo.pitchX);
		hl.setAttribute('y', geo.top + cell.r * geo.pitchY);
		hl.removeAttribute('visibility');
		tip.innerHTML = tipHtml(title(cell.key), v > 0 ? detail(cell.key) : [], format);
		tip.hidden = false;
		placeTip(tip, host, e);
		host.style.cursor = onClick && v > 0 ? 'pointer' : '';
	}

	const onClickHandler = (e) => {
		const cell = cellAt(e);
		if (cell && (values.get(cell.key) ?? 0) > 0) onClick(cell.key);
	};
	host.addEventListener('mousemove', onMove);
	host.addEventListener('mouseleave', onLeave);
	if (onClick) host.addEventListener('click', onClickHandler);
	const ro = new ResizeObserver(() => draw());
	ro.observe(host);
	draw();

	const chart = {
		update: draw,
		destroy() {
			ro.disconnect();
			host.removeEventListener('mousemove', onMove);
			host.removeEventListener('mouseleave', onLeave);
			host.removeEventListener('click', onClickHandler);
			host._chart = null;
		},
	};
	host._chart = chart;
	return chart;
}

/**
 * Calendar heatmap: one column per week (Monday first), newest week on the right,
 * showing as many trailing weeks of start..end as fit the width. Cell keys are 'YYYY-MM-DD'.
 */
export function calendarHeatmap(host, { start, end, values, ...opts }) {
	const monday = (key) => { const d = new Date(`${key}T12:00`); return addDays(d, -((d.getDay() + 6) % 7)); };
	const lastWeek = monday(end);
	const totalWeeks = Math.round((lastWeek - monday(start)) / 6048e5) + 1;
	const left = 32, top = 18;
	return heatGrid(host, {
		...opts,
		values: new Map([...values].filter(([k]) => k >= start && k <= end)),
		title: (k) => new Date(`${k}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
		layout(W) {
			const cols = Math.max(1, Math.min(totalWeeks, Math.floor((W - left) / 12)));
			const pitch = Math.min(26, (W - left) / cols);
			const first = addDays(lastWeek, -7 * (cols - 1));
			const labels = [];
			const months = [];
			for (let c = 0; c < cols; c++) {
				const d = addDays(first, c * 7);
				if (!months.length || d.getMonth() !== months.at(-1).d.getMonth()) months.push({ c, d });
			}
			if (months.length > 1 && (months[1].c - months[0].c) * pitch < 28) months.shift();
			for (const { c, d } of months) labels.push(`<text x="${left + c * pitch}" y="11" class="ct">${esc(d.toLocaleDateString(undefined, { month: 'short' }))}</text>`);
			for (const r of [0, 2, 4]) labels.push(`<text x="${left - 6}" y="${top + r * pitch + (pitch - HEAT_GAP) / 2 + 4}" text-anchor="end" class="ct">${esc(addDays(first, r).toLocaleDateString(undefined, { weekday: 'short' }))}</text>`);
			return {
				left, top, pitchX: pitch, pitchY: pitch, cols, rows: 7, labels: labels.join(''),
				keyAt(c, r) {
					const k = dayKey(addDays(first, c * 7 + r));
					return k < start || k > end ? null : k;
				},
			};
		},
	});
}

// January 2024 starts on a Monday, so day 0 of this reference week is Monday.
const weekTime = (day, hour = 0) => new Date(2024, 0, 1 + day, hour);
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

export const weekHourLabel = (day, hour) => `${weekTime(day).toLocaleDateString(undefined, { weekday: 'short' })} ${hourFormat.formatRange(weekTime(day, hour), weekTime(day, hour + 1))}`;

/** Punch-card heatmap: weekdays down (Monday first), hours across. Cell keys are 'day:hour'. */
export function hourHeatmap(host, opts) {
	const left = 36, top = 18, pitchY = 24;
	return heatGrid(host, {
		...opts,
		title: (k) => { const [d, hr] = k.split(':').map(Number); return weekHourLabel(d, hr); },
		layout(W) {
			const pitchX = (W - left) / 24;
			const every = [1, 2, 3, 4, 6].find((n) => n * pitchX >= 36) ?? 12;
			const labels = [];
			for (let hr = 0; hr < 24; hr += every) labels.push(`<text x="${left + hr * pitchX}" y="11" class="ct">${esc(hourFormat.format(weekTime(0, hr)))}</text>`);
			for (let d = 0; d < 7; d++) labels.push(`<text x="${left - 6}" y="${top + d * pitchY + (pitchY - HEAT_GAP) / 2 + 4}" text-anchor="end" class="ct">${esc(weekTime(d).toLocaleDateString(undefined, { weekday: 'short' }))}</text>`);
			return { left, top, pitchX, pitchY, cols: 24, rows: 7, labels: labels.join(''), keyAt: (c, r) => `${r}:${c}` };
		},
	});
}

export function legendHtml(series, chart) {
	const el = h(`<div class="legend"></div>`);
	series.forEach((s, i) => {
		const b = h(`<button title="Toggle ${esc(s.label)}"><i class="swatch" style="background:${s.color}"></i>${esc(s.label)}</button>`);
		b.onclick = () => {
			const vis = chart.isDatasetVisible(i);
			chart.setDatasetVisibility(i, !vis);
			b.classList.toggle('off', vis);
			chart.update();
		};
		el.append(b);
	});
	return el;
}

/** Horizontal HTML bar list – readable labels, values on the right. */
export function barList(items, { format = fmtUSD, max } = {}) {
	const top = max ?? Math.max(...items.map((i) => i.value), 0);
	return `<div class="barlist">${items.map((i) => `
		<div class="bl-row" title="${esc(i.title ?? i.label)}">
			<div class="bl-label">${i.swatch ? `<i class="swatch" style="background:${i.swatch}"></i>` : ''}<span>${esc(i.label)}</span>${i.tag ? `<span class="tag">${esc(i.tag)}</span>` : ''}</div>
			<div class="bl-val">${format(i.value)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</div>
			<div class="bl-track"><i style="width:${top ? Math.max(0.6, (i.value / top) * 100) : 0}%;background:${i.color ?? 'var(--s1)'}"></i></div>
		</div>`).join('')}</div>`;
}

let toastTimer;
export function toast(msg) {
	let t = $('.toast');
	if (!t) { t = h('<div class="toast"></div>'); document.body.append(t); }
	t.textContent = msg;
	t.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

export function download(name, text, type = 'application/json') {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type }));
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function copy(text) {
	try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed'); }
}

export const ICONS = {
	overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
	layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',
	clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
	term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M12 15h5"/></svg>',
	check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
	refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
	copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
	download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/></svg>',
	sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
	grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
};
