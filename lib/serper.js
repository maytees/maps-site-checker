// Server-side Google search via Serper.dev (JSON SERP API). We only read the
// RESULTS — we never visit LinkedIn (it's auth-walled and blocks bots).
import { log, warn } from '@/lib/log';

const ENDPOINT = 'https://google.serper.dev/search';

// -> { ok, organic:[{title,link,snippet}], error? }
export async function serperSearch(query, { num = 10, timeoutMs = 12000 } = {}) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { ok: false, error: 'no SERPER_API_KEY set', organic: [] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num, gl: 'us', hl: 'en' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      warn('serper', `http ${res.status} ${body.slice(0, 120)}`);
      return { ok: false, error: `serper http ${res.status}`, organic: [] };
    }
    const data = await res.json();
    const organic = (data.organic || []).map((o) => ({ title: o.title || '', link: o.link || '', snippet: o.snippet || '' }));
    log('serper', `“${query.slice(0, 70)}” → ${organic.length} results`);
    return { ok: true, organic };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e), organic: [] };
  } finally {
    clearTimeout(t);
  }
}

// LinkedIn personal-profile URLs only (/in/...), normalized (no query/hash, lowercased host).
export function linkedinInUrls(organic) {
  const out = [];
  for (const r of organic || []) {
    const m = String(r.link || '').match(/^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/in\/[A-Za-z0-9_%-]+/i);
    if (m) {
      const url = m[0].replace(/^http:/, 'https:');
      if (!out.some((x) => x.url === url)) out.push({ url, title: r.title, snippet: r.snippet });
    }
  }
  return out;
}
