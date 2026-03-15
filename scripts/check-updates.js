#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { doubleMetaphone } from 'double-metaphone';

const DATA_DIR = new URL('../src/data/', import.meta.url).pathname;
const CHANGELOGS_DIR = new URL('./changelogs/', import.meta.url).pathname;
const NEWSLETTERS_DIR = new URL('./newsletters/', import.meta.url).pathname;
const SDN_URL = 'https://www.treasury.gov/ofac/downloads/sdn.xml';

// --- helpers (mirrored from build-data.js) ---

const ensureArray = (val) => {
  if (!val) { return []; }
  return Array.isArray(val) ? val : [val];
};

const buildName = (firstName, lastName) => {
  const f = firstName != null ? String(firstName) : '';
  const l = lastName != null ? String(lastName) : '';
  if (f && l) { return `${f} ${l}`; }
  return l || f || '';
};

const normalizeForSearch = (str) => {
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

const computePhonetic = (name) => {
  if (!name) { return []; }
  const tokens = normalizeForSearch(name).split(/\s+/).filter(Boolean);
  return tokens.flatMap((t) => {
    const [primary, secondary] = doubleMetaphone(t);
    return [primary, secondary].filter(Boolean);
  });
};

// --- parse one SDN entry (same as build-data.js) ---

const parseEntry = (raw) => {
  const uid = raw.uid;
  const sdnType = raw.sdnType || 'Unknown';
  const firstName = raw.firstName || null;
  const lastName = raw.lastName || null;
  const name = buildName(firstName, lastName);
  const title = raw.title || null;
  const remarks = raw.remarks || null;

  const programs = ensureArray(raw.programList?.program);

  const aliases = ensureArray(raw.akaList?.aka).map((a) => ({
    uid: a.uid,
    type: a.type || null,
    category: a.category || null,
    name: buildName(a.firstName, a.lastName),
  }));

  const addresses = ensureArray(raw.addressList?.address).map((a) => ({
    uid: a.uid,
    address1: a.address1 || null,
    address2: a.address2 || null,
    address3: a.address3 || null,
    city: a.city || null,
    stateOrProvince: a.stateOrProvince || null,
    postalCode: a.postalCode || null,
    country: a.country || null,
  }));

  const ids = ensureArray(raw.idList?.id).map((i) => ({
    uid: i.uid,
    idType: i.idType || null,
    idNumber: i.idNumber != null ? String(i.idNumber) : null,
    idCountry: i.idCountry || null,
    issueDate: i.issueDate || null,
    expirationDate: i.expirationDate || null,
  }));

  const datesOfBirth = ensureArray(raw.dateOfBirthList?.dateOfBirthItem).map((d) => ({
    uid: d.uid,
    dateOfBirth: d.dateOfBirth != null ? String(d.dateOfBirth) : null,
    mainEntry: d.mainEntry === true || d.mainEntry === 'true',
  }));

  const placesOfBirth = ensureArray(raw.placeOfBirthList?.placeOfBirthItem).map((p) => ({
    uid: p.uid,
    placeOfBirth: p.placeOfBirth || null,
    mainEntry: p.mainEntry === true || p.mainEntry === 'true',
  }));

  const nationalities = ensureArray(raw.nationalityList?.nationality).map((n) => ({
    uid: n.uid,
    country: n.country || null,
    mainEntry: n.mainEntry === true || n.mainEntry === 'true',
  }));

  const citizenships = ensureArray(raw.citizenshipList?.citizenship).map((c) => ({
    uid: c.uid,
    country: c.country || null,
    mainEntry: c.mainEntry === true || c.mainEntry === 'true',
  }));

  const vesselInfo = raw.vesselInfo
    ? {
      callSign: raw.vesselInfo.callSign || null,
      vesselType: raw.vesselInfo.vesselType || null,
      vesselFlag: raw.vesselInfo.vesselFlag || null,
      vesselOwner: raw.vesselInfo.vesselOwner || null,
      tonnage: raw.vesselInfo.tonnage || null,
      grossRegisteredTonnage: raw.vesselInfo.grossRegisteredTonnage || null,
    }
    : null;

  const normalizedName = normalizeForSearch(name);
  const nameTokens = normalizedName.split(/\s+/).filter(Boolean);
  const phonetic = computePhonetic(name);

  const aliasSearch = aliases.map((a) => {
    const norm = normalizeForSearch(a.name);
    return {
      name: a.name,
      normalized: norm,
      tokens: norm.split(/\s+/).filter(Boolean),
      phonetic: computePhonetic(a.name),
    };
  });

  return {
    uid,
    sdnType,
    firstName,
    lastName,
    name,
    title,
    remarks,
    programs,
    aliases,
    addresses,
    ids,
    datesOfBirth,
    placesOfBirth,
    nationalities,
    citizenships,
    vesselInfo,
    search: {
      normalizedName,
      nameTokens,
      phonetic,
      aliases: aliasSearch,
    },
  };
};

// --- XML parsing ---

const parseXml = (xml) => {
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => [
      'sdnEntry', 'program', 'aka', 'address', 'id',
      'dateOfBirthItem', 'placeOfBirthItem', 'nationality', 'citizenship',
    ].includes(name),
  });
  return parser.parse(xml);
};

