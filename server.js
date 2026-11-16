#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeUsage, selectBlocks } from './claude-usage.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4646);
const CACHE_MS = 20_000;
// ccusage re-parses every transcript on each run and uses every core, so a slow run is reused for
// at least this many times its own duration. That caps its CPU share at about 1/CACHE_RUN_FACTOR.
const CACHE_RUN_FACTOR = 10;
const MAX_CONCURRENT_RUNS = 1;

// Flags the server owns; the UI never sets these directly.
const SERVER_FLAGS = new Set(['help', 'version', 'color', 'no-color', 'json']);

function resolveCcusage() {
	const pkg = `@ccusage/ccusage-${process.platform}-${process.arch}`;
	try {
		const dir = path.dirname(require.resolve(`${pkg}/package.json`));
		const bin = path.join(dir, 'bin', process.platform === 'win32' ? 'ccusage.exe' : 'ccusage');
		if (existsSync(bin)) return { cmd: bin, pre: [] };
	} catch {}
	return { cmd: process.execPath, pre: [require.resolve('ccusage/src/cli.js')] };
}
const CC = resolveCcusage();
const CC_VERSION = require('ccusage/package.json').version;

let running = 0;
const waiting = [];
async function run(args, opts) {
	if (running >= MAX_CONCURRENT_RUNS) await new Promise((r) => waiting.push(r));
	running++;
	try {
		return await spawnCcusage(args, opts);
	} finally {
		running--;
		waiting.shift()?.();
	}
}

function spawnCcusage(args, { stdin, color = false, timeout = 300_000 } = {}) {
	return new Promise((resolve) => {
		const started = Date.now();
		const env = { ...process.env, COLUMNS: '240' };
		if (color) env.FORCE_COLOR = '1';
		else { delete env.FORCE_COLOR; env.NO_COLOR = '1'; }
		const child = spawn(CC.cmd, [...CC.pre, ...args], { env, windowsHide: true });
		// Idle priority starved runs whenever anything else was busy; below-normal still yields to foreground apps.
		try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
		let stdout = '', stderr = '';
		child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
		child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
		const timer = setTimeout(() => child.kill(), timeout);
		child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e), ms: Date.now() - started }); });
		child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
		if (stdin != null) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

// ---------- help parsing: the command/flag catalog is derived from ccusage itself ----------

function parseSection(text, name) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === `${name}:`);
	if (start < 0) return [];
	const out = [];
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i];
		if (!l.trim()) { if (out.length) break; continue; }
		if (/^\S/.test(l)) break;
		out.push(l);
	}
	return out;
}

function parseCommands(text) {
	return parseSection(text, 'COMMANDS')
		.map((l) => l.match(/^\s+(\S+)\s+(.*)$/))
		.filter(Boolean)
		.map(([, name, description]) => ({ name, description: description.trim() }));
}

function parseOptions(text) {
	const flags = [];
	for (const line of parseSection(text, 'OPTIONS')) {
		const m = line.match(/^\s+(?:-(\w),\s+)?--([\w-]+)(?:\s+([<[])([^>\]]+)[>\]])?\s+(.*)$/);
		if (!m) continue;
		const [, short, name, bracket, , rawDesc] = m;
		let description = rawDesc.trim();
		let def, choices;
		const meta = description.match(/\(((?:default: [^()]*?)?(?:,\s*)?(?:choices: [^()]*)?)\)\s*$/);
		if (meta && meta[1]) {
			const d = meta[1].match(/default: ([^,]*?)(?:,\s*choices:|$)/);
			const c = meta[1].match(/choices: (.*)$/);
			if (d) def = d[1].trim();
			if (c) choices = c[1].split('|').map((s) => s.trim());
			description = description.slice(0, meta.index).trim();
		}
		const negOf = description.match(/^Negatable of (?:-\w, )?--([\w-]+)/);
		flags.push({
			name,
			short: short || null,
			type: bracket ? (choices ? 'choice' : 'string') : 'boolean',
			optionalValue: bracket === '[',
			default: def ?? null,
			choices: choices ?? null,
			description,
			negates: negOf ? negOf[1] : null,
		});
	}
	// Fold "--no-x" negations into their base flag so a boolean can be turned off.
	const byName = new Map(flags.map((f) => [f.name, f]));
	for (const f of flags) if (f.negates && byName.has(f.negates)) byName.get(f.negates).negatable = true;
	return flags.filter((f) => !f.negates || !byName.has(f.negates));
}

