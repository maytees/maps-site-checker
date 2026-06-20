'use client';

import { useEffect, useRef, useState } from 'react';
import Papa from 'papaparse';

const LS = 'maps-site-checker.config.v1';

// want: the answer that makes a GOOD lead ('yes' | 'no' | '' = informational only)
const DEFAULT_CHECKS = [
  { key: 'boarding_or_daycare', want: 'yes', question: 'Does this business run an overnight BOARDING facility or a dog DAYCARE where pets stay on-site? Say yes even if it is a vet that also boards.' },
  { key: 'is_solo_operator', want: 'no', question: 'Is this a single individual / in-home pet-sitter or dog-walker, rather than a facility with multiple staff and a front desk?' },
  { key: 'has_webcams', want: 'no', question: 'Does it ALREADY offer live webcams/cameras for owners to watch their pet (puppy cam, live stream)? Security cameras or social photos do not count.' },
  { key: 'has_owner_update_app', want: 'no', question: 'Does it already use a pet-parent app or owner portal that sends photo/video/"report card" updates (e.g. Gingr, PetExec, Revelation Pets, "download our app", "live report cards")?' },
  { key: 'is_vet', want: '', question: 'Is this primarily a veterinary clinic / animal hospital?' },
];
const DEFAULT_INSTRUCTION =
  'I sell Petzio — software for pet BOARDING facilities, dog hotels, and daycares. It replaces the constant "how is my dog?" calls and texts from owners: owners request a photo/video/note update through a portal and staff fulfill it. ' +
  'My ideal customer is a STAFFED boarding or daycare facility whose team fields lots of owner update requests. ' +
  'Bad leads: solo dog-walkers / in-home pet sitters (no front desk), vet-only clinics that do not board, and facilities that already let owners watch pets via live webcams or already run a pet-parent update app / report-card portal (they have solved this problem).';

// ---------- small helpers ----------
const digits = (s) => String(s || '').replace(/\D/g, '');
function normPhone(s) {
  const d = digits(s);
  if (d.length >= 10) return d.slice(-10);
  return d || '';
}
function domainOf(s) {
  if (!s) return '';
  let v = String(s).trim().toLowerCase();
  if (/google\.[a-z.]+\/maps|goo\.gl\/maps/.test(v)) return ''; // maps link is not a website
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '');
  v = v.split(/[/?#]/)[0];
  return /\.[a-z]{2,}$/.test(v) ? v : '';
}
function cityFromAddress(v) {
  if (!v) return '';
  const s = String(v).trim();
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return s.length <= 30 ? s : '';
  // find "STATE ZIP" segment, city is the one before it
  const si = parts.findIndex((p) => /^[A-Za-z]{2}\s+\d{4,5}/.test(p) || /^[A-Z]{2}$/.test(p));
  if (si > 0) return parts[si - 1];
  return parts[parts.length - 2] || '';
}
function isMapsLink(v) { return /google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(String(v || '')); }

// De-dup identity: the Google Maps LISTING is the business (chains/facebook share a
// domain, so domain is a bad key). Fall back to phone, then domain, only if no link.
function dedupKey(maps, phone, website) {
  if (maps) return 'm:' + String(maps).trim().toLowerCase();
  const ph = normPhone(phone); if (ph) return 'p:' + ph;
  const d = domainOf(website); if (d) return 'd:' + d;
  return '';
}

// treat "-", "N/A", "·", etc. as an empty phone so the Maps resolver fills it
function isBlankPhone(v) {
  const s = String(v || '').trim();
  return !s || /^[\s\-–—·•|/.]+$/.test(s) || /^(n\/?a|none|null|tbd|n\.a\.?|-)$/i.test(s);
}
function fmtPhone(v) {
  if (!v) return '';
  let n = String(v).replace(/[^\d+]/g, '');
  if (n.startsWith('+1')) n = n.slice(2);
  else if (n.length === 11 && n.startsWith('1')) n = n.slice(1);
  if (/^\d{10}$/.test(n)) return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  return String(v).trim(); // non-US / unknown → leave as-is
}

// stable key for the per-lead CRM store (survives re-import): domain > phone > maps > name+city
const CRM_LS = 'maps-site-checker.crm.v1';
const CALL_STATUSES = ['new', 'called', 'interested', 'not interested', 'follow up'];
function crmKey(r) {
  return domainOf(r.finalUrl || r.website) || normPhone(r.phone) || (r.maps || '').slice(0, 80) ||
    ((r.name || '') + '|' + (r.city || '')).toLowerCase();
}

// Is this row a good lead? Uses each check's `want`; closed businesses are never a lead.
function leadOf(checks, r) {
  if (!r.verdict) return '';
  if (r.businessStatus && r.businessStatus !== 'open') return 'no';
  const wants = checks.filter((c) => c.key && (c.want === 'yes' || c.want === 'no'));
  if (!wants.length) return '';
  let anyUnclear = false;
  for (const c of wants) {
    const a = r.verdict[c.key];
    if (a === c.want) continue;
    if (a === 'unclear' || a == null) { anyUnclear = true; continue; }
    return 'no'; // clearly the wrong answer
  }
  return anyUnclear ? 'maybe' : 'yes';
}
const oppose = (w) => (w === 'yes' ? 'no' : 'yes');
function looksDomain(v) { return !!domainOf(v); }
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}
function looksPhone(v) { const d = digits(v); return d.length >= 10 && d.length <= 13; }
function looksAddress(v) { return /\d{1,6}\s+\S+/.test(v) && /,/.test(v); }

function guessIndex(headers, cols, kind) {
  const h = headers.map((x) => String(x).toLowerCase());
  const hHit = (re) => h.findIndex((x) => re.test(x));
  const sample = (i) => cols[i].filter(Boolean).slice(0, 20);
  const frac = (i, fn) => { const s = sample(i); return s.length ? s.filter(fn).length / s.length : 0; };
  if (kind === 'phone') {
    let i = hHit(/phone|tel|number/); if (i >= 0) return i;
    let best = -1, bf = 0.5; cols.forEach((_, i2) => { const f = frac(i2, looksPhone); if (f > bf) { bf = f; best = i2; } }); return best;
  }
  if (kind === 'website') {
    let i = hHit(/site|web|url|domain/); if (i >= 0) return i;
    let best = -1, bf = 0.5; cols.forEach((_, i2) => { const f = frac(i2, looksDomain); if (f > bf) { bf = f; best = i2; } }); return best;
  }
  if (kind === 'name') {
    let i = hHit(/name|title|label|business/); if (i >= 0) return i;
    return 0;
  }
  if (kind === 'cityaddr') {
    let i = hHit(/address|city|location|addr/); if (i >= 0) return i;
    let best = -1, bf = 0.4; cols.forEach((_, i2) => { const f = frac(i2, looksAddress); if (f > bf) { bf = f; best = i2; } }); return best;
  }
  if (kind === 'maps') { return hHit(/maps|link|google/); }
  return -1;
}

