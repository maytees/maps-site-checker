import { resolveWebsite } from '@/lib/resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST { mapsUrl } -> { ok, status, website?, error? }
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, status: 'failed', error: 'invalid body' }, 400); }
  const mapsUrl = body?.mapsUrl;
  if (!mapsUrl) return json({ ok: false, status: 'failed', error: 'no mapsUrl' }, 400);

  const r = await resolveWebsite(mapsUrl);
  return json({ ok: r.status === 'ok', ...r });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