let catalog = null;
async function buildCatalog() {
	const top = await run(['--help']);
	const groups = parseCommands(top.stdout);
	const commands = [];
	await Promise.all(groups.map(async (g) => {
		const h = await run([g.name, '--help']);
		const subs = parseCommands(h.stdout);
		if (subs.length) {
			await Promise.all(subs.map(async (s) => {
				const sh = await run([g.name, s.name, '--help']);
				commands.push({ path: [g.name, s.name], group: g.name, groupDescription: g.description, name: s.name, description: s.description, flags: parseOptions(sh.stdout), help: sh.stdout });
			}));
		} else {
			commands.push({ path: [g.name], group: 'all', groupDescription: 'All detected agents (unified)', name: g.name, description: g.description, flags: parseOptions(h.stdout), help: h.stdout });
		}
	}));
	const order = groups.map((g) => g.name);
	const subOrder = ['daily', 'weekly', 'monthly', 'session', 'blocks', 'statusline'];
	const rank = (c) => (c.group === 'all' ? -1 : order.indexOf(c.group)) * 100 + (subOrder.indexOf(c.name) + 1 || 50);
	commands.sort((a, b) => rank(a) - rank(b));
	catalog = { version: CC_VERSION, binary: CC.cmd, topHelp: top.stdout, commands };
	return catalog;
}

function findCommand(cmdPath) {
	const key = cmdPath.join(' ');
	return catalog.commands.find((c) => c.path.join(' ') === key);
}

