import maplibregl from 'maplibre-gl';

// Asset & base resolution
const BASE_URL = import.meta.env.BASE_URL;
const heLogoUrl = `${BASE_URL}images/Historic_England.svg`;

function isDarkMode() {
    return document.documentElement.classList.contains('dark');
}

// Setup Theme Toggle
const themeToggleBtn = document.getElementById('theme-toggle-btn');
if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });
}

const STYLES = {
    light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
};

const urlParams   = new URLSearchParams(window.location.search);
const initialLng  = parseFloat(urlParams.get('lng')) || -2.0;
const initialLat  = parseFloat(urlParams.get('lat')) || 53.0;
const initialZoom = parseFloat(urlParams.get('zoom')) || 6;
let activeTheme   = isDarkMode() ? 'dark' : 'light';
let activePopup   = null;

const map = new maplibregl.Map({
    container: 'map',
    style: STYLES[activeTheme],
    center: [initialLng, initialLat],
    zoom: initialZoom,
    attributionControl: false
});

const customAttributionControl = new maplibregl.AttributionControl({
    compact: true,
    customAttribution: [
        '<a href="https://historicengland.org.uk/listing/the-list/" target="_blank" rel="noopener noreferrer">Contains NHLE & HAR data &copy; Historic England</a>',
        '<a href="https://www.ordnancesurvey.co.uk/" target="_blank" rel="noopener noreferrer">Contains OS data &copy; Crown copyright &amp; database right</a>',
        '<a href="https://www.artscouncil.org.uk/supporting-arts-museums-and-libraries/uk-museum-accreditation-scheme" target="_blank" rel="noopener noreferrer">&copy; Arts Council England</a>'
    ]
});
map.addControl(customAttributionControl, 'bottom-right');
map.addControl(new maplibregl.NavigationControl(), 'top-right');

const geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true
});
map.addControl(geolocateControl, 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

// DOM Elements
const searchInput           = document.getElementById('map-search-input');
const counterEl             = document.getElementById('point-counter');
const loaderEl              = document.getElementById('loading-indicator');
const fitBtn                = document.getElementById('btn-fit-bounds');

const bboxNorthEl           = document.getElementById('bbox-north');
const bboxSouthEl           = document.getElementById('bbox-south');
const bboxEastEl            = document.getElementById('bbox-east');
const bboxWestEl            = document.getElementById('bbox-west');

const toggleFiltersBtn      = document.getElementById('btn-toggle-filters');
const filtersPanel          = document.getElementById('advanced-filters-panel');
const chevronEl             = document.getElementById('filters-chevron');
const filterStatus          = document.getElementById('filter-status');
const filterCounty          = document.getElementById('filter-county');
const filterRegion          = document.getElementById('filter-region');
const activeCountyBadge     = document.getElementById('active-county-badge');

const filterRadius          = document.getElementById('filter-radius');
const btnUseLocation        = document.getElementById('btn-use-location');
const btnClearProximity     = document.getElementById('btn-clear-proximity');
const proximityStatus       = document.getElementById('proximity-status');

// Layer Checkboxes
const chkListedBuildings    = document.getElementById('layer-listed-buildings');
const chkScheduledMonuments = document.getElementById('layer-scheduled-monuments');
const chkHeritageAtRisk     = document.getElementById('layer-heritage-at-risk');
const heStatusEl            = document.getElementById('he-status');

let proximityOrigin = null;
let activeCountyBounds = null;
let allMuseums = [];
let currentGeoJson = { type: 'FeatureCollection', features: [] };
const countyGeoJsonCache = {};
let activeHeritageAbortController = null;
let fetchTimeout = null;

// Parse Initial URL State
if (!urlParams.get('county')) {
    if (urlParams.get('near_lat') && urlParams.get('near_lng')) {
        proximityOrigin = {
            lat: parseFloat(urlParams.get('near_lat')),
            lng: parseFloat(urlParams.get('near_lng'))
        };
    }
    if (urlParams.get('radius_km') && filterRadius) {
        filterRadius.value = urlParams.get('radius_km');
    }
}
if (urlParams.get('query') && searchInput) searchInput.value = urlParams.get('query');

// Haversine Distance helper (KM)
function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createGeoJSONCircle(center, radiusKm, points = 64) {
    const coords = { latitude: center.lat, longitude: center.lng };
    const ret = [];
    const distanceX = radiusKm / (111.320 * Math.cos((coords.latitude * Math.PI) / 180));
    const distanceY = radiusKm / 110.574;

    for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI);
        const x = distanceX * Math.cos(theta);
        const y = distanceY * Math.sin(theta);
        ret.push([coords.longitude + x, coords.latitude + y]);
    }
    ret.push(ret[0]);

    return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ret] }
    };
}

