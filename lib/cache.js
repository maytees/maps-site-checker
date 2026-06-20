// Dead-simple persistent cache: append-only JSONL file + in-memory Map.
// Survives crashes (a half-written last line is just skipped on load) and lets
// re-imports skip already-scanned businesses. One file: data/cache.jsonl.
import fs from 'fs';
import path from 'path';
import { log } from '@/lib/log';

const DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'cache.jsonl');

// stash on globalThis so Next.js hot-reload doesn't reload the file each edit
const G = globalThis;
if (!G.__scanCache) {
  const map = new Map(); // `${kind}:${key}` -> { sig, data, at }
  try {
    if (fs.existsSync(FILE)) {
      let lines = 0;
      for (const ln of fs.readFileSync(FILE, 'utf8').split('\n')) {
        if (!ln.trim()) continue;
        try { const o = JSON.parse(ln); map.set(o.kind + ':' + o.key, { sig: o.sig, data: o.data, at: o.at }); lines++; } catch { /* skip bad line */ }
      }
      log('cache', `loaded ${map.size} entries (${lines} lines)`);
    }
  } catch { /* ignore */ }
  G.__scanCache = { map, chain: Promise.resolve() };
}
const C = G.__scanCache;

// short stable hash so a verdict is only reused for the SAME checks+model+instruction
export function sigOf(...parts) {
  const s = JSON.stringify(parts);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function cacheGet(kind, key, sig) {
  if (!key) return null;
  const e = C.map.get(kind + ':' + key);
  if (!e) return null;
  if (sig != null && e.sig !== sig) return null; // checks/model changed -> miss
  return e.data;
}

export function cachePut(kind, key, sig, data) {
  if (!key) return;
  const at = Date.now();
  C.map.set(kind + ':' + key, { sig, data, at });
  const line = JSON.stringify({ kind, key, sig, data, at }) + '\n';
  // serialize writes so parallel scans never interleave a line
  C.chain = C.chain.then(async () => {
    try { await fs.promises.mkdir(DIR, { recursive: true }); await fs.promises.appendFile(FILE, line); } catch { /* ignore */ }
  });
}

export function cacheStats() {
  let scan = 0, resolve = 0, owner = 0;
  for (const k of C.map.keys()) {
    if (k.startsWith('scan:')) scan++;
    else if (k.startsWith('resolve:')) resolve++;
    else if (k.startsWith('owner:')) owner++;
  }
  return { total: C.map.size, scan, resolve, owner };
}

// cacheClear()         -> wipe everything (delete the file)
// cacheClear('owner')  -> remove only that kind, rewrite the file with the rest
export async function cacheClear(kind) {
  if (!kind) {
    C.map.clear();
    C.chain = C.chain.then(async () => { try { await fs.promises.rm(FILE, { force: true }); } catch { /* ignore */ } });
    await C.chain;
    log('cache', 'cleared all');
    return;
  }
  let removed = 0;
  for (const k of [...C.map.keys()]) if (k.startsWith(kind + ':')) { C.map.delete(k); removed++; }
  C.chain = C.chain.then(async () => {
    try {
      await fs.promises.mkdir(DIR, { recursive: true });
      const lines = [];
      for (const [mk, e] of C.map.entries()) {
        const i = mk.indexOf(':');
        lines.push(JSON.stringify({ kind: mk.slice(0, i), key: mk.slice(i + 1), sig: e.sig, data: e.data, at: e.at }));
      }
      await fs.promises.writeFile(FILE, lines.length ? lines.join('\n') + '\n' : '');
    } catch { /* ignore */ }
  });
  await C.chain;
  log('cache', `cleared ${removed} ${kind} entries`);
}