// --- download SDN XML ---

const downloadSdn = async () => {
  console.log(`Downloading SDN list from ${SDN_URL}...`);
  const res = await fetch(SDN_URL);
  if (!res.ok) {
    throw new Error(`Failed to download SDN list: ${res.status} ${res.statusText}`);
  }
  return res.text();
};

// --- diff detection ---

const getCountry = (entry) => {
  const addr = (entry.addresses || [])[0];
  if (addr?.country) { return addr.country; }
  const nat = (entry.nationalities || [])[0];
  if (nat?.country) { return nat.country; }
  const cit = (entry.citizenships || [])[0];
  if (cit?.country) { return cit.country; }
  return null;
};

const entryFingerprint = (entry) => {
  const aliasNames = (entry.aliases || []).map((a) => a.name).sort().join('|');
  const progs = (entry.programs || []).sort().join('|');
  return `${entry.name}::${entry.sdnType}::${progs}::${aliasNames}`;
};

const detectChanges = (currentEntries, newEntries) => {
  const currentMap = new Map(currentEntries.map((e) => [e.uid, e]));
  const newMap = new Map(newEntries.map((e) => [e.uid, e]));

  const added = [];
  const removed = [];
  const modified = [];

  // new entries not in current
  newMap.forEach((entry, uid) => {
    if (!currentMap.has(uid)) {
      added.push(entry);
    }
  });

  // removed entries not in new
  currentMap.forEach((entry, uid) => {
    if (!newMap.has(uid)) {
      removed.push(entry);
    }
  });

  // modified entries (same UID, different fingerprint)
  newMap.forEach((newEntry, uid) => {
    const currentEntry = currentMap.get(uid);
    if (!currentEntry) { return; }
    if (entryFingerprint(currentEntry) !== entryFingerprint(newEntry)) {
      modified.push({ before: currentEntry, after: newEntry });
    }
  });

  return { added, removed, modified };
};

// --- describe modifications ---

const describeModification = (mod) => {
  const { before, after } = mod;
  const changes = [];

  if (before.name !== after.name) {
    changes.push(`Name: "${before.name}" -> "${after.name}"`);
  }

  const beforeProgs = (before.programs || []).sort().join(', ');
  const afterProgs = (after.programs || []).sort().join(', ');
  if (beforeProgs !== afterProgs) {
    const addedProgs = (after.programs || []).filter((p) => !(before.programs || []).includes(p));
    const removedProgs = (before.programs || []).filter((p) => !(after.programs || []).includes(p));
    if (addedProgs.length) { changes.push(`Programs added: ${addedProgs.join(', ')}`); }
    if (removedProgs.length) { changes.push(`Programs removed: ${removedProgs.join(', ')}`); }
  }

  const beforeAliases = (before.aliases || []).map((a) => a.name).sort().join(', ');
  const afterAliases = (after.aliases || []).map((a) => a.name).sort().join(', ');
  if (beforeAliases !== afterAliases) {
    changes.push('Aliases updated');
  }

  if (before.sdnType !== after.sdnType) {
    changes.push(`Type: "${before.sdnType}" -> "${after.sdnType}"`);
  }

  return changes.length > 0 ? changes : ['Other metadata changed'];
};

// --- generate changelog markdown ---

const generateChangelog = (dateStr, changes) => {
  const { added, removed, modified } = changes;
  const lines = [];

  lines.push(`# OFAC SDN Changelog — ${dateStr}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- **${added.length}** new entries`);
  lines.push(`- **${removed.length}** removed entries`);
  lines.push(`- **${modified.length}** modified entries`);
  lines.push('');

  if (added.length > 0) {
    lines.push('## New Entries');
    lines.push('');
    added.forEach((e) => {
      const country = getCountry(e);
      const countryStr = country ? ` | ${country}` : '';
      lines.push(`- **${e.name}** (UID: ${e.uid}) — ${e.sdnType} | ${e.programs.join(', ')}${countryStr}`);
    });
    lines.push('');
  }

  if (removed.length > 0) {
    lines.push('## Removed Entries');
    lines.push('');
    removed.forEach((e) => {
      lines.push(`- **${e.name}** (UID: ${e.uid}) — ${e.sdnType} | ${e.programs.join(', ')}`);
    });
    lines.push('');
  }

  if (modified.length > 0) {
    lines.push('## Modified Entries');
    lines.push('');
    modified.forEach((mod) => {
      const changes = describeModification(mod);
      lines.push(`- **${mod.after.name}** (UID: ${mod.after.uid})`);
      changes.forEach((c) => {
        lines.push(`  - ${c}`);
      });
    });
    lines.push('');
  }

  return lines.join('\n');
};

// --- generate newsletter markdown ---

