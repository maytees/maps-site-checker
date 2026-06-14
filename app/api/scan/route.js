import { normalizeUrl, gatherSiteText } from '@/lib/site';
import { classify } from '@/lib/ollama';
import { log, warn, short } from '@/lib/log';
import { cacheGet, cachePut, sigOf } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST { website, businessName, model, instruction, checks:[{key,question}], noCache }
// -> { ok, status, verdict?, finalUrl?, pages?, cached?, error? }
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, status: 'bad-request', error: 'invalid body' }, 400); }

  const { website, businessName, model, instruction, checks, noCache } = body || {};
  if (!model) return json({ ok: false, status: 'error', error: 'no model selected' }, 400);
  if (!Array.isArray(checks) || !checks.length) return json({ ok: false, status: 'error', error: 'no checks defined' }, 400);

  const name = businessName || '(no name)';
  const t0 = Date.now();
  const norm = normalizeUrl(website);
  if (!norm) { warn('scan', `✗ ${name}: no usable website`); return json({ ok: true, status: 'no-website', error: 'no usable website in this row' }); }
  if (norm.mapsOnly) { warn('scan', `✗ ${name}: maps link only`); return json({ ok: true, status: 'maps-only', error: 'only a Google Maps link — re-scrape with the website (site) field picked' }); }

  // cache: keyed by domain + a hash of checks/model/instruction
  const sig = sigOf(checks.map((c) => [c.key, c.question]), model, instruction || '');
  if (!noCache) {
    const hit = cacheGet('scan', norm.host, sig);
    if (hit) { log('scan', `• ${name} (cached)`); return json({ ok: true, status: 'done', cached: true, ...hit }); }
  }

  log('scan', `▶ ${name} — ${short(norm.url)}`);
  const site = await gatherSiteText(norm.url);
  if (!site.ok) { warn('scan', `✗ ${name}: fetch-failed (${site.error})`); return json({ ok: true, status: 'fetch-failed', finalUrl: norm.url, error: site.error }); }
  log('site', `  ${name}: read ${site.pages} page(s) [${(site.pageUrls || []).map((u) => short(u, 40)).join(', ')}]${site.signals && Object.keys(site.signals).length ? '  signals ' + JSON.stringify(site.signals) : ''}`);
  if (!site.text || site.text.replace(/# PAGE:.*$/gm, '').trim().length < 40) {
    warn('scan', `✗ ${name}: empty-site (JS-only?)`);
    return json({ ok: true, status: 'empty-site', finalUrl: site.finalUrl, error: 'site had no readable text (likely JS-only)' });
  }

  const result = await classify({ model, checks, instruction, businessName, text: site.text, signals: site.signals });
  if (!result.ok) { warn('scan', `✗ ${name}: ai-error (${result.error})`); return json({ ok: false, status: 'ai-error', finalUrl: site.finalUrl, error: result.error }, 200); }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log('scan', `✓ ${name} done in ${secs}s →`, result.verdict, site.email ? `· email ${site.email}` : '');
  const payload = {
    finalUrl: site.finalUrl,
    pages: site.pages,
    pageUrls: site.pageUrls,
    verdict: result.verdict,
    email: site.email,
    emails: site.emails,
    socials: site.socials,
    sitePhone: site.sitePhone,
  };
  cachePut('scan', norm.host, sig, payload);
  return json({ ok: true, status: 'done', ...payload });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