function updateProximityCircle() {
    const radius = parseFloat(filterRadius?.value);
    const source = map.getSource('proximity-circle-source');
    if (!source) return;

    if (!proximityOrigin || !radius) {
        source.setData({ type: 'FeatureCollection', features: [] });
        if (btnClearProximity) btnClearProximity.classList.add('hidden');
        if (proximityStatus) proximityStatus.classList.add('hidden');
        return;
    }

    const circleFeature = createGeoJSONCircle(proximityOrigin, radius);
    source.setData({ type: 'FeatureCollection', features: [circleFeature] });

    if (btnClearProximity) btnClearProximity.classList.remove('hidden');
    if (proximityStatus) {
        proximityStatus.classList.remove('hidden');
        proximityStatus.textContent = `Proximity active: ${proximityOrigin.lat.toFixed(3)}, ${proximityOrigin.lng.toFixed(3)} (±${radius}km)`;
    }
}

function computeGeoJSONBounds(geojson) {
    const bounds = new maplibregl.LngLatBounds();
    const extractCoords = (coords) => {
        if (typeof coords[0] === 'number') {
            bounds.extend(coords);
        } else {
            coords.forEach(extractCoords);
        }
    };

    if (geojson.type === 'FeatureCollection') {
        geojson.features.forEach(f => extractCoords(f.geometry.coordinates));
    } else if (geojson.type === 'Feature') {
        extractCoords(geojson.geometry.coordinates);
    } else if (geojson.coordinates) {
        extractCoords(geojson.coordinates);
    }
    return bounds;
}

async function loadCountyBoundary(osId, fitToBoundary = true) {
    const source = map.getSource('county-boundary-source');
    if (!source) return;

    const monSource = map.getSource('he-monuments-source');
    const bldSource = map.getSource('he-buildings-source');
    const harSource = map.getSource('he-har-source');
    const musSource = map.getSource('museums-source');
    
    if (monSource) monSource.setData({ type: 'FeatureCollection', features: [] });
    if (bldSource) bldSource.setData({ type: 'FeatureCollection', features: [] });
    if (harSource) harSource.setData({ type: 'FeatureCollection', features: [] });
    if (musSource) musSource.setData({ type: 'FeatureCollection', features: [] });

    if (!osId) {
        activeCountyBounds = null;
        source.setData({ type: 'FeatureCollection', features: [] });
        if (activeCountyBadge) activeCountyBadge.classList.add('hidden');
        scheduleFetch(50);
        syncHeritageData();
        return;
    }

    proximityOrigin = null;
    if (filterRadius) filterRadius.value = "";
    updateProximityCircle();

    const selectedOption = filterCounty.options[filterCounty.selectedIndex];
    const countyLabel = selectedOption ? selectedOption.textContent : 'County';

    if (activeCountyBadge) {
        activeCountyBadge.textContent = countyLabel;
        activeCountyBadge.classList.remove('hidden');
    }

    try {
        let data = countyGeoJsonCache[osId];
        if (!data) {
            const response = await fetch(`${BASE_URL}os_geo_json/${encodeURIComponent(osId)}.geojson`);
            if (!response.ok) throw new Error(`County GeoJSON not found: ${osId}`);
            data = await response.json();
            countyGeoJsonCache[osId] = data;
        }

        source.setData(data);
        activeCountyBounds = computeGeoJSONBounds(data);

        if (fitToBoundary && !activeCountyBounds.isEmpty()) {
            map.fitBounds(activeCountyBounds, { padding: 50, duration: 600 });
        } else {
            scheduleFetch(50);
            syncHeritageData();
        }
    } catch (err) {
        console.warn('Unable to load County GeoJSON boundary:', err);
        activeCountyBounds = null;
        source.setData({ type: 'FeatureCollection', features: [] });
        if (activeCountyBadge) activeCountyBadge.classList.add('hidden');
        scheduleFetch(50);
        syncHeritageData();
    }
}