const generateNewsletter = (dateStr, changes) => {
  const { added, removed, modified } = changes;
  const lines = [];

  lines.push(`# OFAC SDN List Update — ${dateStr}`);
  lines.push('');
  lines.push('The US Treasury has updated the Specially Designated Nationals (SDN) list. Here is what changed.');
  lines.push('');
  lines.push('## Summary');
  lines.push(`- **${added.length}** new designations`);
  lines.push(`- **${removed.length}** removals`);
  lines.push(`- **${modified.length}** modifications`);
  lines.push('');

  if (added.length > 0) {
    lines.push('## New Designations');
    lines.push('');
    added.forEach((e) => {
      const country = getCountry(e);
      const countryStr = country ? `**Country:** ${country}` : '';
      const aliasNames = (e.aliases || []).map((a) => a.name).filter(Boolean);
      const aliasStr = aliasNames.length > 0 ? `**Also known as:** ${aliasNames.slice(0, 5).join(', ')}${aliasNames.length > 5 ? ` (+${aliasNames.length - 5} more)` : ''}` : '';

      lines.push(`### ${e.name}`);
      lines.push(`- **Type:** ${e.sdnType}`);
      lines.push(`- **Programs:** ${e.programs.join(', ')}`);
      if (countryStr) { lines.push(`- ${countryStr}`); }
      if (aliasStr) { lines.push(`- ${aliasStr}`); }
      lines.push('');
    });
  }

  if (removed.length > 0) {
    lines.push('## Removals');
    lines.push('');
    lines.push('The following entries have been removed from the SDN list:');
    lines.push('');
    removed.forEach((e) => {
      lines.push(`- **${e.name}** — ${e.sdnType} | ${e.programs.join(', ')}`);
    });
    lines.push('');
  }

  if (modified.length > 0) {
    lines.push('## Modifications');
    lines.push('');
    lines.push('The following entries were updated:');
    lines.push('');
    modified.forEach((mod) => {
      const changes = describeModification(mod);
      lines.push(`- **${mod.after.name}**`);
      changes.forEach((c) => {
        lines.push(`  - ${c}`);
      });
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Screen names against the updated list: https://ofac-screening-production.up.railway.app');
  lines.push('MCP Server: `npx @easysolutions906/mcp-ofac`');
  lines.push('');

  return lines.join('\n');
};

// --- build meta object ---

const buildMeta = (entries, publishInfo) => {
  const typeCounts = entries.reduce((acc, e) => {
    acc[e.sdnType] = (acc[e.sdnType] || 0) + 1;
    return acc;
  }, {});

  const programCounts = entries.reduce((acc, e) => {
    e.programs.forEach((p) => {
      acc[p] = (acc[p] || 0) + 1;
    });
    return acc;
  }, {});

  return {
    buildDate: new Date().toISOString(),
    publishDate: publishInfo.Publish_Date || null,
    recordCount: entries.length,
    typeCounts,
    programCounts,
    aliasCount: entries.reduce((sum, e) => sum + e.aliases.length, 0),
    addressCount: entries.reduce((sum, e) => sum + e.addresses.length, 0),
  };
};

// --- main ---

const main = async () => {
  // load current data
  console.log('Loading current sdn.json...');
  const currentJson = await readFile(`${DATA_DIR}sdn.json`, 'utf-8');
  const currentEntries = JSON.parse(currentJson);
  console.log(`Current data: ${currentEntries.length} entries`);

  // download and parse new data
  const xml = await downloadSdn();
  console.log('Parsing XML...');
  const parsed = parseXml(xml);

  const publishInfo = parsed.sdnList?.publshInformation || {};
  const rawEntries = parsed.sdnList?.sdnEntry || [];
  console.log(`New data: ${rawEntries.length} raw entries. Processing...`);

  const newEntries = rawEntries.map(parseEntry);
  console.log(`Processed ${newEntries.length} entries`);

  // detect changes
  console.log('Comparing...');
  const changes = detectChanges(currentEntries, newEntries);
  const totalChanges = changes.added.length + changes.removed.length + changes.modified.length;

  if (totalChanges === 0) {
    console.log('No changes detected.');
    return;
  }

  console.log(`Changes found: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.modified.length} modified`);

  // update data files
  console.log('Updating sdn.json...');
  await writeFile(`${DATA_DIR}sdn.json`, JSON.stringify(newEntries));

  console.log('Updating meta.json...');
  const meta = buildMeta(newEntries, publishInfo);
  await writeFile(`${DATA_DIR}meta.json`, JSON.stringify(meta, null, 2));

  // generate changelog and newsletter
  const today = new Date().toISOString().slice(0, 10);

  await mkdir(CHANGELOGS_DIR, { recursive: true });
  await mkdir(NEWSLETTERS_DIR, { recursive: true });

  const changelogPath = `${CHANGELOGS_DIR}${today}.md`;
  const changelog = generateChangelog(today, changes);
  await writeFile(changelogPath, changelog);
  console.log(`Changelog written: ${changelogPath}`);

  const newsletterPath = `${NEWSLETTERS_DIR}${today}.md`;
  const newsletter = generateNewsletter(today, changes);
  await writeFile(newsletterPath, newsletter);
  console.log(`Newsletter written: ${newsletterPath}`);

  console.log('Done.');
};

main().catch((err) => {
  console.error('Update check failed:', err);
  process.exit(1);
});
