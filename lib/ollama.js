// Server-side call to your local Ollama. No network leaves the machine.
import { log, err } from '@/lib/log';

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

export async function listModels() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// checks: [{ key, question }]  ->  model returns { [key]: "yes|no|unclear", ... }
export async function classify({ model, checks, instruction, businessName, text, signals, pageUrls }) {
  const keys = checks.map((c) => c.key);
  const checkList = checks.map((c) =>
    `- "${c.key}": ${c.question}` +
    (c.want === 'no' ? ' (If the site does not clearly show this, answer "no" — a business advertises such features; do NOT answer "unclear".)' : '')
  ).join('\n');

  const schema =
    '{' +
    checks.map((c) => `"${c.key}":"yes|no|unclear"`).join(',') +
    ',"business_type":"short label e.g. boarding kennel / pet hotel / vet / solo pet sitter / groomer / daycare"' +
    ',"team_size":"solo|small_team|large_team|unclear","locations":"single|multiple|unclear"' +
    ',"confidence":"high|medium|low","notes":"one short sentence citing the evidence and which page"}';

  const sig = signals && Object.keys(signals).length
    ? 'Automated keyword scan of the pages (HINTS — confirm against the actual text, do not trust blindly):\n' +
      Object.entries(signals).map(([k, n]) => `  - ${k}: ${n} mention(s)`).join('\n') + '\n\n'
    : '';

  const sys =
    'You analyze a pet-services business from the FULL TEXT of its own website (several pages are provided, each marked "# PAGE:"). ' +
    'Read ALL pages before answering — boarding or webcam info is often on a Services, Boarding, or Amenities page, not the homepage. ' +
    'A page that EXISTS for a feature is strong evidence the feature exists: if you see a "# PAGE:" whose URL is about it (e.g. /live-web-cams, /webcams, /boarding), answer YES for that feature even if that page has little text. ' +
    'Answer each question "yes", "no", or "unclear". ' +
    'IMPORTANT: when a question asks whether the business HAS or ALREADY OFFERS a feature (webcams, an owner-update app, etc.), assume they would advertise it — if the site does not clearly show it, answer "no", NOT "unclear". Reserve "unclear" only for genuinely contradictory or ambiguous text. ' +
    'Definitions: ' +
    'BOARDING = the business keeps pets OVERNIGHT on its premises (kennels, lodging, suites, "overnight stays"); say yes if ANY page mentions this, even a vet/clinic that also boards. ' +
    'WEBCAMS = live cameras the OWNER can watch their pet through (puppy cam, live stream, "watch your dog"); generic security cameras or social-media photos do NOT count. ' +
    'SOLO PET SITTER = one individual offering dog-walking / in-home pet-sitting (first-person "I", "in my home"), NOT a facility with staff/team. ' +
    'VET = a veterinary clinic / animal hospital (medical care, vaccines, surgery). ' +
    'TEAM_SIZE: "solo" = clearly one person; "small_team" = a handful of named staff / "our team"; "large_team" = a big operation or chain; "unclear" if no signal. ' +
    'LOCATIONS: "multiple" if it names more than one branch/location, else "single", "unclear" if no signal. ' +
    'Reply with ONE JSON object and nothing else.';

  // NOTE: website text goes FIRST, the questions/schema LAST — so if anything is
  // truncated it's the page text, never the instructions the model must follow.
  const pages = Array.isArray(pageUrls) && pageUrls.length
    ? `Pages found on this site (a page named for a feature is strong evidence it exists):\n${pageUrls.map((u) => '  - ' + u).join('\n')}\n\n`
    : '';

  const user =
    (instruction ? `User context:\n${instruction}\n\n` : '') +
    `Business name: ${businessName || '(unknown)'}\n\n` +
    pages +
    sig +
    `WEBSITE TEXT (multiple pages, each marked "# PAGE:"):\n"""\n${text}\n"""\n\n` +
    `Now answer these questions about the business above (yes / no / unclear each):\n${checkList}\n\n` +
    `Return EXACTLY this JSON shape, nothing else (no markdown, no extra keys):\n${schema}`;

  log('llm', `→ ${model}  asking [${keys.join(', ')}]  (${user.length} chars in${signals && Object.keys(signals).length ? ', hints ' + JSON.stringify(signals) : ''})`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json', // force valid JSON output
        keep_alive: '30m', // keep the model warm in RAM/VRAM between rows — avoids per-scan reloads
        // num_ctx 8192: default is 4096, which truncated our multi-page text and broke the JSON
        options: { temperature: 0, num_ctx: 8192 },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    err('llm', `${model} unreachable:`, String(e.message || e));
    return { ok: false, error: `ollama unreachable: ${String(e.message || e)}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    err('llm', `${model} http ${res.status}`, body.slice(0, 200));
    return { ok: false, error: `ollama http ${res.status}${body ? ': ' + body.slice(0, 200) : ''}` };
  }

  const data = await res.json();
  const raw = data?.message?.content || '';
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const toks = data.eval_count || 0;
  const tps = data.eval_duration ? (toks / (data.eval_duration / 1e9)).toFixed(0) : '?';
  log('llm', `← ${model}  ${secs}s · ${toks} tok · ${tps} tok/s  raw: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(m ? m[0] : '{}'); } catch { parsed = {}; }
  }

  const norm = (v) => {
    const s = String(v ?? '').toLowerCase();
    if (/(^|[^a-z])(yes|true|y)([^a-z]|$)/.test(s)) return 'yes';
    if (/(^|[^a-z])(no|false|n)([^a-z]|$)/.test(s)) return 'no';
    return 'unclear';
  };
  const verdict = {};
  for (const k of keys) verdict[k] = norm(parsed[k]);
  verdict.business_type = String(parsed.business_type || '').slice(0, 60);
  verdict.team_size = ['solo', 'small_team', 'large_team'].includes(String(parsed.team_size)) ? parsed.team_size : '';
  verdict.locations = ['single', 'multiple'].includes(String(parsed.locations)) ? parsed.locations : '';
  verdict.confidence = ['high', 'medium', 'low'].includes(String(parsed.confidence)) ? parsed.confidence : '';
  verdict.notes = String(parsed.notes || '').slice(0, 300);
  return { ok: true, verdict };
}
