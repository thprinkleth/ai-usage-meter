// Per-message timing from Claude Code transcripts, which ccusage doesn't expose: it rounds block
// starts down to the hour and has no hourly report. Only timestamps and token counts are kept.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const READ_CHUNK = 1 << 20;
const USAGE_KEY = Buffer.from('"usage"');
const USER_TYPE = Buffer.from('"type":"user"');
const MAX_PROMPT_TO_REPLY_MS = 30 * 6e4;

// Observed from real limit resets: the window ends 5h after the first request, floored to 10 minutes.
const WINDOW_SNAP_MS = 10 * 6e4;
// A prompt is logged just before its request reaches the server. Without this, a prompt logged at
// 18:59:59 snaps its window, and every window chained after it, 10 minutes too early.
const REQUEST_LATENCY_MS = 2000;

// Anthropic's relative token prices. Only used to split one hour's cost between its messages.
const priceWeight = (m) => m.input + 5 * m.output + 1.25 * m.cacheWrite + 0.1 * m.cacheRead;
const tokensOf = (m) => m.input + m.output + m.cacheWrite + m.cacheRead;

async function findTranscripts(dir, out = []) {
	for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) await findTranscripts(p, out);
		else if (e.name.endsWith('.jsonl')) out.push(p);
	}
	return out;
}

function priceMessages(messages, hourlyBlocks) {
	const slots = hourlyBlocks
		.filter((b) => !b.isGap)
		.map((b) => ({ start: Date.parse(b.startTime), end: Date.parse(b.endTime), cost: b.costUSD ?? 0, weight: 0 }))
		.sort((a, b) => a.start - b.start);
	const byTime = [...messages].sort((a, b) => a.ts - b.ts);
	let i = 0;
	const slotOf = byTime.map((m) => {
		while (i < slots.length && m.ts > slots[i].end) i++;
		const slot = slots[i] && m.ts >= slots[i].start ? slots[i] : null;
		if (slot) slot.weight += priceWeight(m);
		return slot;
	});
	byTime.forEach((m, k) => {
		const slot = slotOf[k];
		m.cost = slot?.weight ? (slot.cost * priceWeight(m)) / slot.weight : 0;
	});
}

function toBlock(w, now) {
	const minutes = (w.last - w.start) / 6e4;
	const totalTokens = w.input + w.output + w.cacheWrite + w.cacheRead;
	const burnRate = minutes > 0
		? { costPerHour: (w.cost / minutes) * 60, tokensPerMinute: totalTokens / minutes, tokensPerMinuteForIndicator: (w.input + w.output) / minutes }
		: null;
	const isActive = now < w.end;
	const remainingMinutes = Math.round((w.end - now) / 6e4);
	return {
		id: new Date(w.start).toISOString(),
		startTime: new Date(w.start).toISOString(),
		endTime: new Date(w.end).toISOString(),
		actualEndTime: new Date(w.last).toISOString(),
		isActive,
		isGap: false,
		entries: w.entries,
		tokenCounts: { inputTokens: w.input, outputTokens: w.output, cacheCreationInputTokens: w.cacheWrite, cacheReadInputTokens: w.cacheRead },
		totalTokens,
		costUSD: w.cost,
		models: [...w.models].sort(),
		burnRate,
		projection: isActive && burnRate
			? { remainingMinutes, totalCost: Math.round((w.cost + (burnRate.costPerHour / 60) * remainingMinutes) * 100) / 100, totalTokens: Math.round(totalTokens + burnRate.tokensPerMinute * remainingMinutes) }
			: null,
	};
}

function gapBlock(prev, next) {
	return {
		id: `gap-${new Date(prev.end).toISOString()}`,
		startTime: new Date(prev.end).toISOString(),
		endTime: new Date(next.start).toISOString(),
		actualEndTime: null,
		isActive: false,
		isGap: true,
		entries: 0,
		tokenCounts: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
		totalTokens: 0,
		costUSD: 0,
		models: [],
		burnRate: null,
		projection: null,
	};
}

function buildBlocks(messages, windowMs, now) {
	const windows = [];
	let cur = null;
	for (const m of [...messages].sort((a, b) => a.at - b.at)) {
		if (!cur || m.at >= cur.end) {
			const snapped = Math.floor((m.at + REQUEST_LATENCY_MS) / WINDOW_SNAP_MS) * WINDOW_SNAP_MS;
			cur = { start: m.at, end: snapped + windowMs, last: m.ts, entries: 0, cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, models: new Set() };
			windows.push(cur);
		}
		cur.last = Math.max(cur.last, m.ts);
		cur.entries++;
		cur.cost += m.cost;
		cur.input += m.input;
		cur.output += m.output;
		cur.cacheWrite += m.cacheWrite;
		cur.cacheRead += m.cacheRead;
		cur.models.add(m.model);
	}
	const blocks = [];
	windows.forEach((w, i) => {
		const prev = windows[i - 1];
		if (prev && w.start - prev.last > windowMs) blocks.push(gapBlock(prev, w));
		blocks.push(toBlock(w, now));
	});
	return blocks;
}

