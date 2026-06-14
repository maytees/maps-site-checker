// Server-side helpers: turn a website URL into clean text the model can read.
// Runs only in the Next.js API route (Node runtime), never in the browser —
// browsers can't fetch arbitrary third-party sites (no CORS), the server can.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Pages worth reading beyond the homepage — where boarding / webcam / vet / contact info lives.
const PAGE_HINTS =
  /\b(board|boarding|kennel|lodging|overnight|suites?|daycare|day-care|dog-?day|service|services|amenities|facilit|webcam|web-?cam|live-?cam|puppy-?cam|pet-?cam|camera|stream|watch|about|team|staff|pricing|rates|reservation|book|contact|location|locations)\b/i;

// Keyword signals we surface to the model as hints (it must still verify against the text).
const SIGNAL_SETS = {
  webcam: /\b(web[ -]?cams?|live[ -]?cams?|puppy[ -]?cams?|pet[ -]?cams?|live[ -]?stream(?:ing)?|live[ -]?feed|live[ -]?video|watch your (?:dog|pet|cat|puppy)|view your (?:dog|pet)|camera access|24\/?7 cameras?)\b/gi,
  boarding: /\b(overnight boarding|dog boarding|pet boarding|cat boarding|boarding|kennels?|lodging|overnight stays?|board your (?:dog|pet)|sleepovers?|boarding suites?)\b/gi,
  vet: /\b(veterinar(?:y|ian)s?|vet clinic|animal hospital|vaccinations?|spay|neuter|surgery|wellness exam|veterinary medicine)\b/gi,
  team: /\b(our team|our staff|meet the (?:team|staff)|our (?:trainers|caregivers|employees)|join our team|careers)\b/gi,
  solo: /\b(i am|i'?m a|my name is|i offer|i will (?:care|walk|watch)|i'?ve been|owner[- ]operator|one[- ]on[- ]one care|in my home)\b/gi,
};

// ---- URL handling --------------------------------------------------------

export function normalizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/google\.[a-z.]+\/maps/i.test(s) || /goo\.gl\/maps/i.test(s)) return { mapsOnly: true, url: s };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (isBlockedHost(u.hostname)) return null;
    return { url: u.toString(), host: u.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

function isBlockedHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

// ---- fetching ------------------------------------------------------------

async function getRaw(url, timeoutMs = 11000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
    });
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, url: res.url };
    const body = (await res.text()).slice(0, 800000);
    return { ok: true, status: res.status, url: res.url, ctype, body };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ---- html -> text --------------------------------------------------------

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

export function htmlToText(html) {
  if (!html) return '';
  const metas = [];
  const md = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (md) metas.push(md[1]);
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  if (og) metas.push(og[1]);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) metas.push(title[1]);

  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // keep alt text + aria-labels (webcam/boarding info often sits on buttons/images)
  s = s.replace(/<img[^>]*\balt=["']([^"']+)["'][^>]*>/gi, ' $1 ');
  s = s.replace(/\baria-label=["']([^"']+)["']/gi, ' $1 ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => ENT[m.toLowerCase()] ?? ' ');
  s = (metas.join('. ') + '. ' + s).replace(/\s+/g, ' ').trim();
  return s;
}

function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); }
  catch { return false; }
}

function navLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m, base;
  try { base = new URL(baseUrl); } catch { return out; }
  while ((m = re.exec(html)) && out.length < 600) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!sameHost(u.toString(), baseUrl)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|css|js)$/i.test(u.pathname)) continue;
    out.push({ url: u.toString().split('#')[0], text });
  }
  return out;
}

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
// pull page URLs out of sitemap.xml, following ALL child sitemaps of an index (nested sitemaps)
async function sitemapUrls(baseUrl) {
  const roots = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap1.xml'];
  const found = new Set();
  for (const path of roots) {
    let r;
    try { r = await getRaw(new URL(path, baseUrl).toString(), 8000); } catch { continue; }
    if (!r.ok || (!/xml/i.test(r.ctype || '') && !/<urlset|<sitemapindex/i.test(r.body || ''))) continue;
    const locs = [...r.body.matchAll(LOC_RE)].map((m) => m[1]);
    if (/<sitemapindex/i.test(r.body)) {
      // index of sitemaps → fetch SEVERAL children (relevant-looking first), collect every URL
      const kids = locs
        .filter((l) => !/\.gz$/i.test(l)) // can't parse gzipped without zlib
        .sort((a, b) => (PAGE_HINTS.test(b) ? 1 : 0) - (PAGE_HINTS.test(a) ? 1 : 0))
        .slice(0, 8);
      const got = await Promise.all(kids.map((k) => getRaw(k, 8000).catch(() => null)));
      for (const cr of got) if (cr?.ok) for (const m of cr.body.matchAll(LOC_RE)) found.add(m[1]);
    } else {
      locs.forEach((l) => found.add(l));
    }
    if (found.size) break;
  }
  // return real pages, not nested sitemap files
  return [...found].filter((u) => sameHost(u, baseUrl) && !/\.(xml|gz)$/i.test(u));
}

function scoreUrl(url, text) {
  let s = 0;
  const both = url + ' ' + (text || '');
  if (PAGE_HINTS.test(text || '')) s += 2;
  if (PAGE_HINTS.test(url)) s += 1;
  if (/board|kennel|overnight|lodg/i.test(both)) s += 2;
  if (/web-?cams?|live-?cams?|web ?cams?|puppy-?cam|pet-?cam|camera|live-?stream|live-?feed/i.test(both)) s += 3; // webcams: highest priority
  if (/service|amenit|facilit/i.test(both)) s += 1;
  return s;
}