function syncUrlParams() {
    const center = map.getCenter();
    const params = new URLSearchParams();

    params.set('lat', center.lat.toFixed(4));
    params.set('lng', center.lng.toFixed(4));
    params.set('zoom', map.getZoom().toFixed(2));

    if (searchInput?.value.trim()) params.set('query', searchInput.value.trim());
    if (filterStatus?.value) params.set('status', filterStatus.value);
    if (filterCounty?.value) params.set('county', filterCounty.value);
    if (filterRegion?.value) params.set('region', filterRegion.value);

    if (proximityOrigin && filterRadius?.value) {
        params.set('near_lat', proximityOrigin.lat.toFixed(5));
        params.set('near_lng', proximityOrigin.lng.toFixed(5));
        params.set('radius_km', filterRadius.value);
    }

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
}

function updateBoundingBoxDisplay(north, south, east, west) {
    if (bboxNorthEl) bboxNorthEl.textContent = Number(north).toFixed(4);
    if (bboxSouthEl) bboxSouthEl.textContent = Number(south).toFixed(4);
    if (bboxEastEl)  bboxEastEl.textContent  = Number(east).toFixed(4);
    if (bboxWestEl)  bboxWestEl.textContent  = Number(west).toFixed(4);
}

function syncPalette() {
    if (!map.isStyleLoaded()) return;

    const dark = isDarkMode();
    const layers = map.getStyle().layers || [];

    layers.forEach(layer => {
        const id = layer.id;

        if (id === 'background' || id.includes('background')) {
            map.setPaintProperty(id, 'background-color', dark ? '#0f172a' : '#f8fafc');
        } else if (id.includes('land') || id.includes('area')) {
            if (layer.type === 'fill') {
                map.setPaintProperty(id, 'fill-color', dark ? '#090d16' : '#f1f5f9');
            }
        } else if (id.includes('water')) {
            if (layer.type === 'fill') {
                map.setPaintProperty(id, 'fill-color', dark ? '#020617' : '#e2e8f0');
            }
        } else if (id.includes('road') || id.includes('transport') || id.includes('highway') || id.includes('tunnel')) {
            if (layer.type === 'line') {
                map.setPaintProperty(id, 'line-color', dark ? '#1e293b' : '#ffffff');
            }
        } else if (id.includes('boundary') || id.includes('admin')) {
            if (layer.type === 'line') {
                map.setPaintProperty(id, 'line-color', dark ? '#334155' : '#cbd5e1');
            }
        } else if (layer.type === 'symbol' && id !== 'cluster-count') {
            if (map.getPaintProperty(id, 'text-color')) {
                map.setPaintProperty(id, 'text-color', dark ? '#64748b' : '#475569');
            }
            if (map.getPaintProperty(id, 'text-halo-color')) {
                map.setPaintProperty(id, 'text-halo-color', dark ? '#090d16' : '#ffffff');
            }
        }
    });

    if (map.getLayer('clusters')) {
        map.setPaintProperty('clusters', 'circle-stroke-color', dark ? '#090d16' : '#ffffff');
    }
    if (map.getLayer('unclustered-point')) {
        map.setPaintProperty('unclustered-point', 'circle-stroke-color', dark ? '#020617' : '#ffffff');
    }
    if (map.getLayer('he-monuments-fill')) {
        map.setPaintProperty('he-monuments-fill', 'fill-color', dark ? '#ef4444' : '#dc2626');
    }
    if (map.getLayer('county-boundary-fill')) {
        map.setPaintProperty('county-boundary-fill', 'fill-color', dark ? '#6366f1' : '#4f46e5');
    }
    if (map.getLayer('county-boundary-line')) {
        map.setPaintProperty('county-boundary-line', 'line-color', dark ? '#818cf8' : '#4338ca');
    }
}

