import { normalizeUrl, gatherSiteText } from '@/lib/site';
import { findDecisionMaker } from '@/lib/enrich';
import { cacheGet, cachePut } from '@/lib/cache';
import { log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST { website, businessName, model, noCache }
// -> { ok, ownerName, ownerTitle, linkedinUrl, cached? }
// Only the client calls this for confirmed leads, so the (paid) Serper search runs sparingly.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid body' }, 400); }
  const { website, businessName, model, noCache, city } = body || {};
  if (!model) return json({ ok: false, error: 'no model selected' }, 400);

  const norm = normalizeUrl(website);
  const domain = (norm && norm.host) || (businessName || '').toLowerCase();
  if (!domain) return json({ ok: true, ownerName: '', ownerTitle: '', linkedinUrl: '' });

  if (!noCache) {
    const hit = cacheGet('owner', domain, '');
    if (hit) return json({ ok: true, cached: true, ...hit });
  }

  // light re-crawl (regex page pick, no extra AI) just for the team/about text
  let siteText = '';
  if (norm && !norm.mapsOnly) {
    const site = await gatherSiteText(norm.url);
    if (site.ok) { siteText = site.text; log('enrich', `crawled ${domain} → ${site.pages} pages, ${siteText.length} chars`); }
    else log('enrich', `crawl failed for ${domain}: ${site.error}`);
  } else {
    log('enrich', `no crawlable website for ${businessName || domain} (got: ${String(website).slice(0, 50)})`);
  }
  const dm = await findDecisionMaker({ model, businessName, siteText, city });
  cachePut('owner', domain, '', dm);
  return json({ ok: true, ...dm });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