function computeSignals(text) {
  const out = {};
  for (const [k, re] of Object.entries(SIGNAL_SETS)) {
    const hits = (text.match(re) || []).length;
    if (hits) out[k] = hits;
  }
  return out;
}

// ---- orchestration -------------------------------------------------------

export async function gatherSiteText(siteUrl, { maxPages = 8, maxChars = 16000 } = {}) {
  const home = await getRaw(siteUrl);
  if (!home.ok) return { ok: false, error: home.error || `http ${home.status}` || 'fetch failed', finalUrl: home.url || siteUrl };
  const baseUrl = home.url || siteUrl;

  // candidate inner pages from nav links + sitemap, de-duped and ranked
  const cand = new Map(); // stripped -> {url, text, score}
  for (const l of navLinks(home.body, baseUrl)) {
    const key = strip(l.url);
    if (key === strip(baseUrl)) continue;
    const prev = cand.get(key);
    const sc = scoreUrl(l.url, l.text);
    if (!prev || sc > prev.score) cand.set(key, { url: l.url, text: l.text, score: sc });
  }
  for (const u of await sitemapUrls(baseUrl)) {
    const key = strip(u);
    if (key === strip(baseUrl) || cand.has(key)) continue;
    const sc = scoreUrl(u, '');
    if (sc > 0) cand.set(key, { url: u, text: '', score: sc });
  }

  const picks = [...cand.values()].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, maxPages - 1);

  // fetch the picked pages in parallel (homepage already fetched)
  const fetched = await Promise.all(picks.map((p) => getRaw(p.url, 9000).then((r) => ({ url: p.url, r }))));
  const bodies = [home.body];
  const parts = [{ url: baseUrl, text: htmlToText(home.body) }];
  for (const f of fetched) if (f.r.ok && /html|xml/i.test(f.r.ctype || 'text/html')) { parts.push({ url: f.url, text: htmlToText(f.r.body) }); bodies.push(f.r.body); }

  let text = '';
  for (const p of parts) {
    if (text.length >= maxChars) break;
    text += `\n\n# PAGE: ${p.url}\n${p.text}`.slice(0, maxChars - text.length);
  }
  text = text.trim();
  const contacts = extractContacts(bodies, text, baseUrl);
  // include page-URL slugs in the signal scan so a /live-web-cams page counts even if its text is thin
  const slugBlob = parts.map((p) => p.url).join(' ').replace(/[-_/]+/g, ' ');
  return { ok: true, finalUrl: baseUrl, pages: parts.length, pageUrls: parts.map((p) => p.url), text, signals: computeSignals(text + ' ' + slugBlob), ...contacts };
}

// ---- contact extraction (email / socials / site phone) — pure regex, no AI ----

const JUNK_EMAIL = /(example|yourname|your@|name@domain|email@(domain|address|example)|user@|sentry|wixpress|\.png|\.jpg|\.gif|\.webp|@2x|@3x|godaddy|squarespace|cloudflare|googlesyndication|gstatic|googleapis|google-analytics|doubleclick|gravatar|jsdelivr|fontawesome|cloudfront|schema\.org|w3\.org|@\d|@a\.|@ion\.|@ic\.|sentry-)/i;
const ROLE_RE = /^(info|contact|hello|admin|office|bookings?|reservations?|frontdesk|front\.?desk|inquir|enquir|hi|woof|bark|care|sales|support)/i;
const SOCIALS = {
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9.\-_/]+/i,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9.\-_/]+/i,
  tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@?[A-Za-z0-9.\-_/]+/i,
  linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9.\-_/]+/i,
  youtube: /https?:\/\/(?:www\.)?youtube\.com\/[A-Za-z0-9.\-_@/]+/i,
  twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9.\-_/]+/i,
};

function extractContacts(bodies, text, baseUrl) {
  let host = '';
  try { host = new URL(baseUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* ignore */ }
  const html = bodies.join('\n');
  const emails = new Set();
  // 1. mailto: links — the reliable source
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) emails.add(m[1].toLowerCase());
  // 2. plain emails in the VISIBLE text only (never raw HTML/JS), with strict de-obfuscation.
  //    Only treat bracketed or whitespace-delimited at/dot as obfuscation — never substrings of words.
  const deob = text
    .replace(/[\[({]\s*at\s*[\])}]|\s+at\s+/gi, '@')
    .replace(/[\[({]\s*dot\s*[\])}]|\s+dot\s+/gi, '.');
  for (const m of deob.matchAll(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi)) emails.add(m[0].toLowerCase());

  const clean = [...emails]
    .map((e) => e.replace(/[.,;:]+$/, ''))
    .filter((e) => e.length < 50 && /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e) && !JUNK_EMAIL.test(e));
  // rank: same-domain first, then role addresses
  const score = (e) => (e.endsWith('@' + host) || e.endsWith('.' + host) ? 2 : 0) + (ROLE_RE.test(e.split('@')[0]) ? 1 : 0);
  const ranked = [...new Set(clean)].sort((a, b) => score(b) - score(a));

  const socials = {};
  for (const [k, re] of Object.entries(SOCIALS)) {
    const m = html.match(re);
    if (m) socials[k] = m[0].replace(/["'\\].*$/, '').replace(/\/$/, '');
  }

  // site phone fallback from tel: links
  let sitePhone = '';
  const tel = html.match(/tel:([+0-9().\-\s]{7,})/i);
  if (tel) sitePhone = tel[1].replace(/[^\d+]/g, '');

  return { email: ranked[0] || '', emails: ranked.slice(0, 5), socials, sitePhone };
}

function strip(u) {
  return String(u).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
}
