import { doubleMetaphone } from 'double-metaphone';

// --- Normalize ---

const normalize = (str) => {
  if (!str) { return ''; }
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(al|el|bin|ibn|abd|abu)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

// --- Jaro-Winkler (from scratch) ---

const jaro = (s1, s2) => {
  if (s1 === s2) { return 1.0; }
  if (!s1.length || !s2.length) { return 0.0; }

  const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) { continue; }
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) { return 0.0; }

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) { continue; }
    while (!s2Matches[k]) { k++; }
    if (s1[i] !== s2[k]) { transpositions++; }
    k++;
  }

  return (
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3
  );
};

const jaroWinkler = (s1, s2, prefixScale = 0.1) => {
  const jaroScore = jaro(s1, s2);
  let prefixLen = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);

  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLen++;
    } else {
      break;
    }
  }

  return jaroScore + prefixLen * prefixScale * (1 - jaroScore);
};

// --- Token-set matching ---

const tokenSetSimilarity = (tokens1, tokens2) => {
  if (!tokens1.length || !tokens2.length) { return 0; }

  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);

  const intersection = [...set1].filter((t) => set2.has(t)).length;
  const union = new Set([...set1, ...set2]).size;

  if (union === 0) { return 0; }

  // Also compute best pairwise token Jaro-Winkler for partial matches
  let pairwiseSum = 0;
  let pairCount = 0;

  tokens1.forEach((t1) => {
    let bestMatch = 0;
    tokens2.forEach((t2) => {
      const score = jaroWinkler(t1, t2);
      if (score > bestMatch) { bestMatch = score; }
    });
    pairwiseSum += bestMatch;
    pairCount++;
  });

  const pairwiseAvg = pairCount > 0 ? pairwiseSum / pairCount : 0;
  const jaccard = intersection / union;

  // Blend exact token overlap with fuzzy pairwise
  return jaccard * 0.4 + pairwiseAvg * 0.6;
};

// --- Phonetic matching ---

const phoneticMatch = (codes1, codes2) => {
  if (!codes1.length || !codes2.length) { return false; }
  const set2 = new Set(codes2);
  return codes1.some((c) => set2.has(c));
};

const computePhonetic = (name) => {
  const tokens = normalize(name).split(/\s+/).filter(Boolean);
  return tokens.flatMap((t) => {
    const [primary, secondary] = doubleMetaphone(t);
    return [primary, secondary].filter(Boolean);
  });
};

// --- Exact substring ---

const exactSubstring = (query, target) => {
  if (!query || !target) { return false; }
  return target.includes(query) || query.includes(target);
};

// --- Composite score for one name comparison ---

const WEIGHTS = {
  jaroWinkler: 0.40,
  tokenSet: 0.30,
  phonetic: 0.20,
  exactSubstring: 0.10,
};

const scoreName = (queryNorm, queryTokens, queryCodes, targetNorm, targetTokens, targetCodes) => {
  // Exact match short-circuit
  if (queryNorm === targetNorm && queryNorm.length > 0) {
    return {
      score: 1.0,
      details: { jaroWinkler: 1.0, tokenSet: 1.0, phonetic: true, exactSubstring: true },
    };
  }

  const jwScore = jaroWinkler(queryNorm, targetNorm);
  const tsScore = tokenSetSimilarity(queryTokens, targetTokens);
  const isPhonetic = phoneticMatch(queryCodes, targetCodes);
  const isSubstring = exactSubstring(queryNorm, targetNorm);

  // Boost when any query token exactly matches a target token (catches "PUTIN" vs "Vladimir PUTIN")
  const hasExactToken = queryTokens.some((t) => targetTokens.includes(t) && t.length >= 3);
  const exactTokenBoost = hasExactToken ? 0.15 : 0;

  const score = Math.min(1.0,
    jwScore * WEIGHTS.jaroWinkler +
    tsScore * WEIGHTS.tokenSet +
    (isPhonetic ? 1.0 : 0.0) * WEIGHTS.phonetic +
    (isSubstring ? 1.0 : 0.0) * WEIGHTS.exactSubstring +
    exactTokenBoost);

  return {
    score,
    details: {
      jaroWinkler: Math.round(jwScore * 100) / 100,
      tokenSet: Math.round(tsScore * 100) / 100,
      phonetic: isPhonetic,
      exactSubstring: isSubstring,
    },
  };
};

// --- DOB boost/penalty ---

const parseDateLoose = (str) => {
  if (!str) { return null; }
  const s = String(str).trim();
  // "DD Mon YYYY", "YYYY", "YYYY-MM-DD" etc.
  const d = new Date(s);
  if (!isNaN(d.getTime())) { return d; }
  // Year only
  const yearMatch = s.match(/^\d{4}$/);
  if (yearMatch) { return { year: parseInt(s, 10) }; }
  return null;
};

const dobBoost = (queryDob, entryDobs) => {
  if (!queryDob || !entryDobs || !entryDobs.length) { return 0; }

  const qDate = parseDateLoose(queryDob);
  if (!qDate) { return 0; }

  const qYear = qDate instanceof Date ? qDate.getFullYear() : qDate.year;

  for (const d of entryDobs) {
    const eDate = parseDateLoose(d.dateOfBirth);
    if (!eDate) { continue; }
    const eYear = eDate instanceof Date ? eDate.getFullYear() : eDate.year;

    // Exact date match
    if (qDate instanceof Date && eDate instanceof Date) {
      if (qDate.toISOString().slice(0, 10) === eDate.toISOString().slice(0, 10)) {
        return 0.10; // boost 10%
      }
    }
    // Same year
    if (qYear === eYear) { return 0.05; }
    // Close year
    if (Math.abs(qYear - eYear) <= 2) { return 0.02; }
  }

  return -0.05; // penalty if DOB provided but doesn't match
};

