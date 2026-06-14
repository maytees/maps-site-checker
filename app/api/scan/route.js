import { normalizeUrl, gatherSiteText } from '@/lib/site';
import { classify } from '@/lib/ollama';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST { website, businessName, model, instruction, checks:[{key,question}] }
// -> { ok, status, verdict?, finalUrl?, pages?, error? }
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, status: 'bad-request', error: 'invalid body' }, 400); }

  const { website, businessName, model, instruction, checks } = body || {};
  if (!model) return json({ ok: false, status: 'error', error: 'no model selected' }, 400);
  if (!Array.isArray(checks) || !checks.length) return json({ ok: false, status: 'error', error: 'no checks defined' }, 400);

  const norm = normalizeUrl(website);
  if (!norm) return json({ ok: true, status: 'no-website', error: 'no usable website in this row' });
  if (norm.mapsOnly) {
    return json({ ok: true, status: 'maps-only', error: 'only a Google Maps link — re-scrape with the website (site) field picked' });
  }

  const site = await gatherSiteText(norm.url);
  if (!site.ok) return json({ ok: true, status: 'fetch-failed', finalUrl: norm.url, error: site.error });
  if (!site.text || site.text.replace(/# PAGE:.*$/gm, '').trim().length < 40) {
    return json({ ok: true, status: 'empty-site', finalUrl: site.finalUrl, error: 'site had no readable text (likely JS-only)' });
  }

  const result = await classify({ model, checks, instruction, businessName, text: site.text, signals: site.signals });
  if (!result.ok) return json({ ok: false, status: 'ai-error', finalUrl: site.finalUrl, error: result.error }, 200);

  return json({
    ok: true,
    status: 'done',
    finalUrl: site.finalUrl,
    pages: site.pages,
    pageUrls: site.pageUrls,
    verdict: result.verdict,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
