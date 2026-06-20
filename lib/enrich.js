// Find a business's decision-maker (CEO > owner/founder > senior marketing) and
// their LinkedIn URL — Clay-style. Name comes from the site text we already
// crawled; LinkedIn comes from a Google search (Serper), NEVER from visiting
// LinkedIn. Local Ollama only reads text + result snippets.
import { chatJson } from '@/lib/ollama';
import { serperSearch, linkedinInUrls } from '@/lib/serper';
import { log } from '@/lib/log';

// -> { ownerName, ownerTitle, linkedinUrl }
export async function findDecisionMaker({ model, businessName, siteText }) {
  const company = businessName || '';
  let name = '', title = '';

  // 1) try to get the person's name from the site's team/about text (free, local)
  if (siteText && siteText.trim().length > 40) {
    const r = await chatJson({
      model, tag: 'enrich',
      system: 'You read a company website and identify its most senior decision-maker. Priority: CEO > Owner/Founder > senior marketing (CMO / VP / Head / Director of Marketing). Reply with ONE JSON object only.',
      user: `Company: ${company}\n\nWebsite text:\n"""\n${siteText.slice(0, 9000)}\n"""\n\nReturn JSON {"name":"full name or empty","title":"their title or empty"} — empty strings if no clear person is named.`,
    });
    if (r && typeof r.name === 'string') { name = r.name.trim(); title = String(r.title || '').trim(); }
  }

  // 2) one Google search (Serper) for the LinkedIn profile
  const query = name ? `"${name}" "${company}" linkedin` : `${company} (owner OR CEO OR founder OR president) linkedin`;
  const sr = await serperSearch(query, { num: 10 });
  const candidates = linkedinInUrls(sr.organic);
  if (!candidates.length) {
    log('enrich', `${company}: ${name ? 'name "' + name + '" but ' : ''}no LinkedIn /in/ result`);
    return { ownerName: name, ownerTitle: title, linkedinUrl: '' };
  }

  // 3) let the model pick the best matching profile (most senior, right company)
  const valid = new Set(candidates.map((c) => c.url));
  const pick = await chatJson({
    model, tag: 'enrich', numCtx: 4096,
    system: 'You pick the LinkedIn profile of the MOST SENIOR person (CEO > Owner/Founder > senior Marketing) at a specific company from search results. The profile must clearly belong to that company. Reply ONE JSON object only.',
    user: `Company: ${company}${name ? `\nLikely person: ${name}${title ? ' (' + title + ')' : ''}` : ''}\n\n` +
      `Candidate LinkedIn results (titles read "Name - Title - Company | LinkedIn"):\n` +
      candidates.map((c, i) => `${i + 1}. ${c.url}\n   ${c.title}\n   ${c.snippet}`).join('\n') +
      `\n\nReturn JSON {"linkedin_url":"the best /in/ url copied EXACTLY from the list, or empty","name":"person's name or empty","title":"their title or empty"}. Empty linkedin_url if none clearly matches this company.`,
  });

  let url = pick && typeof pick.linkedin_url === 'string' ? pick.linkedin_url.trim() : '';
  if (!valid.has(url)) url = ''; // must be one of the real candidates (no hallucinated URLs)
  const ownerName = name || (pick && pick.name ? String(pick.name).trim() : '');
  const ownerTitle = title || (pick && pick.title ? String(pick.title).trim() : '');
  log('enrich', `${company}: ${url ? '✓ ' + url : 'no confident pick'}${ownerName ? ' (' + ownerName + ')' : ''}`);
  return { ownerName, ownerTitle, linkedinUrl: url };
}
