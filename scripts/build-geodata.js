import fs from 'node:fs';
import path from 'node:path';

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// 1. Resolve CSV path from public/csv/
const csvPath = path.resolve('public', 'csv', 'accredited_augmented_with_os.csv');

if (!fs.existsSync(csvPath)) {
  console.error(`Error: CSV file not found at ${csvPath}`);
  process.exit(1);
}

const csvRaw = fs.readFileSync(csvPath, 'utf8');
const lines = csvRaw.split(/\r?\n/).filter(line => line.trim().length > 0);
const headers = parseCSVLine(lines[0]);

const features = [];

for (let i = 1; i < lines.length; i++) {
  const values = parseCSVLine(lines[i]);
  const row = {};
  headers.forEach((h, idx) => { row[h] = values[idx] || ''; });

  const lat = parseFloat(row['Latitude']);
  const lng = parseFloat(row['longitude']);
  if (isNaN(lat) || isNaN(lng)) continue;

  const statusCode = row['Status code'];
  const statusLabel = statusCode === '1' ? 'Full' : statusCode === '2' ? 'Provisional' : (statusCode || 'Unknown');

  const osCounty = row['os_county_name'] || null;
  const osDistrict = row['os_district_name'] || null;
  const osCountyCode = row['os_county_code'] || '';
  const osDistrictCode = row['os_district_code'] || null;

  const countyName = osCounty || osDistrict || row['County'] || null;
  
  // Safe prefix check for placeholder unitary county codes (E99999999 / W99999999)
  const isGenericCounty = osCountyCode.startsWith('E99999999') || osCountyCode.startsWith('W99999999');
  const countyOsId = (!isGenericCounty && osCountyCode) ? osCountyCode : (osDistrictCode || row['County'] || null);

  features.push({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lng, lat]
    },
    properties: {
      id: parseInt(row['ID'], 10) || row['ID'],
      name: row['Name'] || null,
      status: statusLabel,
      status_code: parseInt(statusCode, 10) || null,
      accreditation_number: row['Accreditation number'] || null,
      url: row['official website'] || null,
      postcode: row['postcode'] || null,
      county: countyName,
      county_os_id: countyOsId,
      district: osDistrict,
      district_os_id: osDistrictCode,
      region_os_id: row['Os region id'] || null,
      museum_type: row['Museum type'] || null,
      slug: row['Slug'] || null,
      wikidata_id: row['wikidata_id'] || null
    }
  });
}

// 2. Output destination: public/data/museums.geojson
const outDir = path.resolve('public', 'data');
fs.mkdirSync(outDir, { recursive: true });

const outPath = path.join(outDir, 'museums.geojson');
fs.writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }, null, 2));

console.log(`Successfully built museums.geojson with ${features.length} features at ${outPath}`);