// Server-only: open a Google Maps listing link in a browser and read the
// business's real website (the "authority" link, same one your extension clicks).
// Headless by default; can use your real Chrome (persistent profile) — logged-in
// Chrome gets captcha'd far less. One browser shared across requests, auto-closed idle.
import path from 'path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// stash on globalThis so Next.js hot-reload doesn't spawn a new browser each edit
const G = globalThis;
G.__msc = G.__msc || { browser: null, ctx: null, launching: null, idle: null, mode: 'headless', profileDir: '' };

function isMapsUrl(u) {
  return /google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(String(u || ''));
}

// Apply UI settings: throttle rate + browser mode. Relaunch the browser if the mode changed.
export function configure({ concurrency, gapMs, cooldownMs, browserMode, profileDir } = {}) {
  if (concurrency != null) THR.max = Math.max(1, Math.min(6, Number(concurrency) || 2));
  if (gapMs != null) THR.gapMs = Math.max(0, Number(gapMs) || 0);
  if (cooldownMs != null) THR.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
  const mode = browserMode === 'chrome' ? 'chrome' : 'headless';
  const dir = profileDir || G.__msc.profileDir || path.join(process.cwd(), 'data', 'chrome-profile');
  if (mode !== G.__msc.mode || (mode === 'chrome' && dir !== G.__msc.profileDir)) {
    G.__msc.mode = mode;
    G.__msc.profileDir = dir;
    closeBrowser(); // next getContext() relaunches in the new mode
  }
}

async function getContext() {
  if (G.__msc.ctx) return G.__msc.ctx;
  if (!G.__msc.launching) {
    G.__msc.launching = (async () => {
      const { chromium } = await import('playwright');
      if (G.__msc.mode === 'chrome') {
        // real Chrome with a persistent profile (sign into Google once in the window → fewer captchas)
        const ctx = await chromium.launchPersistentContext(G.__msc.profileDir, {
          headless: false, channel: 'chrome', locale: 'en-US', viewport: { width: 1280, height: 900 },
        });
        ctx.setDefaultTimeout(20000);
        G.__msc.browser = null;
        G.__msc.persistent = ctx;
        G.__msc.ctx = ctx;
        return ctx;
      }
      const browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ locale: 'en-US', userAgent: UA, viewport: { width: 1280, height: 900 } });
      ctx.setDefaultTimeout(15000);
      G.__msc.browser = browser;
      G.__msc.persistent = null;
      G.__msc.ctx = ctx;
      return ctx;
    })();
  }
  return G.__msc.launching;
}

function touchIdle() {
  if (G.__msc.idle) clearTimeout(G.__msc.idle);
  G.__msc.idle = setTimeout(closeBrowser, 120000);
}

export async function closeBrowser() {
  const b = G.__msc.browser, p = G.__msc.persistent;
  const { mode, profileDir } = G.__msc;
  G.__msc = { browser: null, ctx: null, launching: null, idle: null, persistent: null, mode, profileDir };
  if (p) await p.close().catch(() => {});
  if (b) await b.close().catch(() => {});
}

// ---- politeness throttle: keep Google from captcha-ing us ----------------
// At most MAX concurrent listing opens, with a spaced+jittered gap between
// starts. On a captcha ('blocked') everything pauses for COOLDOWN.
const THR = {
  max: Number(process.env.RESOLVE_CONCURRENCY || 2),
  gapMs: Number(process.env.RESOLVE_GAP_MS || 1100),
  jitterMs: 700,
  cooldownMs: Number(process.env.RESOLVE_COOLDOWN_MS || 90000),
  running: 0,
  lastStart: 0,
  cooldownUntil: 0,
  waiters: [],
};

function pumpThrottle() {
  if (!THR.waiters.length || THR.running >= THR.max) return;
  const now = Date.now();
  const wait = Math.max(THR.cooldownUntil - now, THR.gapMs + Math.round(Math.random() * THR.jitterMs) - (now - THR.lastStart));
  if (wait > 0) { setTimeout(pumpThrottle, wait + 10); return; }
  const next = THR.waiters.shift();
  THR.running++;
  THR.lastStart = now;
  next();
}
function acquireSlot() { return new Promise((res) => { THR.waiters.push(res); pumpThrottle(); }); }
function releaseSlot() { THR.running = Math.max(0, THR.running - 1); pumpThrottle(); }

// throttled public entry; on captcha, trigger a cooldown so the rest back off
export async function resolveWebsite(mapsUrl) {
  if (!isMapsUrl(mapsUrl)) return { status: 'failed', error: 'not a Google Maps link', businessStatus: '' };
  await acquireSlot();
  try {
    const r = await runResolve(mapsUrl);
    if (r.status === 'blocked') { THR.cooldownUntil = Date.now() + THR.cooldownMs; }
    return r;
  } finally {
    releaseSlot();
  }
}

// Reads website + phone + open/closed from a listing in one visit.
// -> { status:'ok'|'none'|'blocked'|'failed', website?, phone?, businessStatus, error? }
async function runResolve(mapsUrl) {
  if (!isMapsUrl(mapsUrl)) return { status: 'failed', error: 'not a Google Maps link', businessStatus: '' };
  let ctx;
  try {
    ctx = await getContext();
  } catch (e) {
    return { status: 'failed', error: 'could not start headless browser: ' + String(e.message || e), businessStatus: '' };
  }
  touchIdle();
  const page = await ctx.newPage();
  try {
    // block heavy assets — we only need the place panel DOM
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    if (/\/sorry\/|\/consent|consent\.google/i.test(page.url())) {
      const btn = await page.$('button[aria-label*="Accept"], form[action*="consent"] button, button:has-text("Accept all")');
      if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (/\/sorry\//i.test(page.url())) return { status: 'blocked', error: 'Google captcha — slow down / try later', businessStatus: '' };

    const sel = 'a[data-item-id="authority"], a[data-item-id^="authority"]';
    await page.waitForSelector('h1, ' + sel, { timeout: 12000 }).catch(() => {});

    // pull website, phone, and closed-state together from the panel
    const data = await page.evaluate(() => {
      const out = { href: null, phone: '', closed: '' };
      const a = document.querySelector('a[data-item-id="authority"], a[data-item-id^="authority"]');
      if (a) out.href = a.href;
      const pb = document.querySelector('button[data-item-id^="phone:tel:"], a[data-item-id^="phone:tel:"]');
      if (pb) {
        const id = pb.getAttribute('data-item-id') || '';
        const m = id.match(/phone:tel:(.+)$/);
        out.phone = m ? m[1] : (pb.getAttribute('aria-label') || '').replace(/^.*?:/, '').trim();
      }
      const body = (document.body.innerText || '');
      if (/permanently closed/i.test(body)) out.closed = 'permanently_closed';
      else if (/temporarily closed/i.test(body)) out.closed = 'temporarily_closed';
      return out;
    }).catch(() => ({ href: null, phone: '', closed: '' }));

    const businessStatus = data.closed || 'open';
    let href = data.href;
    if (href) {
      try { const u = new URL(href); if (/google\./i.test(u.hostname) && u.searchParams.get('q')) href = u.searchParams.get('q'); } catch {}
      return { status: 'ok', website: href, phone: data.phone, businessStatus };
    }
    const hasPanel = await page.$('h1, [role="main"]');
    return { status: hasPanel ? 'none' : 'failed', error: hasPanel ? 'no website on listing' : 'place panel did not load', phone: data.phone, businessStatus };
  } catch (e) {
    return { status: 'failed', error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e).split('\n')[0], businessStatus: '' };
  } finally {
    await page.close().catch(() => {});
    touchIdle();
  }
}
