#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { doubleMetaphone } from 'double-metaphone';

const DATA_DIR = new URL('../src/data/', import.meta.url).pathname;

// --- helpers ---

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
    .replace(/[\u0300-\u036f]/g, '')       // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')          // non-alphanum to space
    .replace(/\b(al|el|bin|ibn|abd|abu)\b/g, '') // common prefixes
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

// --- parse one SDN entry ---

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

  // pre-computed search fields
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

// --- main ---

const main = async () => {
  console.log('Reading sdn.xml...');
  const xml = await readFile(`${DATA_DIR}sdn.xml`, 'utf-8');

  console.log('Parsing XML...');
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (name) => ['sdnEntry', 'program', 'aka', 'address', 'id', 'dateOfBirthItem', 'placeOfBirthItem', 'nationality', 'citizenship'].includes(name),
  });
  const parsed = parser.parse(xml);

  const publishInfo = parsed.sdnList?.publshInformation || {};
  const rawEntries = parsed.sdnList?.sdnEntry || [];

  console.log(`Found ${rawEntries.length} entries. Processing...`);
  const entries = rawEntries.map(parseEntry);

  // type counts
  const typeCounts = entries.reduce((acc, e) => {
    acc[e.sdnType] = (acc[e.sdnType] || 0) + 1;
    return acc;
  }, {});

  // program counts
  const programCounts = entries.reduce((acc, e) => {
    e.programs.forEach((p) => {
      acc[p] = (acc[p] || 0) + 1;
    });
    return acc;
  }, {});

  const meta = {
    buildDate: new Date().toISOString(),
    publishDate: publishInfo.Publish_Date || null,
    recordCount: entries.length,
    typeCounts,
    programCounts,
    aliasCount: entries.reduce((sum, e) => sum + e.aliases.length, 0),
    addressCount: entries.reduce((sum, e) => sum + e.addresses.length, 0),
  };

  console.log('Writing sdn.json...');
  await writeFile(`${DATA_DIR}sdn.json`, JSON.stringify(entries));

  console.log('Writing meta.json...');
  await writeFile(`${DATA_DIR}meta.json`, JSON.stringify(meta, null, 2));

  console.log(`Done. ${entries.length} entries processed.`);
  console.log('Type counts:', typeCounts);
  console.log('Programs:', Object.keys(programCounts).length);
};

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