function buildHours(messages) {
	const hours = new Map();
	for (const m of messages) {
		const t = new Date(m.ts).setMinutes(0, 0, 0);
		const models = hours.get(t) ?? {};
		const [cost, tokens] = models[m.model] ?? [0, 0];
		models[m.model] = [cost + m.cost, tokens + tokensOf(m)];
		hours.set(t, models);
	}
	return [...hours].sort((a, b) => a[0] - b[0]).map(([t, models]) => ({ t, models }));
}

/** Applies ccusage's report filters to blocks built from the full history, so chained windows stay right. */
export function selectBlocks(blocks, { since, until, active, recent, order, timezone } = {}, now = Date.now()) {
	const day = (iso) => new Date(iso).toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : undefined).replaceAll('-', '');
	let out = blocks.filter((b) => (!since || day(b.startTime) >= since) && (!until || day(b.startTime) <= until));
	if (active) out = out.filter((b) => b.isActive);
	if (recent) out = out.filter((b) => b.isActive || now - Date.parse(b.startTime) <= 3 * 864e5);
	return order === 'desc' ? out.reverse() : out;
}

export function createClaudeUsage(getRoots) {
	const files = new Map();
	const messages = new Map();
	let scanning = null;

	function onLine(line, file) {
		const hasUsage = line.includes(USAGE_KEY);
		if (!hasUsage && !line.includes(USER_TYPE)) return;
		let o;
		try { o = JSON.parse(line.toString('utf8')); } catch { return; }
		if (o.type === 'user') {
			if (o.timestamp) file.lastPrompt = Date.parse(o.timestamp);
			return;
		}
		const u = o.message?.usage;
		if (!u || o.type !== 'assistant' || !o.message.id || !o.requestId || o.message.model === '<synthetic>') return;
		const ts = Date.parse(o.timestamp);
		const promptAge = ts - (file.lastPrompt ?? Infinity);
		const at = promptAge >= 0 && promptAge < MAX_PROMPT_TO_REPLY_MS ? file.lastPrompt : ts;
		// One reply spans several streamed lines; taking each field's max reproduces ccusage's totals exactly.
		const key = `${o.message.id}:${o.requestId}`;
		const m = messages.get(key) ?? { ts, at, model: o.message.model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
		m.ts = Math.min(m.ts, ts);
		m.at = Math.min(m.at, at);
		m.input = Math.max(m.input, u.input_tokens ?? 0);
		m.output = Math.max(m.output, u.output_tokens ?? 0);
		m.cacheWrite = Math.max(m.cacheWrite, u.cache_creation_input_tokens ?? 0);
		m.cacheRead = Math.max(m.cacheRead, u.cache_read_input_tokens ?? 0);
		messages.set(key, m);
	}

	// Transcripts are append-only, so only bytes past the last complete line need reading.
	async function readNewLines(p, file) {
		const fh = await open(p, 'r');
		try {
			const buf = Buffer.allocUnsafe(READ_CHUNK);
			let pos = file.offset, partial = null;
			for (;;) {
				const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, pos);
				if (!bytesRead) break;
				pos += bytesRead;
				const chunk = buf.subarray(0, bytesRead);
				let start = 0, nl;
				while ((nl = chunk.indexOf(10, start)) !== -1) {
					onLine(partial ? Buffer.concat([partial, chunk.subarray(start, nl)]) : chunk.subarray(start, nl), file);
					partial = null;
					start = nl + 1;
				}
				if (start < bytesRead) partial = partial ? Buffer.concat([partial, chunk.subarray(start)]) : Buffer.from(chunk.subarray(start));
			}
			file.offset = pos - (partial?.length ?? 0);
		} finally {
			await fh.close();
		}
	}

	async function scanAll() {
		for (const root of getRoots()) {
			for (const p of await findTranscripts(root)) {
				const s = await stat(p).catch(() => null);
				if (!s) continue;
				const file = files.get(p) ?? { offset: 0, lastPrompt: null };
				files.set(p, file);
				if (s.size < file.offset) file.offset = 0;
				if (s.size > file.offset) await readNewLines(p, file).catch(() => {});
			}
		}
	}

	return {
		scan() {
			scanning ??= scanAll().finally(() => { scanning = null; });
			return scanning;
		},
		/** hourlyBlocks: `ccusage claude blocks --session-length 1`, the source of every cost figure. */
		activity(hourlyBlocks, { windowHours = 5, now = Date.now() } = {}) {
			const list = [...messages.values()];
			priceMessages(list, hourlyBlocks);
			return { blocks: buildBlocks(list, windowHours * 36e5, now), hours: buildHours(list) };
		},
	};
}