// --- Country boost/penalty ---

const countryBoost = (queryCountry, entry) => {
  if (!queryCountry) { return 0; }

  const qc = queryCountry.toLowerCase().trim();
  const entryCountries = new Set();

  (entry.nationalities || []).forEach((n) => {
    if (n.country) { entryCountries.add(n.country.toLowerCase()); }
  });
  (entry.citizenships || []).forEach((c) => {
    if (c.country) { entryCountries.add(c.country.toLowerCase()); }
  });
  (entry.addresses || []).forEach((a) => {
    if (a.country) { entryCountries.add(a.country.toLowerCase()); }
  });

  if (entryCountries.size === 0) { return 0; }

  for (const c of entryCountries) {
    if (c === qc || c.includes(qc) || qc.includes(c)) { return 0.05; }
  }

  return -0.03;
};

// --- Match type classification ---

const classifyMatch = (score) => {
  if (score >= 0.95) { return 'exact'; }
  if (score >= 0.85) { return 'strong'; }
  if (score >= 0.70) { return 'partial'; }
  return 'weak';
};

// --- Main screen function ---

const screenName = (query, entries, options = {}) => {
  const {
    type = null,
    dateOfBirth = null,
    country = null,
    threshold = 0.85,
    limit = 10,
  } = options;

  const queryNorm = normalize(query);
  const queryTokens = queryNorm.split(/\s+/).filter(Boolean);
  const queryCodes = computePhonetic(query);

  if (!queryNorm) { return []; }

  // Pre-filter by type if specified
  const candidates = type
    ? entries.filter((e) => e.sdnType.toLowerCase() === type.toLowerCase())
    : entries;

  const results = [];

  candidates.forEach((entry) => {
    const { search } = entry;

    // Score against primary name
    const primary = scoreName(
      queryNorm, queryTokens, queryCodes,
      search.normalizedName, search.nameTokens, search.phonetic,
    );

    let bestScore = primary.score;
    let bestDetails = primary.details;
    let matchedOn = 'primary_name';
    let matchedName = entry.name;

    // Score against each alias
    search.aliases.forEach((alias) => {
      const aliasResult = scoreName(
        queryNorm, queryTokens, queryCodes,
        alias.normalized, alias.tokens, alias.phonetic,
      );

      if (aliasResult.score > bestScore) {
        bestScore = aliasResult.score;
        bestDetails = aliasResult.details;
        matchedOn = 'alias';
        matchedName = alias.name;
      }
    });

    // Apply DOB and country adjustments
    bestScore += dobBoost(dateOfBirth, entry.datesOfBirth);
    bestScore += countryBoost(country, entry);

    // Clamp to [0, 1]
    bestScore = Math.max(0, Math.min(1, bestScore));

    if (bestScore >= threshold) {
      // Strip search index from returned entity
      const { search: _search, ...entity } = entry;

      results.push({
        entity,
        score: Math.round(bestScore * 1000) / 1000,
        matchType: classifyMatch(bestScore),
        matchedOn,
        matchedName,
        matchDetails: bestDetails,
      });
    }
  });

  // Sort by score descending, take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
};

// --- Search/browse function ---

const searchEntries = (entries, options = {}) => {
  const { q = '', type = null, program = null, limit = 25, offset = 0 } = options;

  let filtered = entries;

  if (type) {
    filtered = filtered.filter((e) => e.sdnType.toLowerCase() === type.toLowerCase());
  }

  if (program) {
    const progUpper = program.toUpperCase();
    filtered = filtered.filter((e) => e.programs.some((p) => p.toUpperCase() === progUpper));
  }

  if (q) {
    const queryNorm = normalize(q);
    filtered = filtered.filter((e) => {
      if (e.search.normalizedName.includes(queryNorm)) { return true; }
      return e.search.aliases.some((a) => a.normalized.includes(queryNorm));
    });
  }

  const total = filtered.length;
  const results = filtered.slice(offset, offset + limit).map((e) => {
    const { search: _search, ...entity } = e;
    return entity;
  });

  return { total, offset, limit, results };
};

// --- Get entity by UID ---

const getEntity = (entries, uid) => {
  const entry = entries.find((e) => e.uid === uid);
  if (!entry) { return null; }
  const { search: _search, ...entity } = entry;
  return entity;
};

// --- Programs list ---

const listPrograms = (meta) => {
  const programs = Object.entries(meta.programCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { total: programs.length, programs };
};

// --- Stats ---

const buildStats = (entries, meta) => {
  // Top countries by address
  const countryCounts = {};
  entries.forEach((e) => {
    e.addresses.forEach((a) => {
      if (a.country) {
        countryCounts[a.country] = (countryCounts[a.country] || 0) + 1;
      }
    });
  });

  const topCountries = Object.entries(countryCounts)
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  return {
    publishDate: meta.publishDate,
    buildDate: meta.buildDate,
    totalEntries: meta.recordCount,
    typeCounts: meta.typeCounts,
    programCounts: meta.programCounts,
    totalAliases: meta.aliasCount,
    totalAddresses: meta.addressCount,
    topCountries,
  };
};

export {
  screenName,
  searchEntries,
  getEntity,
  listPrograms,
  buildStats,
  normalize,
  jaroWinkler,
  classifyMatch,
};