function addLayers() {
    const dark = isDarkMode();

    // 1. Proximity Buffer Layer
    if (!map.getSource('proximity-circle-source')) {
        map.addSource('proximity-circle-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: 'proximity-circle-fill',
            type: 'fill',
            source: 'proximity-circle-source',
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 }
        });
        map.addLayer({
            id: 'proximity-circle-stroke',
            type: 'line',
            source: 'proximity-circle-source',
            paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [2, 2] }
        });
    }

    // 2. County Boundary Layer
    if (!map.getSource('county-boundary-source')) {
        map.addSource('county-boundary-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: 'county-boundary-fill',
            type: 'fill',
            source: 'county-boundary-source',
            paint: {
                'fill-color': dark ? '#6366f1' : '#4f46e5',
                'fill-opacity': dark ? 0.08 : 0.05
            }
        });
        map.addLayer({
            id: 'county-boundary-line',
            type: 'line',
            source: 'county-boundary-source',
            paint: {
                'line-color': dark ? '#818cf8' : '#4338ca',
                'line-width': 2.5,
                'line-opacity': 0.85,
                'line-dasharray': [3, 1.5]
            }
        });
    }

    // 3. Historic England Scheduled Monuments (Polygons)
    if (!map.getSource('he-monuments-source')) {
        map.addSource('he-monuments-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: 'he-monuments-fill',
            type: 'fill',
            source: 'he-monuments-source',
            paint: { 'fill-color': dark ? '#ef4444' : '#dc2626', 'fill-opacity': 0.45 }
        });
        map.addLayer({
            id: 'he-monuments-stroke',
            type: 'line',
            source: 'he-monuments-source',
            paint: { 'line-color': '#b91c1c', 'line-width': 2 }
        });
    }

    // 4. Historic England Listed Buildings (Points)
    if (!map.getSource('he-buildings-source')) {
        map.addSource('he-buildings-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: 'he-buildings-circle',
            type: 'circle',
            source: 'he-buildings-source',
            paint: {
                'circle-color': '#f59e0b',
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 14, 6],
                'circle-stroke-width': 1.25,
                'circle-stroke-color': '#ffffff'
            }
        });
    }

    // 5. Historic England Heritage at Risk 2026 (Points)
    if (!map.getSource('he-har-source')) {
        map.addSource('he-har-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: 'he-har-circle',
            type: 'circle',
            source: 'he-har-source',
            paint: {
                'circle-color': '#9333ea', // Distinct purple
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 14, 7],
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ffffff'
            }
        });
    }

    // 6. Museums Layers
    if (!map.getSource('museums-source')) {
        map.addSource('museums-source', {
            type: 'geojson',
            data: currentGeoJson,
            cluster: true,
            clusterMaxZoom: 13,
            clusterRadius: 35
        });
    }

    map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'museums-source',
        filter: ['has', 'point_count'],
        paint: {
            'circle-color': [
                'step', ['get', 'point_count'],
                '#2563eb', 20,
                '#3b82f6', 100,
                '#60a5fa'
            ],
            'circle-radius': ['step', ['get', 'point_count'], 14, 15, 18, 50, 24],
            'circle-stroke-width': 2,
            'circle-stroke-color': dark ? '#090d16' : '#ffffff'
        }
    });

    map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'museums-source',
        filter: ['has', 'point_count'],
        layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 11,
            'text-allow-overlap': true
        },
        paint: { 'text-color': '#ffffff' }
    });

    map.addLayer({
        id: 'unclustered-hitbox',
        type: 'circle',
        source: 'museums-source',
        filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-radius': 16,
            'circle-opacity': 0.01,
            'circle-color': '#000000'
        }
    });

    map.addLayer({
        id: 'unclustered-point',
        type: 'circle',
        source: 'museums-source',
        filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-color': [
                'match',
                ['get', 'status'],
                'Full', '#10b981',
                'Fully Accredited', '#10b981',
                'Provisional', '#f59e0b',
                'Provisionally Accredited', '#f59e0b',
                '#3b82f6'
            ],
            'circle-radius': 5.5,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': dark ? '#020617' : '#ffffff'
        }
    });
}

