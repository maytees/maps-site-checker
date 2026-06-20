import { cacheStats, cacheClear } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(cacheStats());
}

// POST { action: 'clear' }
export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  if (body.action === 'clear') {
    await cacheClear(body.kind); // body.kind === 'owner' clears just enrichment; omit = everything
    return Response.json({ ok: true, ...cacheStats() });
  }
  return Response.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
