import { resolveWebsite } from '@/lib/resolve';
import { log, warn, short } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST { mapsUrl } -> { ok, status, website?, error? }
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, status: 'failed', error: 'invalid body' }, 400); }
  const mapsUrl = body?.mapsUrl;
  if (!mapsUrl) return json({ ok: false, status: 'failed', error: 'no mapsUrl' }, 400);

  log('resolve', `▶ opening maps listing ${short(mapsUrl, 50)}`);
  const t0 = Date.now();
  const r = await resolveWebsite(mapsUrl);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 'ok') log('resolve', `✓ ${secs}s → site ${short(r.website, 40)}${r.phone ? ' · phone ' + r.phone : ''}${r.businessStatus && r.businessStatus !== 'open' ? ' · ' + r.businessStatus : ''}`);
  else warn('resolve', `✗ ${secs}s → ${r.status}${r.error ? ' (' + r.error + ')' : ''}${r.phone ? ' · phone ' + r.phone : ''}`);
  return json({ ok: r.status === 'ok', ...r });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