const showMuseumPopup = (e) => {
    const bbox = [
        [e.point.x - 10, e.point.y - 10],
        [e.point.x + 10, e.point.y + 10]
    ];
    const features = map.queryRenderedFeatures(bbox, {
        layers: ['unclustered-point', 'unclustered-hitbox']
    });

    if (!features.length) return;

    const feature = features[0];
    const coordinates = feature.geometry.coordinates.slice();
    const props = feature.properties;

    const accNum = props.accreditation_number 
        ? `<span class="text-[10px] font-mono text-slate-400 dark:text-slate-500">#${props.accreditation_number}</span>` 
        : '';
    const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${coordinates[1]},${coordinates[0]}`;

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({ offset: 10 })
        .setLngLat(coordinates)
        .setHTML(`
            <div class="w-68 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 p-4 font-sans" role="dialog" aria-labelledby="popup-museum-title">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-[10px] uppercase font-bold tracking-wider text-blue-600 dark:text-blue-400">Accredited Museum</span>
                    ${accNum}
                </div>
                <h4 id="popup-museum-title" class="font-heading font-bold text-slate-900 dark:text-slate-100 text-sm leading-snug">${props.name}</h4>
                <div class="mt-2 text-xs text-slate-600 dark:text-slate-400">Status: <span class="font-medium text-slate-800 dark:text-slate-200">${props.status ?? 'N/A'}</span></div>
                <div class="text-xs text-slate-600 dark:text-slate-400">County: <span class="font-medium text-slate-800 dark:text-slate-200">${props.county ?? 'N/A'}</span></div>
                ${props.postcode ? `<div class="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">${props.postcode}</div>` : ''}
                
                <div class="mt-3.5 pt-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <a href="${directionsUrl}" target="_blank" rel="noopener noreferrer" 
                       aria-label="Get directions to ${props.name} on Google Maps (opens in new tab)"
                       class="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:underline transition-colors">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                        </svg>
                        Directions
                    </a>
                    ${props.url ? `
                    <a href="${props.url}" target="_blank" rel="noopener noreferrer"
                       aria-label="View museum profile for ${props.name}"
                       class="inline-flex items-center text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 focus:outline-none focus:underline transition-colors">
                        View Record <span aria-hidden="true">&rarr;</span>
                    </a>` : ''}
                </div>
            </div>
        `)
        .addTo(map);
};

const showHeritagePopup = (e, designation) => {
    const feature = e.features[0];
    if (!feature) return;

    const p = feature.properties || {};
    const listEntry = p.ListEntry || p.LISTENTRY || p.list_entry || p.HeritageAtRiskID || p.HAR_ID || '';
    const name = p.Name || p.NAME || p.SiteName || p.SITENAME || designation;
    const grade = p.Grade || p.GRADE || null;
    const nhleUrl = p.Hyperlink || p.HYPERLINK || (listEntry && !String(listEntry).startsWith('HAR') ? `https://historicengland.org.uk/listing/the-list/list-entry/${listEntry}` : null);
    const parish = p.Parish || p.PARISH || p.CivilParish || null;
    const ngr = p.NationalGridReference || p.NGR || p.GridRef || null;
    const condition = p.Condition || p.CONDITION || null;
    const priority = p.PriorityCategory || p.Priority || p.PRIORITY || null;

    const isHAR = designation === 'Heritage at Risk';
    const isMonument = designation === 'Scheduled Monument';

    let badgeClass = 'bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-400';
    if (isHAR) {
        badgeClass = 'bg-purple-100 dark:bg-purple-950/70 text-purple-700 dark:text-purple-400';
    } else if (isMonument) {
        badgeClass = 'bg-red-100 dark:bg-red-950/70 text-red-700 dark:text-red-400';
    }

    if (activePopup) activePopup.remove();

    activePopup = new maplibregl.Popup({ offset: 10 })
        .setLngLat(e.lngLat)
        .setHTML(`
            <div class="w-72 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 rounded-xl shadow-lg border border-slate-200 dark:border-slate-800 overflow-hidden font-sans" role="dialog">
                <div class="px-4 pt-3.5 pb-2.5 pr-8 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-800/40 flex items-start justify-between gap-2">
                    <div class="pr-2">
                        <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase ${badgeClass}">
                            ${designation} ${grade ? `(${grade})` : ''}
                        </span>
                        <h4 class="mt-1.5 text-xs font-bold leading-snug line-clamp-2 text-slate-900 dark:text-slate-100">
                            ${name}
                        </h4>
                    </div>
                    <img src="${heLogoUrl}" alt="Historic England" class="h-6 w-auto shrink-0 object-contain mt-0.5 mr-2" />
                </div>

                <div class="p-3.5 space-y-1.5 text-xs">
                    <div class="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                        <span class="text-slate-500 dark:text-slate-400">List / HAR Entry:</span>
                        <span class="font-mono font-medium text-slate-800 dark:text-slate-200">${listEntry || '—'}</span>
                    </div>
                    ${condition ? `
                    <div class="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                        <span class="text-slate-500 dark:text-slate-400">Condition:</span>
                        <span class="font-semibold text-rose-600 dark:text-rose-400">${condition}</span>
                    </div>` : ''}
                    ${priority ? `
                    <div class="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                        <span class="text-slate-500 dark:text-slate-400">Priority:</span>
                        <span class="font-mono font-medium text-slate-800 dark:text-slate-200">${priority}</span>
                    </div>` : ''}
                    ${parish ? `
                    <div class="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                        <span class="text-slate-500 dark:text-slate-400">Parish:</span>
                        <span class="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[130px]">${parish}</span>
                    </div>` : ''}
                    ${ngr ? `
                    <div class="flex items-center justify-between py-1 border-b border-slate-100 dark:border-slate-800/60">
                        <span class="text-slate-500 dark:text-slate-400">Grid Ref:</span>
                        <span class="font-mono font-medium text-slate-800 dark:text-slate-200">${ngr}</span>
                    </div>` : ''}
                </div>

                ${nhleUrl ? `
                <div class="px-3.5 py-2.5 bg-slate-50/50 dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-800/80 flex justify-end">
                    <a href="${nhleUrl}" target="_blank" rel="noopener noreferrer" 
                       class="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline transition-colors">
                        <span>Historic England Listing</span>
                        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                    </a>
                </div>` : ''}
            </div>
        `)
        .addTo(map);
};