// ---------- component ----------
export default function Page() {
  const [headers, setHeaders] = useState(null); // unique display headers
  const [cols, setCols] = useState([]);         // column-major: cols[i] = array of values
  const [rowCount, setRowCount] = useState(0);
  const [fileName, setFileName] = useState('');
  const [over, setOver] = useState(false);

  const [map, setMap] = useState({ name: -1, phone: -1, website: -1, cityaddr: -1, maps: -1 });

  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [ollama, setOllama] = useState({ state: 'checking', error: '' });

  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION);
  const [checks, setChecks] = useState(DEFAULT_CHECKS);
  const [dedupe, setDedupe] = useState(true);
  const [resolveMaps, setResolveMaps] = useState(true);
  const [aiPick, setAiPick] = useState(true);
  const [findOwner, setFindOwner] = useState(false);
  const [verifyWebsite, setVerifyWebsite] = useState(false);
  const [concurrency, setConcurrency] = useState(4);
  const [resolveConc, setResolveConc] = useState(2);     // Maps lookups in parallel (captcha-sensitive)
  const [resolveGap, setResolveGap] = useState(1100);    // ms between Maps lookups
  const [useChrome, setUseChrome] = useState(false);     // use real Chrome profile instead of headless
  const [retrySecs, setRetrySecs] = useState(30);        // captcha'd rows are retried this often
  const [retryMsg, setRetryMsg] = useState('');          // live "retrying in Ns" status
  const resolveOpts = () => ({ resolveConcurrency: resolveConc, resolveGap, browserMode: useChrome ? 'chrome' : 'headless', resolveCooldown: Math.max(0, retrySecs) * 1000 });

  const [results, setResults] = useState(null); // [{name,phone,city,website,maps,status,verdict,error}]
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [runStart, setRunStart] = useState(0);
  const [runEnd, setRunEnd] = useState(0);
  const [runTotal, setRunTotal] = useState(0);
  // separate progress for the verify-website phase
  const [vDoneN, setVDoneN] = useState(0);
  const [vTotalN, setVTotalN] = useState(0);
  const [vStart, setVStart] = useState(0);
  const [vEnd, setVEnd] = useState(0);
  const [vCachedN, setVCachedN] = useState(0);
  const [, setTick] = useState(0); // forces a re-render every second while running
  const [hideBox, setHideBox] = useState(false);
  const [crm, setCrm] = useState({});       // { key: { status, notes } } — persisted, survives re-import
  const [maybeModel, setMaybeModel] = useState('');
  const [noCache, setNoCache] = useState(false);
  const [cacheInfo, setCacheInfo] = useState({ total: 0, scan: 0, resolve: 0 });
  const stopRef = useRef(false);

  async function refreshCache() { try { setCacheInfo(await fetch('/api/cache').then((x) => x.json())); } catch { /* ignore */ } }
  async function clearCache() {
    if (!confirm('Delete the saved scan cache? Future scans start fresh (your call statuses/notes are kept).')) return;
    await fetch('/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clear' }) });
    refreshCache();
    flash('Cache cleared');
  }

  // load the CRM store once
  useEffect(() => {
    try { setCrm(JSON.parse(localStorage.getItem(CRM_LS) || '{}')); } catch { /* ignore */ }
  }, []);
  function setCrmField(key, field, value) {
    setCrm((prev) => {
      const next = { ...prev, [key]: { ...prev[key], [field]: value } };
      try { localStorage.setItem(CRM_LS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  // tick the clock while a run is in progress
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // load saved config
  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(LS) || '{}');
      if (c.instruction) setInstruction(c.instruction);
      if (Array.isArray(c.checks) && c.checks.length) setChecks(c.checks);
      if (typeof c.dedupe === 'boolean') setDedupe(c.dedupe);
      if (typeof c.resolveMaps === 'boolean') setResolveMaps(c.resolveMaps);
      if (typeof c.aiPick === 'boolean') setAiPick(c.aiPick);
      if (typeof c.findOwner === 'boolean') setFindOwner(c.findOwner);
      if (typeof c.verifyWebsite === 'boolean') setVerifyWebsite(c.verifyWebsite);
      if (c.concurrency) setConcurrency(c.concurrency);
      if (c.resolveConc) setResolveConc(c.resolveConc);
      if (typeof c.resolveGap === 'number') setResolveGap(c.resolveGap);
      if (typeof c.useChrome === 'boolean') setUseChrome(c.useChrome);
      if (c.retrySecs) setRetrySecs(c.retrySecs);
      if (c.model) setModel(c.model);
    } catch {}
    refreshModels();
    refreshCache();
  }, []);

  // persist config
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(LS, JSON.stringify({ instruction, checks, dedupe, resolveMaps, aiPick, findOwner, verifyWebsite, concurrency, resolveConc, resolveGap, useChrome, retrySecs, model }));
    }, 300);
    return () => clearTimeout(t);
  }, [instruction, checks, dedupe, resolveMaps, aiPick, findOwner, verifyWebsite, concurrency, resolveConc, resolveGap, useChrome, retrySecs, model]);

  async function refreshModels() {
    setOllama({ state: 'checking', error: '' });
    try {
      const r = await fetch('/api/models').then((x) => x.json());
      if (!r.ok) { setOllama({ state: 'down', error: r.error || 'no response' }); return; }
      setModels(r.models);
      setOllama({ state: 'up', error: '' });
      setModel((m) => m && r.models.includes(m) ? m : (r.models.find((x) => /qwen2\.5/.test(x)) || r.models[0] || ''));
      setMaybeModel((m) => m && r.models.includes(m) ? m : (r.models.find((x) => /14b/.test(x)) || r.models.find((x) => /qwen2\.5:7b/.test(x)) || r.models[0] || ''));
    } catch (e) {
      setOllama({ state: 'down', error: String(e) });
    }
  }

  function onFile(file) {
    if (!file) return;
    setFileName(file.name);
    Papa.parse(file, {
      header: false,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const data = res.data.filter((r) => r.some((c) => String(c).trim() !== ''));
        if (!data.length) return;
        let raw = data[0].map((x) => String(x).replace(/^﻿/, '').trim());
        const seen = {};
        const uniq = raw.map((x) => {
          const base = x || 'col';
          seen[base] = (seen[base] || 0) + 1;
          return seen[base] > 1 ? `${base} #${seen[base]}` : base;
        });
        const body = data.slice(1);
        const colArr = uniq.map((_, i) => body.map((r) => (r[i] ?? '').toString()));
        setHeaders(uniq);
        setCols(colArr);
        setRowCount(body.length);
        setResults(null);
        setMap({
          name: guessIndex(raw, colArr, 'name'),
          phone: guessIndex(raw, colArr, 'phone'),
          website: guessIndex(raw, colArr, 'website'),
          cityaddr: guessIndex(raw, colArr, 'cityaddr'),
          maps: guessIndex(raw, colArr, 'maps'),
        });
      },
    });
  }

  function buildRows(doDedup = dedupe) {
    const get = (i, r) => (i >= 0 && cols[i] ? cols[i][r] || '' : '');
    const out = [];
    const seen = new Set();
    let dupCount = 0;
    for (let r = 0; r < rowCount; r++) {
      const name = get(map.name, r).replace(/\s*·\s*(Visited link|Visited).*$/i, '').trim();
      const phoneRaw = get(map.phone, r);
      const websiteRaw = get(map.website, r);
      const cityaddr = get(map.cityaddr, r);
      const mapsRaw = get(map.maps, r);
      // a real site only if it has a domain; if the "website" cell is itself a maps link, treat it as the maps source
      const realSite = domainOf(websiteRaw) ? websiteRaw.trim() : '';
      const mapsUrl = (mapsRaw.trim() || (isMapsLink(websiteRaw) ? websiteRaw.trim() : ''));
      const phoneClean = isBlankPhone(phoneRaw) ? '' : phoneRaw.trim();
      if (doDedup) {
        const key = dedupKey(mapsUrl, phoneClean, realSite);
        if (key && seen.has(key)) { dupCount++; continue; }
        if (key) seen.add(key);
      }
      out.push({
        name,
        phone: phoneClean,
        skip: false,
        city: cityFromAddress(cityaddr),
        website: realSite,
        maps: mapsUrl,
        businessStatus: '',
        email: '',
        socials: {},
        status: 'pending',
        verdict: null,
        error: '',
      });
    }
    return { rows: out, dupCount };
  }

  function getCleanChecks() {
    return checks
      .map((c) => ({ key: (c.key || '').trim().replace(/[^a-z0-9_]+/gi, '_').toLowerCase(), question: (c.question || '').trim(), want: c.want || '' }))
      .filter((c) => c.key && c.question);
  }

  // A "has X already" check (want: no) should be NO when the site doesn't show it, not unclear.
  function applyUnsureRule(verdict) {
    if (!verdict) return verdict;
    const v = { ...verdict };
    for (const c of checks) if (c.want === 'no' && v[c.key] === 'unclear') v[c.key] = 'no';
    return v;
  }

  // Phase 1: open each Maps listing, replace the CSV website with the real one (+ phone/closed).
  // --- shared resolve/scan helpers (used by run, verify, and the captcha retry loops) ---

  // Open the Maps listing, apply website/phone/closed to the row + results. Returns the raw rr.
  async function resolveInto(i, row) {
    setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'resolving' }; return c; });
    let rr;
    try {
      rr = await fetch('/api/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapsUrl: row.maps, noCache, ...resolveOpts() }),
      }).then((x) => x.json());
    } catch (e) { rr = { status: 'failed', error: String(e) }; }
    if (rr.phone && !row.phone) row.phone = rr.phone;
    if (rr.status === 'ok' && rr.website) { row.website = rr.website; row.finalUrl = rr.website; }
    row.businessStatus = rr.businessStatus || row.businessStatus || '';
    setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], phone: row.phone, website: row.website, finalUrl: row.finalUrl, businessStatus: row.businessStatus }; return c; });
    return rr;
  }

  // Scan a website and write the verdict + contacts into results[i].
  async function scanRow(i, row, website, cleanChecks) {
    setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'running' }; return c; });
    let res;
    try {
      res = await fetch('/api/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ website, businessName: row.name, model, instruction, checks: cleanChecks, noCache, aiPick, findOwner }),
      }).then((x) => x.json());
    } catch (e) { res = { ok: false, status: 'error', error: String(e) }; }
    setResults((prev) => {
      const c = prev.slice();
      c[i] = { ...c[i], phone: row.phone || res.sitePhone || '', status: res.status || (res.ok ? 'done' : 'error'), verdict: applyUnsureRule(res.verdict) || null, error: res.error || '', finalUrl: res.finalUrl || website, email: res.email || '', emails: res.emails || [], socials: res.socials || {}, sitePhone: res.sitePhone || '', cached: res.cached || false, ownerName: res.ownerName || '', ownerTitle: res.ownerTitle || '', linkedinUrl: res.linkedinUrl || '' };
      return c;
    });
  }

  // Sleep `secs`, showing a live countdown in retryMsg. Bails early if stopped.
  async function waitRetry(secs, n) {
    for (let s = secs; s > 0 && !stopRef.current; s--) {
      setRetryMsg(`⏳ ${n} captcha'd — retrying in ${s}s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setRetryMsg('');
  }

  // Phase 1: resolve every row's real website. Captcha'd rows aren't dropped —
  // they're retried every `retrySecs` until they go through. Phase 2: de-dup on verified data.
  async function verifyAndDedup(rows) {
    setVTotalN(rows.filter((r) => r.maps).length);
    setVDoneN(0); setVCachedN(0); setVStart(Date.now()); setVEnd(0);
    let next = 0, vDone = 0, vCached = 0;
    let blocked = [];
    const tick = (rr) => { vDone++; setVDoneN(vDone); if (rr.cached) { vCached++; setVCachedN(vCached); } };
    const work = async () => {
      while (!stopRef.current) {
        const i = next++;
        if (i >= rows.length) break;
        const row = rows[i];
        if (!row.maps) continue;
        const rr = await resolveInto(i, row);
        if (rr.status === 'blocked') {
          blocked.push(i);
          setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'maps-blocked' }; return c; });
        } else {
          setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'pending' }; return c; });
          tick(rr);
        }
      }
    };
    const n = Math.max(1, Math.min(10, concurrency));
    await Promise.all(Array.from({ length: n }, work));

    // retry the captcha'd ones every retrySecs until they all go through (or you stop)
    while (blocked.length && !stopRef.current) {
      await waitRetry(Math.max(5, retrySecs), blocked.length);
      if (stopRef.current) break;
      const still = [];
      for (const i of blocked) {
        if (stopRef.current) { still.push(i); continue; }
        const rr = await resolveInto(i, rows[i]);
        if (rr.status === 'blocked') {
          still.push(i);
          setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'maps-blocked' }; return c; });
        } else {
          setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'pending' }; return c; });
          tick(rr);
        }
      }
      blocked = still;
    }
    setVEnd(Date.now());

    if (!dedupe) return;
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = dedupKey(row.maps, row.phone, row.website);
      if (key && seen.has(key)) {
        row.skip = true;
        setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'duplicate' }; return c; });
      } else if (key) {
        seen.add(key);
      }
    }
  }

  async function run() {
    if (map.website < 0 && map.maps < 0) { alert('Map a Website column, or a Google Maps link column to resolve from (step 2).'); return; }
    if (!model) { alert('Pick a model (step 3). Is Ollama running?'); return; }
    const cleanChecks = getCleanChecks();
    if (!cleanChecks.length) { alert('Add at least one check (step 3).'); return; }

    // verify mode: resolve the real website from each Maps listing BEFORE de-duping,
    // so wrong/duplicate URLs in the CSV don't drop genuinely distinct businesses
    const verify = verifyWebsite && map.maps >= 0;
    const { rows, dupCount } = buildRows(verify ? false : dedupe);
    setResults(rows.map((r) => ({ ...r })));
    setDone(0);
    setVTotalN(0);
    setRunTotal(rows.length);
    setRunStart(Date.now());
    setRunEnd(0);
    setRunning(true);
    setHideBox(false);
    stopRef.current = false;

    if (verify) {
      await verifyAndDedup(rows);
      setDone(0);           // reset progress/rate for the scan phase
      setRunStart(Date.now());
      setRunEnd(0);
    }
    setRunTotal(rows.filter((r) => !r.skip).length);

    const prog = { done: 0 };
    const blocked = [];          // rows captcha'd while resolving — retried, never dropped
    const total = rows.length;

    // resolve-if-needed then scan one row. Returns 'blocked' if the Maps lookup got captcha'd.
    const processRow = async (i) => {
      const row = rows[i];
      let website = row.website;

      const needResolve = resolveMaps && row.maps && (!website || !row.phone);
      if (needResolve) {
        const rr = await resolveInto(i, row);
        website = row.website;
        if (rr.status === 'blocked' && !website) {
          setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'maps-blocked', error: rr.error || '' }; return c; });
          return 'blocked';
        }
        if (!website) {
          const st = rr.status === 'none' ? 'no-website' : 'resolve-failed';
          setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: st, error: rr.error || '' }; return c; });
          prog.done++; setDone(prog.done); return 'done';
        }
      }
      if (!website) {
        setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: row.maps ? 'maps-only' : 'no-website' }; return c; });
        prog.done++; setDone(prog.done); return 'done';
      }
      await scanRow(i, row, website, cleanChecks);
      prog.done++; setDone(prog.done); return 'done';
    };

    let next = 0;
    const worker = async () => {
      while (!stopRef.current) {
        const i = next++;
        if (i >= total) break;
        if (rows[i].skip) continue; // verified duplicate — don't scan
        const r = await processRow(i);
        if (r === 'blocked') blocked.push(i);
      }
    };
    const n = Math.max(1, Math.min(10, concurrency));
    await Promise.all(Array.from({ length: n }, worker));

    // retry captcha'd rows every retrySecs until they go through (or you stop)
    while (blocked.length && !stopRef.current) {
      await waitRetry(Math.max(5, retrySecs), blocked.length);
      if (stopRef.current) break;
      const still = [];
      for (const i of blocked) {
        if (stopRef.current) { still.push(i); continue; }
        const r = await processRow(i);
        if (r === 'blocked') still.push(i);
      }
      blocked.length = 0; blocked.push(...still);
    }

    setRunEnd(Date.now());
    setRunning(false);
    setRetryMsg('');
    refreshCache();
    if (dupCount) console.log(`Skipped ${dupCount} duplicate rows.`);
  }

  function stop() { stopRef.current = true; }

  // Re-scan only the rows the AI was unsure about, using a bigger model.
  async function rerunMaybes() {
    if (!results || running) return;
    const cleanChecks = getCleanChecks();
    if (!cleanChecks.length) return;
    const mdl = maybeModel || model;
    const idxs = results.map((r, i) => [r, i]).filter(([r]) => leadOf(checks, r) === 'maybe' && (r.finalUrl || r.website)).map(([, i]) => i);
    if (!idxs.length) { alert('No "maybe" rows with a website to re-run.'); return; }

    setDone(0);
    setRunTotal(idxs.length);
    setRunStart(Date.now());
    setRunEnd(0);
    setRunning(true);
    setHideBox(false);
    stopRef.current = false;

    let next = 0, finished = 0;
    const worker = async () => {
      while (!stopRef.current) {
        const k = next++;
        if (k >= idxs.length) break;
        const i = idxs[k];
        const row = results[i];
        const website = row.finalUrl || row.website;
        setResults((prev) => { const c = prev.slice(); c[i] = { ...c[i], status: 'running' }; return c; });
        let res;
        try {
          res = await fetch('/api/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ website, businessName: row.name, model: mdl, instruction, checks: cleanChecks, noCache, aiPick, findOwner }),
          }).then((x) => x.json());
        } catch (e) { res = { ok: false, status: 'error', error: String(e) }; }
        setResults((prev) => {
          const c = prev.slice();
          c[i] = { ...c[i], status: res.status || (res.ok ? 'done' : 'error'), verdict: applyUnsureRule(res.verdict) || c[i].verdict, error: res.error || '',
            email: res.email || c[i].email, socials: res.socials || c[i].socials, phone: c[i].phone || res.sitePhone || '', cached: res.cached || false,
            ownerName: res.ownerName || c[i].ownerName, ownerTitle: res.ownerTitle || c[i].ownerTitle, linkedinUrl: res.linkedinUrl || c[i].linkedinUrl };
          return c;
        });
        finished++; setDone(finished);
      }
    };
    const n = Math.max(1, Math.min(10, concurrency));
    await Promise.all(Array.from({ length: n }, worker));
    setRunEnd(Date.now());
    setRunning(false);
    refreshCache();
  }

  // ---------- export ----------
  const exportCols = () => {
    const ck = checks.map((c) => c.key).filter(Boolean);
    return ['lead', 'call_status', 'name', 'phone', 'email', 'owner', 'owner_title', 'linkedin', 'city', 'website', 'business_status',
      ...ck, 'franchise', 'team_size', 'locations', 'business_type', 'confidence', 'ai_notes', 'my_notes',
      'instagram', 'facebook', 'other_emails', 'status', 'maps_link'];
  };
  function rowValues(r) {
    const v = r.verdict || {};
    const c = crm[crmKey(r)] || {};
    const s = r.socials || {};
    const ck = checks.map((x) => x.key).filter(Boolean).map((k) => v[k] || '');
    return [leadOf(checks, r), c.status || 'new', r.name, fmtPhone(r.phone), r.email || '', r.ownerName || '', r.ownerTitle || '', r.linkedinUrl || '', r.city, r.finalUrl || r.website, r.businessStatus || '',
      ...ck, v.franchise || '', v.team_size || '', v.locations || '', v.business_type || '', v.confidence || '', v.notes || '', c.notes || '',
      s.instagram || '', s.facebook || '', (r.emails || []).slice(1).join(' '), r.status, r.maps];
  }
  function exportCSV() {
    if (!results) return;
    const q = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const lines = [exportCols().map(q).join(',')];
    for (const r of results) lines.push(rowValues(r).map(q).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (fileName.replace(/\.csv$/i, '') || 'scan') + '_checked.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function copyTSV() {
    if (!results) return;
    const clean = (x) => String(x == null ? '' : x).replace(/[\t\r\n]+/g, ' ');
    const lines = [exportCols().join('\t')];
    for (const r of results) lines.push(rowValues(r).map(clean).join('\t'));
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => flash('Copied — paste into Google Sheets'),
      () => flash('Copy failed — use Export CSV')
    );
  }
  const [msg, setMsg] = useState('');
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 2500); }

  // ---------- derived ----------
  const counts = results ? results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}) : {};
  const total = runTotal || (results ? results.length : 0);
  const maybeCount = results ? results.filter((r) => leadOf(checks, r) === 'maybe').length : 0;
  const skipCount = results ? results.filter((r) => leadOf(checks, r) === 'no').length : 0;
  const emailCount = results ? results.filter((r) => r.email).length : 0;
  const phoneCount = results ? results.filter((r) => r.phone).length : 0;
  const franchiseCount = results ? results.filter((r) => r.verdict && r.verdict.franchise === 'yes').length : 0;
  const cachedCount = results ? results.filter((r) => r.cached).length : 0;
  const vElapsedMs = vStart ? (vEnd || Date.now()) - vStart : 0;
  const vRatePerMin = vElapsedMs > 1000 && (vDoneN - vCachedN) > 0 ? (vDoneN - vCachedN) / (vElapsedMs / 60000) : 0;
  const vActive = vTotalN > 0 && vDoneN < vTotalN && !vEnd;
  const elapsedMs = runStart ? (runEnd || Date.now()) - runStart : 0;
  // rate = REAL scans per minute (cached hits are ~instant and would inflate it)
  const realDone = Math.max(0, done - cachedCount);
  const ratePerMin = elapsedMs > 1000 && realDone > 0 ? realDone / (elapsedMs / 60000) : 0;
  const remaining = total - done;
  const cachedFrac = done > 0 ? cachedCount / done : 0;     // assume remaining have a similar cached share
  const etaMs = ratePerMin > 0 && remaining > 0 ? ((remaining * (1 - cachedFrac)) / ratePerMin) * 60000 : 0;
  const leads = results ? results.filter((r) => leadOf(checks, r) === 'yes').length : 0;
  const inProg = results ? results.filter((r) => r.status === 'running' || r.status === 'resolving') : [];

  // ---------- render ----------
  return (
    <div className="wrap">
      <div className="top">
        <span className="brand-dot" />
        <h1>Maps Site Checker</h1>
        <span className="sub">CSV → map columns → scan each website with local AI → call list</span>
      </div>

      {/* STEP 1 — import */}
      <section className="step">
        <div className="step-head"><span className="step-num">1</span><h2>Import CSV</h2></div>
        <label
          className={'drop' + (over ? ' over' : '')}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}
        >
          <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files[0])} />
          {headers
            ? <div><b>{fileName}</b> — {rowCount} rows, {headers.length} columns. <span className="muted">Click to load a different file.</span></div>
            : <div>Drop a CSV here, or click to choose. <div className="tiny mt">Any CSV — you map the columns in the next step.</div></div>}
        </label>
      </section>

      {/* STEP 2 — map columns */}
      <section className={'step' + (headers ? '' : ' disabled')}>
        <div className="step-head"><span className="step-num">2</span><h2>Map your columns</h2></div>
        <div className="grid-map">
          <ColSelect label="Name" headers={headers} value={map.name} onChange={(v) => setMap({ ...map, name: v })} cols={cols} />
          <ColSelect label="Phone" headers={headers} value={map.phone} onChange={(v) => setMap({ ...map, phone: v })} cols={cols} />
          <ColSelect label="Website / site  (required)" headers={headers} value={map.website} onChange={(v) => setMap({ ...map, website: v })} cols={cols} />
          <ColSelect label="City or Address" headers={headers} value={map.cityaddr} onChange={(v) => setMap({ ...map, cityaddr: v })} cols={cols} hint="city is auto-parsed from an address" />
          <ColSelect label="Google Maps link (optional)" headers={headers} value={map.maps} onChange={(v) => setMap({ ...map, maps: v })} cols={cols} />
        </div>
        {headers && map.website < 0 && map.maps >= 0 &&
          <div className="pill mt2">No website column — that's fine: it'll open each <b>Google Maps link</b> in a headless browser and read the site automatically (slower). Toggle in step 3.</div>}
        {headers && map.website < 0 && map.maps < 0 &&
          <div className="pill err mt2">Map a <b>Website</b> column, or a <b>Google Maps link</b> column so it can resolve the site for you.</div>}
      </section>

      {/* STEP 3 — configure */}
      <section className={'step' + (headers ? '' : ' disabled')}>
        <div className="step-head"><span className="step-num">3</span><h2>What to check</h2></div>

        <div className="row spread">
          <div className="row" style={{ gap: 8 }}>
            <span className="muted small">Local model:</span>
            <select style={{ width: 220 }} value={model} onChange={(e) => setModel(e.target.value)}>
              {models.length === 0 && <option value="">(no models found)</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="sm ghost" onClick={refreshModels}>↻</button>
            {ollama.state === 'up' && <span className="pill ok"><span className="dot green" />Ollama</span>}
            {ollama.state === 'down' && <span className="pill err" title={ollama.error}><span className="dot red" />Ollama offline</span>}
            {ollama.state === 'checking' && <span className="pill"><span className="dot grey" />checking…</span>}
          </div>
          <label className="row small muted" style={{ gap: 6 }} title="How many businesses to process at once. Higher = faster but heavier.">
            parallel
            <input type="number" min={1} max={10} value={concurrency} style={{ width: 56 }} onChange={(e) => setConcurrency(+e.target.value || 1)} />
          </label>
        </div>

        <div className="mt2">
          <label className="fld">AI instruction (context for every site)
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          </label>
        </div>

        <div className="mt2">
          <div className="row spread">
            <h2 style={{ fontSize: 12 }}>Checks — each is a yes/no/unclear column. “Want” = the answer that makes a good lead (drives the Lead column &amp; colors).</h2>
            <div className="row" style={{ gap: 6 }}>
              <button className="sm" onClick={() => { setChecks(DEFAULT_CHECKS.map((c) => ({ ...c }))); setInstruction(DEFAULT_INSTRUCTION); }}>↺ defaults</button>
              <button className="sm" onClick={() => setChecks([...checks, { key: '', question: '', want: '' }])}>+ add check</button>
            </div>
          </div>
          <div className="checks mt">
            {checks.map((c, i) => (
              <div className="check" key={i}>
                <input type="text" placeholder="column_key" value={c.key}
                  onChange={(e) => { const n = checks.slice(); n[i] = { ...n[i], key: e.target.value }; setChecks(n); }} />
                <input type="text" placeholder="Yes/no question for the AI" value={c.question}
                  onChange={(e) => { const n = checks.slice(); n[i] = { ...n[i], question: e.target.value }; setChecks(n); }} />
                <select value={c.want || ''} title="Answer that makes a good lead"
                  onChange={(e) => { const n = checks.slice(); n[i] = { ...n[i], want: e.target.value }; setChecks(n); }}>
                  <option value="">info only</option>
                  <option value="yes">want yes</option>
                  <option value="no">want no</option>
                </select>
                <button className="sm danger" onClick={() => setChecks(checks.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
          <label className="row small muted mt2" style={{ gap: 7 }}>
            <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
            Skip duplicates — same Google Maps listing (falls back to phone, then domain). Chains/franchises that share a website are KEPT, not collapsed.
          </label>
          <label className="row small muted" style={{ gap: 7, marginTop: 6 }}>
            <input type="checkbox" checked={resolveMaps} onChange={(e) => setResolveMaps(e.target.checked)} />
            Resolve the website from the Google Maps link when a row has no site (headless browser — slower, needed for Maps-link-only CSVs)
          </label>
          <div className="row small muted" style={{ gap: 12, marginTop: 6, paddingLeft: 22, flexWrap: 'wrap' }}>
            <span style={{ color: '#9ec1ff' }}>Maps lookups (anti-captcha) —</span>
            <label className="row" style={{ gap: 5 }} title="How many Google Maps listings to open at once. Lower = less likely to get captcha'd.">
              parallel <input type="number" min={1} max={6} value={resolveConc} style={{ width: 52 }} onChange={(e) => setResolveConc(Math.max(1, +e.target.value || 1))} />
            </label>
            <label className="row" style={{ gap: 5 }} title="Pause between Maps lookups. Higher = politer.">
              delay <input type="number" min={0} step={100} value={resolveGap} style={{ width: 66 }} onChange={(e) => setResolveGap(Math.max(0, +e.target.value || 0))} /> ms
            </label>
            <label className="row" style={{ gap: 5 }} title="Captcha'd lookups aren't dropped — they're retried this often until they go through.">
              retry captcha'd every <input type="number" min={5} step={5} value={retrySecs} style={{ width: 54 }} onChange={(e) => setRetrySecs(Math.max(5, +e.target.value || 30))} /> s
            </label>
            <label className="row" style={{ gap: 6 }} title="Opens a real Chrome window instead of headless. Sign into Google once in it — logged-in Chrome gets captcha'd far less.">
              <input type="checkbox" checked={useChrome} onChange={(e) => setUseChrome(e.target.checked)} /> use my real Chrome
            </label>
          </div>
          {useChrome &&
            <span className="pill" style={{ marginTop: 4 }}>A real Chrome window opens on the next lookup — <b>sign into Google in it once</b> and it remembers (needs Chrome installed). Getting captcha'd? Drop parallel to 1 and raise the delay.</span>}
          <label className="row small muted" style={{ gap: 7, marginTop: 6 }}>
            <input type="checkbox" checked={aiPick} onChange={(e) => setAiPick(e.target.checked)} />
            🧠 Let the AI pick which pages to read from the sitemap (smarter than keyword matching; +1 quick AI call per site). Off = faster, keyword-picked.
          </label>
          <label className="row small muted" style={{ gap: 7, marginTop: 6 }}>
            <input type="checkbox" checked={findOwner} onChange={(e) => setFindOwner(e.target.checked)} />
            🔗 Find the owner / decision-maker + LinkedIn (Google-searches via Serper — needs <code>SERPER_API_KEY</code> in <code>.env</code>; never scrapes LinkedIn).
          </label>
          <label className="row small muted" style={{ gap: 7, marginTop: 6 }}>
            <input type="checkbox" checked={verifyWebsite} onChange={(e) => setVerifyWebsite(e.target.checked)} />
            🔁 Verify each website from its Google Maps listing BEFORE de-duplicating (fixes CSVs where many rows share a wrong/duplicate URL — dedup then uses the real sites). Needs a Maps link column; uses the headless browser, slower.
          </label>
          {verifyWebsite && map.maps < 0 &&
            <span className="pill err" style={{ marginTop: 4 }}>Map a <b>Google Maps link</b> column (step 2) for verification to run.</span>}
        </div>
      </section>

      {/* STEP 4 — run */}
      <section className={'step' + (headers ? '' : ' disabled')}>
        <div className="step-head"><span className="step-num">4</span><h2>Run &amp; export</h2></div>
        <div className="row">
          {!running
            ? <button className="primary" onClick={run} disabled={!headers || (map.website < 0 && map.maps < 0) || !model}>▶ Scan {rowCount ? `${rowCount} rows` : ''}</button>
            : <button className="danger" onClick={stop}><span className="spin" /> Stop</button>}
          <button onClick={exportCSV} disabled={!results}>⬇ Export CSV</button>
          <button onClick={copyTSV} disabled={!results}>⧉ Copy for Sheets</button>
          {msg && <span className="pill ok">{msg}</span>}
        </div>

        <div className="row mt small" style={{ gap: 12 }}>
          <label className="row muted" style={{ gap: 6 }} title="Done businesses are saved to data/cache.jsonl. Re-running skips them instantly; tick this to force a fresh scan.">
            <input type="checkbox" checked={noCache} onChange={(e) => setNoCache(e.target.checked)} />
            Ignore saved cache (re-scan fresh)
          </label>
          <button className="sm ghost" onClick={clearCache} disabled={!cacheInfo.total}>Clear cache ({cacheInfo.total})</button>
          <span className="muted tiny">{cacheInfo.scan} sites · {cacheInfo.resolve} maps saved — survives restarts, skips repeats on re-import</span>
        </div>

        {results && maybeCount > 0 &&
          <div className="row mt small" style={{ gap: 8 }}>
            <span className="muted">Unsure rows?</span>
            <button onClick={rerunMaybes} disabled={running}>↻ Re-run {maybeCount} maybe{maybeCount === 1 ? '' : 's'} with</button>
            <select style={{ width: 150 }} value={maybeModel} onChange={(e) => setMaybeModel(e.target.value)}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="muted tiny">a bigger model is more accurate, just slower</span>
          </div>}

        {results &&
          <>
            {vTotalN > 0 &&
              <div className="vphase">
                <div className="row spread small">
                  <b style={{ color: '#9ec1ff' }}>🔁 {vActive ? 'Verifying websites from Google Maps…' : 'Website verification done'}</b>
                  <span className="muted">
                    {vDoneN}/{vTotalN} · ⚡ {vRatePerMin ? vRatePerMin.toFixed(1) : '—'}/min
                    {vCachedN > 0 ? ` · ♻ ${vCachedN} cached` : ''}
                    {vActive ? ` · ⏱ ${fmtDur(vElapsedMs)}` : ''}
                  </span>
                </div>
                <div className="bar"><i className="blue" style={{ width: vTotalN ? `${(vDoneN / vTotalN) * 100}%` : 0 }} /></div>
              </div>}
            <div className="bar"><i style={{ width: total ? `${(done / total) * 100}%` : 0 }} /></div>
            <div className="row mt small" style={{ gap: 14 }}>
              <span className="pill">{done}/{total} done</span>
              <span className="pill" title="elapsed time">⏱ {fmtDur(elapsedMs)}</span>
              <span className="pill" title="real scans per minute (excludes instant cache hits)">⚡ {ratePerMin ? ratePerMin.toFixed(1) : '—'}/min</span>
              {cachedCount > 0 && <span className="pill" title="served instantly from the saved cache">♻ {cachedCount} cached</span>}
              {retryMsg && <span className="pill" style={{ background: 'var(--warn-bg)', color: 'var(--warn)', borderColor: '#5a4a2a' }}>{retryMsg}</span>}
              {running && !retryMsg && etaMs > 0 && <span className="pill" title="estimated time left">⏳ ~{fmtDur(etaMs)} left</span>}
            </div>
            <div className="statbar">
              <Stat n={leads} label="✓ call" cls="s-yes" />
              <Stat n={maybeCount} label="~ maybe" cls="s-maybe" />
              <Stat n={skipCount} label="skip" cls="s-no" />
              <Stat n={emailCount} label="✉ emails" cls="s-info" />
              <Stat n={phoneCount} label="☎ phones" cls="s-info" />
              <Stat n={franchiseCount} label="⛓ chains" cls="s-chain" />
            </div>
            <div className="row mt small muted" style={{ gap: 14 }}>
              {Object.entries(counts).map(([k, v]) => <span key={k}><StatusTag status={k} /> {v}</span>)}
            </div>
            <ResultsTable results={results} checks={checks} crm={crm} onCrm={setCrmField} />
          </>}
      </section>

      {results && !hideBox &&
        <ActivityBox running={running} inProg={inProg} done={done} total={total} leads={leads} rate={ratePerMin} onClose={() => setHideBox(true)} />}
    </div>
  );
}

function ActivityBox({ running, inProg, done, total, leads, rate, onClose }) {
  const nm = (r) => (r?.name || 'this business').slice(0, 28);
  const more = inProg.length > 1 ? ` (+${inProg.length - 1} more)` : '';
  let main;
  if (running) {
    const r = inProg[0];
    if (!r) main = <><span className="spin" /> Starting…</>;
    else if (r.status === 'resolving') main = <><span className="spin" /> 🔎 Finding website — {nm(r)}{more}</>;
    else main = <><span className="spin" /> 🤖 Asking AI — {nm(r)}{more}</>;
  } else {
    main = <>✓ Finished scanning</>;
  }
  return (
    <div className="activity">
      <button className="a-close" title="hide" onClick={onClose}>✕</button>
      <div className="a-main">{main}</div>
      <div className="a-sub">{done}/{total} done · {leads} lead{leads === 1 ? '' : 's'}{rate ? ` · ${rate.toFixed(1)}/min` : ''}</div>
    </div>
  );
}

function ColSelect({ label, headers, value, onChange, cols, hint }) {
  const sample = headers && value >= 0 && cols[value] ? cols[value].find((x) => String(x).trim()) : '';
  return (
    <label className="fld">
      {label}
      <select value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} disabled={!headers}>
        <option value={-1}>— none —</option>
        {headers && headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
      </select>
      {sample ? <span className="tiny muted" title={sample}>e.g. {String(sample).slice(0, 38)}</span> : hint ? <span className="tiny muted">{hint}</span> : <span className="tiny">&nbsp;</span>}
    </label>
  );
}

function StatusTag({ status }) {
  const labelMap = {
    pending: 'pending', resolving: 'finding site…', running: 'scanning…', done: 'done',
    'no-website': 'no website', 'maps-only': 'maps link only',
    'resolve-failed': "couldn't open maps", 'maps-blocked': 'google blocked',
    'fetch-failed': 'site unreachable', 'empty-site': 'no text', 'ai-error': 'AI error', error: 'error',
    duplicate: 'duplicate',
  };
  return <span className={`tag status-${status}`}>{labelMap[status] || status}</span>;
}

function Verdict({ v, want }) {
  if (!v) return <span className="muted">—</span>;
  let cls = 'unclear';
  if (want === 'yes' || want === 'no') cls = v === want ? 'yes' : v === oppose(want) ? 'no' : 'unclear';
  return <span className={`tag ${cls}`}>{v}</span>;
}

function Stat({ n, label, cls }) {
  return (
    <div className={'stat ' + cls}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function LeadTag({ lead }) {
  if (!lead) return <span className="muted">—</span>;
  const cls = lead === 'yes' ? 'yes' : lead === 'no' ? 'no' : 'maybe';
  const label = lead === 'yes' ? '✓ call' : lead === 'no' ? 'skip' : 'maybe';
  return <span className={`tag ${cls}`}>{label}</span>;
}

function OpenCell({ s }) {
  if (!s || s === 'open') return <span className="muted">{s ? 'open' : ''}</span>;
  return <span className="tag no">{s === 'permanently_closed' ? 'closed' : 'temp closed'}</span>;
}

function SizeCell({ v }) {
  const t = v.team_size, l = v.locations;
  if (!t && !l) return <span className="muted">—</span>;
  const tl = { solo: 'solo', small_team: 'team', large_team: 'big', '': '' };
  return <span className="muted tiny">{tl[t] || ''}{t && l ? ' · ' : ''}{l === 'multiple' ? 'multi' : l === 'single' ? '1 loc' : ''}</span>;
}

function ResultsTable({ results, checks, crm, onCrm }) {
  const cks = checks.filter((c) => c.key);
  const showOwner = results.some((r) => r.ownerName || r.linkedinUrl);
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Lead</th><th>Call</th><th>Name</th><th>Phone</th><th>Email</th>{showOwner && <><th>Owner</th><th>LinkedIn</th></>}<th>City</th><th>Site</th><th>Open?</th>
            {cks.map((c) => <th key={c.key}>{c.key}</th>)}
            <th>chain?</th><th>size</th><th>type</th><th>Status</th><th>AI note</th><th>My notes</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const v = r.verdict || {};
            const key = crmKey(r);
            const cr = crm[key] || {};
            const dom = domainOf(r.finalUrl || r.website);
            const s = r.socials || {};
            return (
              <tr key={i}>
                <td><LeadTag lead={leadOf(checks, r)} /></td>
                <td>
                  <select className={'callsel cs-' + (cr.status || 'new').replace(/\s/g, '-')} value={cr.status || 'new'} onChange={(e) => onCrm(key, 'status', e.target.value)}>
                    {CALL_STATUSES.map((s2) => <option key={s2} value={s2}>{s2}</option>)}
                  </select>
                </td>
                <td title={r.finalUrl || r.website}>{r.name || <span className="muted">—</span>}</td>
                <td>{r.phone ? <a href={`tel:${r.phone}`}>{fmtPhone(r.phone)}</a> : <span className="muted">—</span>}</td>
                <td>{r.email
                  ? <span><a href={`mailto:${r.email}`}>{r.email.length > 22 ? r.email.slice(0, 21) + '…' : r.email}</a>{s.instagram ? <a href={s.instagram} target="_blank" rel="noreferrer" title="Instagram"> ◎</a> : null}</span>
                  : (s.instagram || s.facebook) ? <a href={s.instagram || s.facebook} target="_blank" rel="noreferrer" className="muted">social↗</a> : <span className="muted">—</span>}</td>
                {showOwner && <td title={r.ownerTitle || ''} className="muted">{r.ownerName || '—'}</td>}
                {showOwner && <td>{r.linkedinUrl ? <a href={r.linkedinUrl} target="_blank" rel="noreferrer" title={r.linkedinUrl}>in↗</a> : <span className="muted">—</span>}</td>}
                <td>{r.city}</td>
                <td className="muted">{dom ? <a href={r.finalUrl || r.website} target="_blank" rel="noreferrer">{dom}</a> : (r.maps ? <a href={r.maps} target="_blank" rel="noreferrer" title={r.maps}>maps↗</a> : '')}</td>
                <td><OpenCell s={r.businessStatus} /></td>
                {cks.map((c) => <td key={c.key}><Verdict v={v[c.key]} want={c.want} /></td>)}
                <td>{v.franchise === 'yes' ? <span className="tag chain">chain</span> : <span className="muted">—</span>}</td>
                <td><SizeCell v={v} /></td>
                <td className="muted">{v.business_type || ''}</td>
                <td><StatusTag status={r.status} /></td>
                <td className="wrap-cell" title={v.notes || r.error || ''}>{(v.notes || r.error || '').slice(0, 70)}</td>
                <td><input className="notein" value={cr.notes || ''} placeholder="…" onChange={(e) => onCrm(key, 'notes', e.target.value)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
