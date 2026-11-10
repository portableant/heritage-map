import fs from 'node:fs';
import path from 'node:path';

function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

  const parseRow = (line) => {
    const row = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        row.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    row.push(cur.trim());
    return row;
  };

  const headers = parseRow(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseRow(line);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] !== undefined ? values[idx] : '';
    });
    return obj;
  });
}

function resolveFile(filename) {
  const publicPath = path.resolve('public', 'csv', filename);
  if (fs.existsSync(publicPath)) return publicPath;
  const rootPath = path.resolve(filename);
  if (fs.existsSync(rootPath)) return rootPath;
  throw new Error(`Could not locate ${filename} in public/csv/ or project root.`);
}

const museumsPath = resolveFile('export-13-accredited-museums.csv');
const countiesPath = resolveFile('ordnance-survey-counties-2026-11-10.csv');
const regionsPath = resolveFile('ordnance-survey-regions-2026-11-10.csv');

const rawMuseums = parseCSV(museumsPath);
const rawCounties = parseCSV(countiesPath);
const rawRegions = parseCSV(regionsPath);

// Index Regions by ID (1-10) and by Os id (41421-41431)
const regionsById = new Map();
const regionsByOsId = new Map();
for (const r of rawRegions) {
  const regObj = {
    id: parseInt(r['ID'], 10),
    os_id: r['Os id'],
    label: r['Label'],
    slug: r['Slug']
  };
  if (r['ID']) regionsById.set(r['ID'], regObj);
  if (r['Os id']) regionsByOsId.set(r['Os id'], regObj);
}

// Index Counties by ID
const countiesById = new Map();
for (const c of rawCounties) {
  const regId = c['Region'];
  const region = regionsById.get(regId) || null;
  countiesById.set(c['ID'], {
    id: parseInt(c['ID'], 10),
    os_id: c['Os id'],
    label: c['Label'],
    slug: c['Slug'],
    region_id: regId,
    region: region
  });
}

// Build GeoJSON Features
const features = [];
let skippedNoCoords = 0;

for (const m of rawMuseums) {
  const lat = parseFloat(m['Latitude']);
  const lng = parseFloat(m['Longitude']);

  if (isNaN(lat) || isNaN(lng)) {
    skippedNoCoords++;
    continue;
  }

  const statusCode = m['Status code'];
  const statusLabel = statusCode === '1' ? 'Full' : statusCode === '2' ? 'Provisional' : (statusCode || 'Unknown');

  // County resolution
  const countyData = m['County'] ? countiesById.get(m['County']) : null;
  const countyName = countyData ? countyData.label : null;
  const countyOsId = countyData ? countyData.os_id : null;
  const countySlug = countyData ? countyData.slug : null;

  // Region resolution: from county join first, fallback to direct museum Os region id
  let regionData = countyData ? countyData.region : null;
  if (!regionData && m['Os region id']) {
    regionData = regionsByOsId.get(m['Os region id']) || null;
  }

  const regionName = regionData ? regionData.label : null;
  const regionOsId = regionData ? regionData.os_id : (m['Os region id'] || null);
  const regionSlug = regionData ? regionData.slug : null;

  features.push({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lng, lat]
    },
    properties: {
      id: parseInt(m['ID'], 10) || m['ID'],
      name: m['Name'] || null,
      status: statusLabel,
      status_code: parseInt(statusCode, 10) || null,
      accreditation_number: m['Accreditation number'] || null,
      slug: m['Slug'] || null,
      postcode: m['Postcode'] || null,
      address: m['Address'] || null,
      county: countyName,
      county_id: m['County'] ? parseInt(m['County'], 10) : null,
      county_os_id: countyOsId,
      county_slug: countySlug,
      region: regionName,
      region_os_id: regionOsId,
      region_slug: regionSlug,
      museum_type: m['Museum type'] || null,
      wikidata_id: m['Wikidata id'] || null,
      isni: m['Isni'] || null
    }
  });
}

const outDir = path.resolve('public', 'data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'museums.geojson');

const geojson = {
  type: 'FeatureCollection',
  features: features
};

fs.writeFileSync(outPath, JSON.stringify(geojson, null, 2), 'utf8');

console.log(`Generated: ${outPath}`);
console.log(`Total mapped features: ${features.length}`);
console.log(`Skipped without coordinates: ${skippedNoCoords}`);