// Historic England Query Engine
async function syncHeritageData() {
    const monSource = map.getSource('he-monuments-source');
    const bldSource = map.getSource('he-buildings-source');
    const harSource = map.getSource('he-har-source');
    if (!monSource || !bldSource || !harSource) return;

    const wantBuildings = chkListedBuildings?.checked;
    const wantMonuments = chkScheduledMonuments?.checked;
    const wantHAR       = chkHeritageAtRisk?.checked;

    if (!wantBuildings) bldSource.setData({ type: 'FeatureCollection', features: [] });
    if (!wantMonuments) monSource.setData({ type: 'FeatureCollection', features: [] });
    if (!wantHAR) harSource.setData({ type: 'FeatureCollection', features: [] });

    if (!wantBuildings && !wantMonuments && !wantHAR) {
        if (heStatusEl) heStatusEl.textContent = '';
        return;
    }

    if (activeHeritageAbortController) {
        activeHeritageAbortController.abort();
    }
    activeHeritageAbortController = new AbortController();
    const signal = activeHeritageAbortController.signal;

    if (heStatusEl) heStatusEl.textContent = 'Updating NHLE/HAR...';

    let queryBounds = map.getBounds();
    if (filterCounty?.value && activeCountyBounds && !activeCountyBounds.isEmpty()) {
        queryBounds = activeCountyBounds;
    }

    const envelopeObj = {
        xmin: queryBounds.getWest(),
        ymin: queryBounds.getSouth(),
        xmax: queryBounds.getEast(),
        ymax: queryBounds.getNorth(),
        spatialReference: { wkid: 4326 }
    };

    const fetchEsriGeoJSON = async (baseUrl) => {
        const params = new URLSearchParams({
            where: '1=1',
            geometry: JSON.stringify(envelopeObj),
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            outSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: '*',
            returnGeometry: 'true',
            resultRecordCount: '2000',
            f: 'geojson'
        });

        const res = await fetch(`${baseUrl}/query?${params.toString()}`, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    };

    try {
        let total = 0;
        const promises = [];

        // 1. Scheduled Monuments
        if (wantMonuments) {
            promises.push(
                fetchEsriGeoJSON('https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer/6')
                    .then(monData => {
                        if (monData?.features) {
                            monSource.setData(monData);
                            total += monData.features.length;
                        }
                    })
            );
        }

        // 2. Listed Buildings
        if (wantBuildings) {
            promises.push(
                fetchEsriGeoJSON('https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer/0')
                    .then(bldData => {
                        if (bldData?.features) {
                            bldSource.setData(bldData);
                            total += bldData.features.length;
                        }
                    })
            );
        }

        // 3. Heritage at Risk (2026)
        if (wantHAR) {
            promises.push(
                fetchEsriGeoJSON('https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/HAR_2026_OTHR_WGS84/FeatureServer/0')
                    .then(harData => {
                        if (harData?.features) {
                            harSource.setData(harData);
                            total += harData.features.length;
                        }
                    })
            );
        }

        await Promise.all(promises);
        if (heStatusEl) heStatusEl.textContent = `${total} HE records`;
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.warn('Historic England query notice:', err);
            if (heStatusEl) heStatusEl.textContent = 'Unavailable';
        }
    }
}

