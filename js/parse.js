/* Punchlist header parsing + fuzzy matching. Works in browser (window.PLParse) and Node (module.exports). */
(function (root) {
  'use strict';

  const ABBREV = {
    blvd: 'boulevard', bl: 'boulevard', st: 'street', str: 'street', ave: 'avenue', av: 'avenue',
    rd: 'road', dr: 'drive', ln: 'lane', ct: 'court', cir: 'circle', pl: 'place', ter: 'terrace',
    terr: 'terrace', hwy: 'highway', pkwy: 'parkway', trl: 'trail', way: 'way', sq: 'square',
    n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
    apt: 'apartment', ste: 'suite', fl: 'florida', mt: 'mount',
    co: 'company', inc: '', llc: '', corp: '', ltd: '', the: ''
  };
  // Words that carry little identifying weight in an address.
  const ADDR_STOP = new Set(['florida', 'boca', 'raton', 'usa', 'us', 'fl']);

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9#]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(t => (Object.prototype.hasOwnProperty.call(ABBREV, t) ? ABBREV[t] : t))
      .filter(Boolean)
      .join(' ');
  }
  const tokens = s => normalize(s).split(' ').filter(Boolean);

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  function ratio(a, b) {
    if (!a && !b) return 1;
    const m = Math.max(a.length, b.length);
    return m ? 1 - levenshtein(a, b) / m : 0;
  }
  // Fraction of query tokens that have a close match among target tokens.
  function tokenCoverage(qt, tt) {
    if (!qt.length) return 0;
    let sum = 0;
    for (const q of qt) {
      let best = 0;
      for (const t of tt) {
        let r = ratio(q, t);
        if (/^\d+$/.test(q) || /^\d+$/.test(t)) r = q === t ? 1 : 0; // numbers must match exactly
        else if (q.length >= 3 && t.startsWith(q)) r = Math.max(r, 0.9);
        if (r > best) best = r;
      }
      sum += best >= 0.75 ? best : 0;
    }
    return sum / qt.length;
  }

  /** Similarity between free text (handwritten) and a saved name, 0..1 */
  function similarity(query, target) {
    const qn = normalize(query), tn = normalize(target);
    if (!qn || !tn) return 0;
    if (qn === tn) return 1;
    const qc = qn.replace(/ /g, ''), tc = tn.replace(/ /g, '');
    if (qc === tc) return 0.98;
    const whole = ratio(qc, tc);
    const qt = qn.split(' '), tt = tn.split(' ');
    const cov = tokenCoverage(qt, tt);       // query words found in target
    const rev = tokenCoverage(tt, qt);       // target words found in query
    // Query is a subset of target (e.g. "123 Ocean" vs "123 Ocean Blvd Boca Raton"): strong but slightly below full.
    const subset = cov * (0.85 + 0.15 * rev);
    return Math.max(whole, subset, (cov + rev) / 2);
  }

  function addressSimilarity(query, addr) {
    const qt = tokens(query).filter(t => !ADDR_STOP.has(t));
    const at = tokens(addr).filter(t => !ADDR_STOP.has(t));
    if (!qt.length || !at.length) return similarity(query, addr);
    // If the query has a street number, it must match the address's street number.
    const qNum = qt.find(t => /^\d+$/.test(t)), aNum = at.find(t => /^\d+$/.test(t));
    if (qNum && aNum && qNum !== aNum) return 0.2 * similarity(qt.join(' '), at.join(' '));
    return similarity(qt.join(' '), at.join(' '));
  }

  /** Parse "Company @ Address" header line. Returns {company, address} or null. */
  function parseHeader(line) {
    if (!line) return null;
    let s = String(line).replace(/^[\s\-*•#>]+/, '').replace(/\s+/g, ' ').trim();
    let m = s.match(/^(.+?)\s*(?:@|\(a\)|Ⓐ|＠)\s*(.+)$/);
    if (!m) m = s.match(/^(.+?)\s+(?:at)\s+(.+)$/i);
    if (!m) return null;
    const company = m[1].replace(/[:\-–—,]+$/, '').trim();
    const address = m[2].replace(/^[:\-–—,]+/, '').trim();
    if (!company || !address) return null;
    return { company, address };
  }

  /** Rank companies [{id,name}] against handwritten name. */
  function matchCompany(name, companies, threshold = 0.65) {
    const ranked = (companies || [])
      .map(c => ({ item: c, score: Math.max(similarity(name, c.name), ...(c.aliases || []).map(a => similarity(name, a))) }))
      .sort((a, b) => b.score - a.score);
    return pick(ranked, threshold);
  }

  /** Rank addresses [{id,address,nicknames[]}] against handwritten address or nickname. */
  function matchAddress(text, addresses, threshold = 0.65) {
    const ranked = (addresses || []).map(a => {
      let score = addressSimilarity(text, a.address), via = 'address';
      for (const nick of a.nicknames || []) {
        const s = similarity(text, nick);
        if (s > score || (s === score && s === 1)) { score = s; via = 'nickname:' + nick; }
      }
      return { item: a, score, via };
    }).sort((a, b) => b.score - a.score);
    return pick(ranked, threshold);
  }

  function pick(ranked, threshold) {
    const best = ranked[0] && ranked[0].score >= threshold ? ranked[0] : null;
    const second = ranked[1];
    const ambiguous = !!(best && second && second.score >= threshold && best.score - second.score < 0.05);
    return { match: best ? best.item : null, score: best ? best.score : (ranked[0] ? ranked[0].score : 0), via: best && best.via, ambiguous, candidates: ranked.slice(0, 5) };
  }

  /** Clean raw OCR lines into header + items. */
  function splitTranscript(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let header = null, headerLine = '';
    const idx = lines.findIndex((l, i) => i < 3 && parseHeader(l));
    if (idx >= 0) { headerLine = lines[idx]; header = parseHeader(headerLine); lines.splice(0, idx + 1); }
    const items = lines.map(cleanItem).filter(l => l && /[a-z0-9]/i.test(l) && l.length > 1);
    return { header: headerLine, company: header ? header.company : '', address: header ? header.address : '', items };
  }
  function cleanItem(l) {
    return String(l)
      .replace(/^\s*(?:[-*•·~>□☐■✓✔︎xX]\s+|\[\s*[xX ]?\s*\]\s*|\(?\d{1,3}[.)\]:-]\s*|[a-z][.)]\s+|[|lIS][.)]\s+)/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const api = { normalize, similarity, addressSimilarity, parseHeader, matchCompany, matchAddress, splitTranscript, cleanItem, levenshtein };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PLParse = api;
})(typeof self !== 'undefined' ? self : this);
