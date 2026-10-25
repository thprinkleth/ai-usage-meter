// Normalizes every ccusage JSON shape (unified, claude, codex, other agents) into one row model.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function tokenFields(r) {
	return {
		input: num(r.inputTokens),
		output: num(r.outputTokens),
		cacheCreate: num(r.cacheCreationTokens ?? r.cacheCreationInputTokens),
		cacheRead: num(r.cacheReadTokens ?? r.cacheReadInputTokens),
		reasoning: num(r.reasoningOutputTokens ?? r.metadata?.reasoningOutputTokens),
		total: num(r.totalTokens),
	};
}

function costOf(r) {
	for (const k of ['totalCost', 'costUSD', 'cost']) if (typeof r[k] === 'number') return r[k];
	return null;
}

function models(r) {
	if (Array.isArray(r.modelBreakdowns)) {
		return r.modelBreakdowns.map((m) => {
			const t = tokenFields(m);
			if (!t.total) t.total = t.input + t.output + t.cacheCreate + t.cacheRead;
			return { name: m.modelName, cost: costOf(m), ...t };
		});
	}
	if (r.models && typeof r.models === 'object' && !Array.isArray(r.models)) {
		return Object.entries(r.models).map(([name, m]) => ({ name, cost: costOf(m), isFallback: !!m.isFallback, ...tokenFields(m) }));
	}
	if (Array.isArray(r.models)) return r.models.map((name) => ({ name, cost: null, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, reasoning: 0, total: 0 }));
	return [];
}

const LABEL_KEYS = ['date', 'week', 'month', 'period', 'sessionId', 'id'];

export function normalizeRow(r, extra = {}) {
	const labelKey = LABEL_KEYS.find((k) => typeof r[k] === 'string');
	const row = {
		key: r[labelKey] ?? '',
		label: r[labelKey] ?? '',
		agent: r.agent && r.agent !== 'all' ? r.agent : null,
		agentsUsed: r.metadata?.agents ?? (r.agent && r.agent !== 'all' ? [r.agent] : []),
		cost: costOf(r),
		...tokenFields(r),
		models: models(r),
		agents: Array.isArray(r.agents) ? r.agents.map((a) => normalizeRow(a)) : [],
		project: r.projectPath ?? r.project ?? null,
		firstActivity: r.firstActivity ?? r.metadata?.firstActivity ?? null,
		lastActivity: r.lastActivity ?? r.metadata?.lastActivity ?? null,
		file: r.sessionFile ?? null,
		directory: r.directory ?? null,
		raw: r,
		...extra,
	};
	if (!row.total) row.total = row.input + row.output + row.cacheCreate + row.cacheRead;
	return row;
}

export function sessionLabel(row) {
	const id = String(row.label);
	const m = id.match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}-([0-9a-f]{8})/);
	if (m) return `${m[1]} ${m[2]}:${m[3]} · ${m[4]}`;
	return id.length > 40 ? id.slice(0, 8) + '…' + id.slice(-6) : id;
}

export function prettyProject(p) {
	if (!p) return '';
	// Claude stores projects as the cwd with path separators replaced by dashes.
	const [base, worktree] = String(p).split('--claude-worktrees-');
	const name = base
		.replace(/^[a-zA-Z]--/, '')
		.replace(/^(Users|home)-[^-]+-/i, '')
		.replace(/^Documents-/i, '') || base;
	return worktree ? `${name} ⎇ ${worktree}` : name;
}

export function normalizeReport(json) {
	if (!json || typeof json !== 'object') return null;
	const totals = json.totals ? normalizeRow(json.totals) : null;
	if (Array.isArray(json.blocks)) {
		return { kind: 'blocks', blocks: json.blocks, totals, sections: [] };
	}
	if (json.projects && typeof json.projects === 'object') {
		const rows = [];
		for (const [project, list] of Object.entries(json.projects)) for (const r of list) rows.push(normalizeRow(r, { project }));
		return { kind: 'instances', totals, sections: [{ key: 'projects', kind: 'period', rows }], projects: Object.keys(json.projects) };
	}
	const sections = [];
	for (const [key, val] of Object.entries(json)) {
		if (!Array.isArray(val)) continue;
		sections.push({ key, kind: key.startsWith('session') ? 'session' : 'period', rows: val.map((r) => normalizeRow(r)) });
	}
	return { kind: sections.length > 1 ? 'sections' : sections[0]?.kind ?? 'period', totals, sections };
}

export function sumRows(rows) {
	const t = { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, reasoning: 0, total: 0, hasCost: false };
	for (const r of rows) {
		if (r.cost != null) { t.cost += r.cost; t.hasCost = true; }
		for (const k of ['input', 'output', 'cacheCreate', 'cacheRead', 'reasoning', 'total']) t[k] += r[k];
	}
	if (!t.hasCost) t.cost = null;
	return t;
}

export const TOKEN_TYPES = [
	{ key: 'input', label: 'Input' },
	{ key: 'output', label: 'Output' },
	{ key: 'cacheCreate', label: 'Cache write' },
	{ key: 'cacheRead', label: 'Cache read' },
	{ key: 'reasoning', label: 'Reasoning' },
];

export function toCSV(rows) {
	const cols = ['label', 'agent', 'project', 'cost', 'input', 'output', 'cacheCreate', 'cacheRead', 'reasoning', 'total', 'lastActivity'];
	const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
	const lines = [cols.join(',') + ',models'];
	for (const r of rows) lines.push(cols.map((c) => q(r[c])).join(',') + ',' + q(r.models.map((m) => m.name).join(' ')));
	return lines.join('\n');
}