const SAFE_VALUE = /^[\w .:/\\@,+=~()'-]*$/;

function buildArgs(cmd, flags = {}) {
	const args = [...cmd.path];
	for (const [name, value] of Object.entries(flags)) {
		if (SERVER_FLAGS.has(name)) continue;
		const spec = cmd.flags.find((f) => f.name === name);
		if (!spec) throw new Error(`Unknown flag --${name} for "${cmd.path.join(' ')}"`);
		if (spec.type === 'boolean') {
			if (value === true) args.push(`--${name}`);
			else if (value === false && spec.negatable) args.push(`--no-${name}`);
			continue;
		}
		if (value === '' || value == null) continue;
		const v = String(value);
		if (!SAFE_VALUE.test(v) || v.startsWith('-')) throw new Error(`Invalid value for --${name}`);
		if (spec.choices && !spec.choices.includes(v)) throw new Error(`--${name} must be one of ${spec.choices.join(', ')}`);
		args.push(`--${name}=${v}`);
	}
	return args;
}

// ---------- Claude transcripts (for statusline previews) ----------

function claudeRoots() {
	const env = process.env.CLAUDE_CONFIG_DIR;
	const bases = env ? env.split(',').map((s) => s.trim()).filter(Boolean)
		: [path.join(os.homedir(), '.config', 'claude'), path.join(os.homedir(), '.claude')];
	return bases.map((b) => path.join(b, 'projects')).filter((p) => existsSync(p));
}

async function listTranscripts(limit = 60) {
	const out = [];
	for (const root of claudeRoots()) {
		for (const project of await readdir(root).catch(() => [])) {
			const dir = path.join(root, project);
			for (const f of await readdir(dir).catch(() => [])) {
				if (!f.endsWith('.jsonl')) continue;
				const full = path.join(dir, f);
				const s = await stat(full).catch(() => null);
				if (s?.isFile()) out.push({ sessionId: f.slice(0, -6), project, path: full, mtime: s.mtimeMs, size: s.size });
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

const claudeUsage = createClaudeUsage(claudeRoots);

// Filters the blocks; never forwarded to the hourly pricing run, which must cover the full history.
const BLOCK_FILTER_FLAGS = new Set(['since', 'until', 'active', 'recent', 'order', 'token-limit', 'session-length']);

async function claudeActivity({ flags = {}, fresh }) {
	const started = Date.now();
	const cmd = findCommand(['claude', 'blocks']);
	if (!cmd) throw new Error('This ccusage version has no "claude blocks" report');
	await claudeUsage.scan();
	const pricing = Object.fromEntries(Object.entries(flags).filter(([k]) => !BLOCK_FILTER_FLAGS.has(k)));
	const r = await cachedRun([...buildArgs(cmd, { ...pricing, 'session-length': '1' }), '--json'], { color: false }, fresh);
	if (r.code !== 0) throw new Error((r.stderr || r.stdout || `ccusage exited with ${r.code}`).trim());
	const windowHours = Number(flags['session-length']) > 0 ? Number(flags['session-length']) : 5;
	const { blocks, hours } = claudeUsage.activity(JSON.parse(r.stdout).blocks ?? [], { windowHours });
	return { code: 0, stdout: '', stderr: r.stderr, ms: Date.now() - started, cached: r.cached, age: r.age, refreshing: r.refreshing, data: { blocks: selectBlocks(blocks, flags) }, hours };
}

function runReport(cmd, flags, json, fresh) {
	const args = buildArgs(cmd, flags);
	const wantJson = json && cmd.flags.some((f) => f.name === 'json');
	if (wantJson) args.push('--json');
	else if (cmd.flags.some((f) => f.name === 'color')) args.push('--color');
	return { args, wantJson, result: cachedRun(args, { color: !wantJson }, fresh) };
}

// Must match what the overview page requests, so these runs are the ones it reuses.
const OVERVIEW_REPORTS = [[['daily'], { 'by-agent': true }], [['monthly'], { 'by-agent': true }], [['claude', 'session'], {}], [['session'], {}]];

function prewarm() {
	const [first, ...rest] = OVERVIEW_REPORTS;
	const start = ([cmdPath, flags]) => { const cmd = findCommand(cmdPath); if (cmd) runReport(cmd, flags, true).result.catch(() => {}); };
	start(first);
	claudeActivity({}).catch(() => {});
	rest.forEach(start);
}

// ---------- HTTP ----------

// Stale-while-revalidate: any earlier result is returned at once and refreshed in the background,
// so only the very first run of a report ever makes the page wait for ccusage.
const cache = new Map();
const inFlight = new Map();

function refreshRun(key, args, opts) {
	let p = inFlight.get(key);
	if (p) return p;
	p = run(args, opts)
		.then((result) => {
			const prev = cache.get(key);
			// A failed refresh keeps the last good data, but still counts as checked so it isn't retried in a loop.
			cache.set(key, { at: Date.now(), result: result.code === 0 || !prev ? result : prev.result });
			if (result.code === 0) saveCacheSoon();
			return result;
		})
		.finally(() => inFlight.delete(key));
	inFlight.set(key, p);
	return p;
}

async function cachedRun(args, opts, fresh) {
	const key = JSON.stringify([args, opts.color, opts.stdin ?? null]);
	const hit = cache.get(key);
	if (fresh || !hit) return refreshRun(key, args, opts);
	const ttl = Math.max(CACHE_MS, hit.result.code === 0 ? hit.result.ms * CACHE_RUN_FACTOR : 0);
	if (Date.now() - hit.at >= ttl) refreshRun(key, args, opts).catch(() => {});
	return { ...hit.result, cached: true, age: Date.now() - hit.at, refreshing: inFlight.has(key) };
}

function cacheFile() {
	const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
		: process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
		: process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
	return path.join(base, 'ai-usage-meter', 'runs.json');
}
const CACHE_FILE = cacheFile();
const CACHE_FILE_ENTRIES = 40;

function loadCache() {
	try {
		const saved = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
		if (saved.version !== CC_VERSION) return;
		for (const [key, entry] of saved.entries) cache.set(key, entry);
	} catch {}
}

let saveTimer = null;
function saveCacheSoon() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(async () => {
		const entries = [...cache].filter(([, e]) => e.result.code === 0).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_FILE_ENTRIES);
		const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
		try {
			await mkdir(path.dirname(CACHE_FILE), { recursive: true });
			await writeFile(tmp, JSON.stringify({ version: CC_VERSION, entries }));
			await rename(tmp, CACHE_FILE);
		} catch {
			await unlink(tmp).catch(() => {});
		}
	}, 2000);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body, type = 'application/json') {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.setEncoding('utf8');
		req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
		req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
		req.on('error', reject);
	});
}

// Reject requests whose Host isn't loopback, which blocks DNS-rebinding from other sites.
function hostAllowed(req) {
	const h = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return ['localhost', '127.0.0.1', '::1'].includes(h) || h === HOST;
}

const server = createServer(async (req, res) => {
	try {
		if (!hostAllowed(req)) return send(res, 403, { error: 'Forbidden host' });
		const url = new URL(req.url, 'http://localhost');
		if (req.method === 'GET' && url.pathname === '/api/catalog') return send(res, 200, catalog ?? (await buildCatalog()));
		if (req.method === 'GET' && url.pathname === '/api/transcripts') return send(res, 200, await listTranscripts());

		if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
			if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
			const body = await readBody(req);
			if (!catalog) await buildCatalog();

			if (url.pathname === '/api/claude/activity') return send(res, 200, await claudeActivity(body));

			if (url.pathname === '/api/run') {
				const cmd = findCommand(body.command || []);
				if (!cmd) return send(res, 400, { error: `Unknown command "${(body.command || []).join(' ')}"` });
				const { args, wantJson, result } = runReport(cmd, body.flags, body.json, body.fresh);
				const r = await result;
				let data = null;
				if (wantJson && r.code === 0) { try { data = JSON.parse(r.stdout); } catch {} }
				return send(res, 200, { args, command: `ccusage ${args.join(' ')}`, ...r, data });
			}

			if (url.pathname === '/api/statusline') {
				const cmd = findCommand(body.command || ['statusline']);
				if (!cmd || cmd.name !== 'statusline') return send(res, 400, { error: 'Not a statusline command' });
				const args = buildArgs(cmd, body.flags);
				const t = body.transcript && (await listTranscripts(10_000)).find((x) => x.path === body.transcript);
				if (!t) return send(res, 400, { error: 'Pick a Claude session transcript' });
				const hook = {
					session_id: t.sessionId,
					transcript_path: t.path,
					cwd: process.cwd(),
					model: { id: body.modelId || 'claude', display_name: body.modelName || 'Claude' },
					workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
				};
				if (body.sessionCost !== '' && body.sessionCost != null) hook.cost = { total_cost_usd: Number(body.sessionCost) };
				if (body.contextTokens) hook.context_window = { total_input_tokens: Number(body.contextTokens), context_window_size: Number(body.contextSize || 200000) };
				if (body.effort) hook.effort = body.effort;
				const r = await run(args, { stdin: JSON.stringify(hook), color: true });
				return send(res, 200, { args, command: `ccusage ${args.join(' ')}`, hook, ...r });
			}
			return send(res, 404, { error: 'Not found' });
		}

		if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
		const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
		const file = path.join(ROOT, 'public', rel);
		if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 403, { error: 'Forbidden' });
		if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
		return send(res, 200, readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
	} catch (e) {
		return send(res, 400, { error: e.message || String(e) });
	}
});

function openBrowser(url) {
	const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
		: process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
	try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
}

function listen(port, attemptsLeft) {
	server.once('error', (e) => {
		if (e.code === 'EADDRINUSE' && attemptsLeft > 0 && !process.env.PORT) return listen(port + 1, attemptsLeft - 1);
		console.error(`Could not start server: ${e.message}`);
		process.exit(1);
	});
	server.listen(port, HOST, () => {
		const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`;
		console.log(`AI Usage Meter → ${url}  (ccusage ${catalog.version}, ${catalog.commands.length} commands)`);
		if (process.argv.includes('--open') || (process.env.OPEN && process.env.OPEN !== '0')) openBrowser(url);
		// Start the overview's reports now so the first page load finds them running or done.
		prewarm();
	});
}

loadCache();
buildCatalog()
	.then(() => listen(PORT, 10))
	.catch((e) => {
		console.error(`Could not run ccusage (${CC.cmd}): ${e.message}`);
		process.exit(1);
	});
