// Find a business's decision-maker (CEO > owner/founder > senior marketing) and
// their LinkedIn URL — Clay-style. Name comes from the site text we crawl; LinkedIn
// comes from a Google search (Serper), NEVER from visiting LinkedIn. The picked
// profile is verified to actually belong to THIS company (guards wrong same-name
// people in other states). Local Ollama only reads text + result snippets.
import { chatJson } from '@/lib/ollama';
import { serperSearch, linkedinInUrls } from '@/lib/serper';
import { log } from '@/lib/log';

// generic words that don't identify a specific company
const GENERIC = new Set(['pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'puppy', 'boarding', 'kennel', 'kennels',
  'lodge', 'lodging', 'daycare', 'day', 'care', 'inc', 'llc', 'co', 'corp', 'the', 'and', 'grooming', 'groomer',
  'resort', 'resorts', 'hotel', 'hotels', 'spa', 'animal', 'animals', 'hospital', 'veterinary', 'vet', 'clinic',
  'services', 'service', 'company', 'best', 'happy', 'home', 'house', 'paws', 'tails', 'club', 'center', 'centre']);

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const JUNIOR = /\b(attendant|assistant|intern|apprentice|handler|bather|receptionist|front[ -]?desk|kennel tech\w*|technician|associate|dog ?walker|pet ?sitter|caregiver|groomer|trainer|volunteer|server|cashier|clerk|specialist|coordinator)\b/i;
const SENIOR = /\b(owner|co-?owner|founder|co-?founder|ceo|president|principal|partner|director|head of|chief|cmo|coo|cfo|cto|vp|vice president|general manager|managing|proprietor)\b/i;
// keep only decision-makers — reject clearly-junior LinkedIn hits (an attendant isn't a lead)
function isDecisionMaker(cand) {
  const t = (cand.title || '') + ' ' + (cand.snippet || '');
  if (SENIOR.test(t)) return true;
  if (JUNIOR.test(t)) return false;
  return true; // no clear title → allow (could be an owner who lists no title)
}

// Does this search result clearly belong to the target company / person?
function belongsToCompany(company, name, cand) {
  const text = ((cand.title || '') + ' ' + (cand.snippet || '')).toLowerCase();
  const distinctive = words(company).filter((w) => w.length >= 3 && !GENERIC.has(w));
  if (distinctive.length) return distinctive.some((w) => text.includes(w)); // company name must appear
  if (name) return words(name).filter((w) => w.length >= 3).some((w) => text.includes(w)); // all-generic name → match the person
  return false; // nothing to verify against → don't guess
}

// -> { ownerName, ownerTitle, linkedinUrl }
export async function findDecisionMaker({ model, businessName, siteText, city = '' }) {
  const company = businessName || '';
  let name = '', title = '';

  // 1) read the company website for the actual decision-maker (free, local)
  if (siteText && siteText.trim().length > 40) {
    const r = await chatJson({
      model, tag: 'enrich', timeoutMs: 45000,
      system: 'You read a company website and identify its most senior decision-maker. Priority: CEO > Owner/Founder > senior marketing (CMO / VP / Head / Director of Marketing). Reply with ONE JSON object only.',
      user: `Company: ${company}${city ? ` (in ${city})` : ''}\n\nWebsite text:\n"""\n${siteText.slice(0, 9000)}\n"""\n\nReturn JSON {"name":"full name or empty","title":"their title or empty"} — empty strings if no clear person is named.`,
    });
    if (r && typeof r.name === 'string') { name = r.name.trim(); title = String(r.title || '').trim(); }
  }
  log('enrich', `${company}: site name = ${name ? `"${name}"${title ? ' (' + title + ')' : ''}` : '(none found)'} [text ${siteText ? siteText.length : 0} chars]`);

  // 2) one Google search (Serper) for the LinkedIn profile, biased to the city
  const loc = city ? ` ${city}` : '';
  const query = name ? `"${name}" "${company}"${loc} linkedin` : `"${company}"${loc} (owner OR CEO OR founder OR president) linkedin`;
  const sr = await serperSearch(query, { num: 10 });
  const candidates = linkedinInUrls(sr.organic);
  if (!candidates.length) { log('enrich', `${company}: no LinkedIn /in/ result`); return { ownerName: name, ownerTitle: title, linkedinUrl: '' }; }

  // 3) model picks the best match — but it must clearly be THIS company
  const pick = await chatJson({
    model, tag: 'enrich', numCtx: 4096, timeoutMs: 45000,
    system: 'You pick the LinkedIn profile of the MOST SENIOR person (CEO > Owner/Founder > senior Marketing) who works AT a specific company, from search results. The result must clearly be that company (its name should appear in the title/snippet) and ideally in the given city. If none clearly matches this company, return an empty linkedin_url — a wrong person is worse than none. Reply ONE JSON object only.',
    user: `Company: ${company}${city ? `\nCity: ${city}` : ''}${name ? `\nLikely person: ${name}${title ? ' (' + title + ')' : ''}` : ''}\n\n` +
      `Candidate LinkedIn results (titles read "Name - Title - Company | LinkedIn"):\n` +
      candidates.map((c, i) => `${i + 1}. ${c.url}\n   ${c.title}\n   ${c.snippet}`).join('\n') +
      `\n\nReturn JSON {"linkedin_url":"the best /in/ url copied EXACTLY from the list, or empty","name":"person's name or empty","title":"their title or empty"}. Empty linkedin_url unless it clearly matches this company.`,
  });

  let url = pick && typeof pick.linkedin_url === 'string' ? pick.linkedin_url.trim() : '';
  const cand = candidates.find((c) => c.url === url);
  if (!cand) url = ''; // must be a real candidate (no hallucinated URLs)
  if (url && !belongsToCompany(company, name, cand)) {
    log('enrich', `${company}: rejected ${url} — result doesn't mention the company`);
    url = '';
  }
  // only keep it if we found the name on the site (trusted owner) or the result reads senior
  if (url && !name && !isDecisionMaker(cand)) {
    log('enrich', `${company}: rejected ${url} — looks like a junior employee, not a decision-maker`);
    url = '';
  }
  const ownerName = name || (pick && pick.name ? String(pick.name).trim() : '');
  const ownerTitle = title || (pick && pick.title ? String(pick.title).trim() : '');
  log('enrich', `${company}: ${url ? '✓ ' + url : 'no confident pick'}${ownerName ? ' (' + ownerName + ')' : ''}`);
  return { ownerName, ownerTitle, linkedinUrl: url };
}
