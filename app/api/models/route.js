import { listModels } from '@/lib/ollama';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const r = await listModels();
  return new Response(JSON.stringify(r), {
    status: r.ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}
