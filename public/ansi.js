const BASIC = ['#3a3a38', '#e66767', '#3fb950', '#e3b341', '#5598e7', '#d55181', '#39c5cf', '#e8e7e2'];
const BRIGHT = ['#898781', '#ff7b72', '#56d364', '#f2cc60', '#79b8ff', '#f778ba', '#56d4dd', '#ffffff'];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function xterm256(n) {
	if (n < 8) return BASIC[n];
	if (n < 16) return BRIGHT[n - 8];
	if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
	n -= 16;
	const c = (x) => (x ? x * 40 + 55 : 0);
	return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}

export function ansiToHtml(text) {
	let out = '';
	let state = {};
	let open = false;
	const style = () => {
		const s = [];
		if (state.fg) s.push(`color:${state.fg}`);
		if (state.bg) s.push(`background:${state.bg}`);
		if (state.bold) s.push('font-weight:700');
		if (state.dim) s.push('opacity:.65');
		if (state.italic) s.push('font-style:italic');
		if (state.underline) s.push('text-decoration:underline');
		return s.join(';');
	};
	const parts = text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').split(/\x1b\[([\d;]*)m/);
	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 0) { out += esc(parts[i]); continue; }
		const codes = parts[i] === '' ? [0] : parts[i].split(';').map(Number);
		for (let j = 0; j < codes.length; j++) {
			const c = codes[j];
			if (c === 0) state = {};
			else if (c === 1) state.bold = true;
			else if (c === 2) state.dim = true;
			else if (c === 3) state.italic = true;
			else if (c === 4) state.underline = true;
			else if (c === 22) state.bold = state.dim = false;
			else if (c === 39) state.fg = null;
			else if (c === 49) state.bg = null;
			else if (c >= 30 && c <= 37) state.fg = BASIC[c - 30];
			else if (c >= 90 && c <= 97) state.fg = BRIGHT[c - 90];
			else if (c >= 40 && c <= 47) state.bg = BASIC[c - 40];
			else if (c >= 100 && c <= 107) state.bg = BRIGHT[c - 100];
			else if (c === 38 || c === 48) {
				const key = c === 38 ? 'fg' : 'bg';
				if (codes[j + 1] === 5) { state[key] = xterm256(codes[j + 2]); j += 2; }
				else if (codes[j + 1] === 2) { state[key] = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; j += 4; }
			}
		}
		if (open) out += '</span>';
		const s = style();
		open = !!s;
		if (s) out += `<span style="${s}">`;
	}
	if (open) out += '</span>';
	return out;
}

export const stripAnsi = (s) => s.replace(/\x1b\[[\d;]*m/g, '');