// Client-side Museum Data Engine
async function loadMuseumDataset() {
    try {
        const res = await fetch(`${BASE_URL}data/museums.geojson`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        allMuseums = data.features || [];

        populateFilterDropdowns(allMuseums);
        filterAndRenderPoints();
    } catch (err) {
        console.warn('Could not load static museums.geojson:', err);
        if (counterEl) counterEl.textContent = 'Failed to load museums dataset';
    }
}

function populateFilterDropdowns(features) {
    const statuses = new Set();
    const counties = new Map();
    const regions = new Map();

    features.forEach(f => {
        const p = f.properties || {};
        if (p.status) statuses.add(p.status);
        if (p.county_os_id && p.county) counties.set(p.county_os_id, p.county);
        if (p.region_os_id && p.region) regions.set(p.region_os_id, p.region);
    });

    statuses.forEach(status => {
        const opt = document.createElement('option');
        opt.value = status;
        opt.textContent = status;
        if (urlParams.get('status') === status) opt.selected = true;
        filterStatus?.appendChild(opt);
    });

    counties.forEach((label, id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        if (urlParams.get('county') === id) opt.selected = true;
        filterCounty?.appendChild(opt);
    });

    regions.forEach((label, id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        if (urlParams.get('region') === id) opt.selected = true;
        filterRegion?.appendChild(opt);
    });
}

function filterAndRenderPoints() {
    if (loaderEl) loaderEl.classList.remove('hidden');

    const search = searchInput?.value.toLowerCase().trim() || '';
    const statusVal = filterStatus?.value || '';
    const countyVal = filterCounty?.value || '';
    const regionVal = filterRegion?.value || '';
    const radiusVal = parseFloat(filterRadius?.value) || null;

    let north, south, east, west;
    if (countyVal && activeCountyBounds && !activeCountyBounds.isEmpty()) {
        north = activeCountyBounds.getNorth();
        south = activeCountyBounds.getSouth();
        east  = activeCountyBounds.getEast();
        west  = activeCountyBounds.getWest();
    } else {
        const bounds = map.getBounds();
        north = Math.min(85, bounds.getNorth());
        south = Math.max(-85, bounds.getSouth());
        east  = bounds.getEast();
        west  = bounds.getWest();
    }
    updateBoundingBoxDisplay(north, south, east, west);

    const filtered = allMuseums.filter(feature => {
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) return false;
        const [lng, lat] = coords;
        const props = feature.properties || {};

        if (lat > north || lat < south || lng > east || lng < west) return false;
        if (statusVal && props.status !== statusVal) return false;
        if (countyVal && props.county_os_id !== countyVal) return false;
        if (regionVal && props.region_os_id !== regionVal) return false;

        if (proximityOrigin && radiusVal) {
            const dist = getDistanceKm(proximityOrigin.lat, proximityOrigin.lng, lat, lng);
            if (dist > radiusVal) return false;
        }

        if (search) {
            const name = (props.name || '').toLowerCase();
            const postcode = (props.postcode || '').toLowerCase();
            if (!name.includes(search) && !postcode.includes(search)) return false;
        }

        return true;
    });

    currentGeoJson = { type: 'FeatureCollection', features: filtered };
    const source = map.getSource('museums-source');
    if (source) {
        source.setData(currentGeoJson);
    }

    if (counterEl) {
        const radiusTxt = radiusVal && proximityOrigin ? ` (within ${radiusVal}km)` : '';
        counterEl.textContent = `${filtered.length} museums in view${radiusTxt}`;
    }

    if (fitBtn) {
        if (filtered.length > 0) fitBtn.classList.remove('hidden');
        else fitBtn.classList.add('hidden');
    }

    if (loaderEl) loaderEl.classList.add('hidden');
}

function scheduleFetch(delay = 150) {
    clearTimeout(fetchTimeout);
    fetchTimeout = setTimeout(filterAndRenderPoints, delay);
}

