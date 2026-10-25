/* global Chart */

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

const charts = new WeakMap();

function theme() {
	return {
		ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'),
		grid: cssVar('--grid'), axis: cssVar('--axis'), surface: cssVar('--surface'), surface2: cssVar('--surface-2'),
	};
}

export function destroyCharts(root) {
	for (const c of $$('canvas', root)) charts.get(c)?.destroy();
}

/**
 * series: [{ label, color, data: number[] }]
 */
export function barChart(canvas, { labels, series, stacked = true, format = fmtUSD, horizontal = false, onClick, tooltipTitle }) {
	charts.get(canvas)?.destroy();
	const t = theme();
	const valueAxis = {
		stacked, beginAtZero: true,
		grid: { color: t.grid, drawTicks: false },
		border: { display: false },
		ticks: { color: t.muted, padding: 8, callback: (v) => format(v), maxTicksLimit: 6, font: { size: 11 } },
	};
	const catAxis = {
		stacked,
		grid: { display: false },
		border: { color: t.axis },
		ticks: { color: t.muted, font: { size: 11 }, autoSkip: !horizontal, maxRotation: 0, autoSkipPadding: 12 },
	};
	const chart = new Chart(canvas, {
		type: 'bar',
		data: {
			labels,
			datasets: series.map((s, i) => ({
				label: s.label, data: s.data, backgroundColor: s.color, hoverBackgroundColor: s.color,
				borderColor: t.surface, borderWidth: stacked ? (horizontal ? { right: 2 } : { top: 2 }) : 0,
				borderRadius: i === series.length - 1 || !stacked ? 4 : 0, borderSkipped: 'start',
				maxBarThickness: horizontal ? 18 : 28, categoryPercentage: 0.8, barPercentage: 0.9,
			})),
		},
		options: {
			indexAxis: horizontal ? 'y' : 'x',
			responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
			interaction: { mode: 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
			onClick: onClick ? (e, els) => els[0] && onClick(els[0].index) : undefined,
			onHover: onClick ? (e, els) => (e.native.target.style.cursor = els.length ? 'pointer' : 'default') : undefined,
			scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
			plugins: {
				legend: { display: false },
				tooltip: {
					backgroundColor: t.surface, titleColor: t.ink, bodyColor: t.ink2, borderColor: t.grid, borderWidth: 1,
					padding: 10, boxPadding: 4, usePointStyle: true, cornerRadius: 8,
					filter: (item) => item.raw > 0,
					itemSort: (a, b) => b.raw - a.raw,
					callbacks: {
						title: tooltipTitle ? (items) => tooltipTitle(items[0].dataIndex) : undefined,
						label: (c) => ` ${c.dataset.label}: ${format(c.raw)}`,
						footer: (items) => (items.length > 1 ? `Total: ${format(items.reduce((s, i) => s + i.raw, 0))}` : ''),
					},
					footerColor: t.ink,
				},
			},
		},
	});
	charts.set(canvas, chart);
	return chart;
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
