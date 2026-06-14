// Tiny colored logger for the `bun run start` / `bun run dev` terminal.
const C = { dim: '\x1b[2m', rst: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', mag: '\x1b[35m' };
const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });

const tagColor = { scan: C.cyan, llm: C.mag, site: C.green, resolve: C.yellow };

export function log(tag, ...a) {
  console.log(`${C.dim}${ts()}${C.rst} ${tagColor[tag] || C.cyan}[${tag}]${C.rst}`, ...a);
}
export function warn(tag, ...a) {
  console.log(`${C.dim}${ts()}${C.rst} ${C.yellow}[${tag}]${C.rst}`, ...a);
}
export function err(tag, ...a) {
  console.error(`${C.dim}${ts()}${C.rst} ${C.red}[${tag}]${C.rst}`, ...a);
}
export const short = (u, n = 60) => { const s = String(u || '').replace(/^https?:\/\//, ''); return s.length > n ? s.slice(0, n) + '…' : s; };
