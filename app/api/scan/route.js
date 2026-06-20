import { normalizeUrl, gatherSiteText } from '@/lib/site';
import { classify, pickPages, isChain } from '@/lib/ollama';
import { findDecisionMaker } from '@/lib/enrich';
import { log, warn, short } from '@/lib/log';
import { cacheGet, cachePut, sigOf } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST { website, businessName, model, instruction, checks:[{key,question}], noCache }
// -> { ok, status, verdict?, finalUrl?, pages?, cached?, error? }
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, status: 'bad-request', error: 'invalid body' }, 400); }

  const { website, businessName, model, instruction, checks, noCache, aiPick, findOwner } = body || {};
  if (!model) return json({ ok: false, status: 'error', error: 'no model selected' }, 400);
  if (!Array.isArray(checks) || !checks.length) return json({ ok: false, status: 'error', error: 'no checks defined' }, 400);

  const name = businessName || '(no name)';
  const t0 = Date.now();
  // chain flag works off name/domain alone — set it even when the site is unreachable
  const chainV = isChain(name, website) ? { verdict: { franchise: 'yes' } } : {};
  const norm = normalizeUrl(website);
  if (!norm) { warn('scan', `✗ ${name}: no usable website`); return json({ ok: true, status: 'no-website', error: 'no usable website in this row', ...chainV }); }
  if (norm.mapsOnly) { warn('scan', `✗ ${name}: maps link only`); return json({ ok: true, status: 'maps-only', error: 'only a Google Maps link — re-scrape with the website (site) field picked', ...chainV }); }

  // cache: keyed by domain + a hash of checks/model/instruction/page-selection mode
  const sig = sigOf(checks.map((c) => [c.key, c.question, c.want || '']), model, instruction || '', aiPick ? 'ai' : 'rx', findOwner ? 'own' : '');
  if (!noCache) {
    const hit = cacheGet('scan', norm.host, sig);
    if (hit) { log('scan', `• ${name} (cached)`); return json({ ok: true, status: 'done', cached: true, ...hit }); }
  }

  log('scan', `▶ ${name} — ${short(norm.url)}`);
  // AI picks which pages to read (regex shortlist + regex fallback inside gatherSiteText)
  const pick = aiPick ? (candidates) => pickPages({ model, businessName: name, checks, candidates }) : undefined;
  const site = await gatherSiteText(norm.url, { pick });
  if (!site.ok) { warn('scan', `✗ ${name}: fetch-failed (${site.error})`); return json({ ok: true, status: 'fetch-failed', finalUrl: norm.url, error: site.error, ...chainV }); }
  log('site', `  ${name}: read ${site.pages} page(s) [${(site.pageUrls || []).map((u) => short(u, 40)).join(', ')}]${site.signals && Object.keys(site.signals).length ? '  signals ' + JSON.stringify(site.signals) : ''}`);
  if (!site.text || site.text.replace(/# PAGE:.*$/gm, '').trim().length < 40) {
    warn('scan', `✗ ${name}: empty-site (JS-only?)`);
    return json({ ok: true, status: 'empty-site', finalUrl: site.finalUrl, error: 'site had no readable text (likely JS-only)', ...chainV });
  }

  const result = await classify({ model, checks, instruction, businessName, text: site.text, signals: site.signals, pageUrls: site.pageUrls });
  if (!result.ok) { warn('scan', `✗ ${name}: ai-error (${result.error})`); return json({ ok: false, status: 'ai-error', finalUrl: site.finalUrl, error: result.error }, 200); }

  // hard-flag obvious chains by name/domain, regardless of what the model said
  if (result.verdict && isChain(name, site.finalUrl)) result.verdict.franchise = 'yes';

  // optional: find the owner/decision-maker + their LinkedIn (Serper search, reuses the crawled text)
  let owner = { ownerName: '', ownerTitle: '', linkedinUrl: '' };
  if (findOwner) owner = await findDecisionMaker({ model, businessName: name, siteText: site.text });

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
    ...owner,
  };
  cachePut('scan', norm.host, sig, payload);
  return json({ ok: true, status: 'done', ...payload });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