// Map Event Listeners
map.on('load', () => {
    addLayers();
    syncPalette();
    updateProximityCircle();

    // Click Popups
    map.on('click', 'unclustered-point', showMuseumPopup);
    map.on('click', 'unclustered-hitbox', showMuseumPopup);
    map.on('click', 'he-monuments-fill', (e) => showHeritagePopup(e, 'Scheduled Monument'));
    map.on('click', 'he-buildings-circle', (e) => showHeritagePopup(e, 'Listed Building'));
    map.on('click', 'he-har-circle', (e) => showHeritagePopup(e, 'Heritage at Risk'));

    // Cluster Expansion Zoom
    map.on('click', 'clusters', async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        if (!features.length) return;
        const clusterId = features[0].properties.cluster_id;
        const source = map.getSource('museums-source');
        if (source) {
            const zoom = await source.getClusterExpansionZoom(clusterId);
            map.easeTo({
                center: features[0].geometry.coordinates,
                zoom: zoom
            });
        }
    });

    // Pointer Cursor Handling
    const interactiveLayers = [
        'clusters', 
        'unclustered-hitbox', 
        'he-monuments-fill', 
        'he-buildings-circle', 
        'he-har-circle'
    ];
    interactiveLayers.forEach(layer => {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });

    loadMuseumDataset();

    if (filterCounty?.value) {
        loadCountyBoundary(filterCounty.value, true);
    } else {
        syncHeritageData();
    }
});

const themeObserver = new MutationObserver(() => {
    const nextTheme = isDarkMode() ? 'dark' : 'light';
    if (nextTheme === activeTheme) return;
    activeTheme = nextTheme;
    syncPalette();
});

themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
});

map.on('move', () => {
    const bounds = map.getBounds();
    updateBoundingBoxDisplay(
        bounds.getNorth(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getWest()
    );
});

map.on('moveend', () => {
    syncUrlParams();
    syncHeritageData();
    scheduleFetch(100);
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activePopup) {
        activePopup.remove();
        activePopup = null;
    }
});

if (toggleFiltersBtn) {
    toggleFiltersBtn.addEventListener('click', () => {
        const isHidden = filtersPanel.classList.toggle('hidden');
        toggleFiltersBtn.setAttribute('aria-expanded', !isHidden);
        if (chevronEl) chevronEl.innerHTML = isHidden ? '&darr;' : '&uarr;';
    });
}

searchInput?.addEventListener('input', () => {
    syncUrlParams();
    scheduleFetch(300);
});

filterCounty?.addEventListener('change', () => {
    clearTimeout(fetchTimeout);
    if (activeHeritageAbortController) {
        activeHeritageAbortController.abort();
    }
    loadCountyBoundary(filterCounty.value, true);
    syncUrlParams();
});

[filterStatus, filterRegion].forEach(input => {
    input?.addEventListener('change', () => {
        syncUrlParams();
        scheduleFetch(100);
    });
});

[chkListedBuildings, chkScheduledMonuments, chkHeritageAtRisk].forEach(chk => {
    chk?.addEventListener('change', () => {
        syncHeritageData();
    });
});

filterRadius?.addEventListener('change', () => {
    if (filterRadius.value && !proximityOrigin) {
        const center = map.getCenter();
        proximityOrigin = { lat: center.lat, lng: center.lng };
    }
    updateProximityCircle();
    syncUrlParams();
    scheduleFetch(100);
});

btnUseLocation?.addEventListener('click', () => {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
    }

    btnUseLocation.disabled = true;
    const originalText = btnUseLocation.innerHTML;
    btnUseLocation.innerHTML = `<span class="animate-pulse">Locating...</span>`;

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            proximityOrigin = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude
            };

            if (!filterRadius.value) {
                filterRadius.value = "25";
            }

            map.flyTo({
                center: [proximityOrigin.lng, proximityOrigin.lat],
                zoom: 10
            });

            updateProximityCircle();
            syncUrlParams();

            btnUseLocation.disabled = false;
            btnUseLocation.innerHTML = originalText;
        },
        (err) => {
            console.error(err);
            alert('Could not retrieve your location.');
            btnUseLocation.disabled = false;
            btnUseLocation.innerHTML = originalText;
        },
        { enableHighAccuracy: true, timeout: 8000 }
    );
});

btnClearProximity?.addEventListener('click', () => {
    proximityOrigin = null;
    if (filterRadius) filterRadius.value = "";
    updateProximityCircle();
    syncUrlParams();
    scheduleFetch(100);
});

if (fitBtn) {
    fitBtn.addEventListener('click', () => {
        if (!currentGeoJson.features.length) return;
        const bounds = new maplibregl.LngLatBounds();
        currentGeoJson.features.forEach(f => bounds.extend(f.geometry.coordinates));
        map.fitBounds(bounds, { padding: 80, maxZoom: 13 });
    });
}