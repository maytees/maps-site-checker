// Server-only: open a Google Maps listing link in a headless browser and read
// the business's real website (the "authority" link, same one your extension clicks).
// One browser is shared across requests and auto-closed after a minute idle.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// stash on globalThis so Next.js hot-reload doesn't spawn a new browser each edit
const G = globalThis;
G.__msc = G.__msc || { browser: null, ctx: null, launching: null, idle: null };

function isMapsUrl(u) {
  return /google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(String(u || ''));
}

async function getContext() {
  if (G.__msc.ctx) return G.__msc.ctx;
  if (!G.__msc.launching) {
    G.__msc.launching = (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ locale: 'en-US', userAgent: UA, viewport: { width: 1280, height: 900 } });
      ctx.setDefaultTimeout(15000);
      G.__msc.browser = browser;
      G.__msc.ctx = ctx;
      return ctx;
    })();
  }
  return G.__msc.launching;
}

function touchIdle() {
  if (G.__msc.idle) clearTimeout(G.__msc.idle);
  G.__msc.idle = setTimeout(closeBrowser, 60000);
}

export async function closeBrowser() {
  const b = G.__msc.browser;
  G.__msc = { browser: null, ctx: null, launching: null, idle: null };
  if (b) await b.close().catch(() => {});
}

// Reads website + phone + open/closed from a listing in one visit.
// -> { status:'ok'|'none'|'blocked'|'failed', website?, phone?, businessStatus, error? }
export async function resolveWebsite(mapsUrl) {
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
