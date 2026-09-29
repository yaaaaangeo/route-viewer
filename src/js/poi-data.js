// ══════════════════════════════════════════════════════════
//  poi-data — 자동 분석(auto-subzones.js)에 넘길 지도 POI 를 "실제 지도 데이터"에서만 만든다
//
//  출처는 두 가지뿐이다.
//    1) OpenStreetMap(Overpass) — 사용자가 "지도 POI 받기"를 눌렀을 때만 받는다(자동으로 받지 않음).
//       학교·업무시설·상업시설·병원·시장·역/정류장·아파트 단지.
//    2) 누적 지도가 Coverage 계산 때 이미 받아 둔 OSM 건물 캐시 — 그중 "아파트 단지 경계"
//       (landuse=residential + residential=apartments)만 아파트 단지 POI 로 쓴다.
//
//  ⚠ 사실성
//   · 받지 않은 종류는 "0곳"이 아니라 "확인 안 됨"이다 — coveredCategories 에 없는 종류는 판정에 쓰지 않는다.
//   · 공식 어린이보호구역은 OSM 에서 만들지 않는다(지정 여부는 공식 데이터로만 말한다).
//   · 이름은 OSM name 태그에 있는 것만 담는다. 없으면 null.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./subzones.js'));
  } else {
    root.PoiData = factory(root.SubZones);
  }
}(typeof self !== 'undefined' ? self : this, function (SZ) {
  'use strict';

  const POI_DATA_VERSION = 1;
  // Overpass 한 번으로 받는 종류(공식 어린이보호구역은 없음)
  const OSM_CATEGORIES = Object.freeze(['schools', 'offices', 'commercial', 'hospitals', 'markets', 'transit', 'residential']);
  const COMMERCIAL_AMENITIES = Object.freeze(['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bank']);

  // OSM 태그 → 종류. 하나의 요소는 한 종류로만 센다(업무 빌딩 1층 가게가 업무·상업 둘 다로 부풀지 않게).
  function categoryOf(tags) {
    const t = tags || {};
    if (t.amenity === 'school') return 'schools';
    if (t.amenity === 'hospital') return 'hospitals';
    if (t.amenity === 'marketplace') return 'markets';
    if (t.railway === 'station' || t.railway === 'subway_entrance' || t.public_transport === 'station' || t.highway === 'bus_stop') return 'transit';
    if (t.landuse === 'residential' && t.residential === 'apartments') return 'residential';
    if (t.office || t.building === 'office') return 'offices';
    if (t.shop || COMMERCIAL_AMENITIES.includes(t.amenity)) return 'commercial';
    return null;
  }

  // bbox: {minLat,minLng,maxLat,maxLng}. 점 POI 는 center 로, 아파트 단지는 경계(geom)로 받는다.
  function overpassPoiQuery(bbox) {
    const b = `(${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng})`;
    return '[out:json][timeout:60];('
      + `nwr["amenity"~"^(school|hospital|marketplace)$"]${b};`
      + `nwr["railway"~"^(station|subway_entrance)$"]${b};`
      + `nwr["public_transport"="station"]${b};`
      + `node["highway"="bus_stop"]${b};`
      + `nwr["office"]${b};way["building"="office"]${b};`
      + `nwr["shop"]${b};`
      + `nwr["amenity"~"^(${COMMERCIAL_AMENITIES.join('|')})$"]${b};`
      + ')->.p;.p out center tags;'
      + `(way["landuse"="residential"]["residential"="apartments"]${b};relation["landuse"="residential"]["residential"="apartments"]${b};)->.r;.r out geom tags;`;
  }

  const finite = v => Number.isFinite(Number(v));
  const emptyPoi = () => ({ schools: [], offices: [], commercial: [], hospitals: [], markets: [], transit: [], residential: [], officialSchoolZones: [] });

  // 요소 하나의 좌표·경계 — node: lat/lon · way/relation: center 또는 geometry
  function placeOf(el) {
    if (el.type === 'node' && finite(el.lat) && finite(el.lon)) return { lat: Number(el.lat), lng: Number(el.lon) };
    let polygon = null;
    if (Array.isArray(el.geometry) && el.geometry.length >= 3) polygon = el.geometry.map(p => [Number(p.lat), Number(p.lon)]);
    else if (Array.isArray(el.members)) {
      const outer = el.members.filter(m => m.role === 'outer' && Array.isArray(m.geometry) && m.geometry.length >= 3)
        .sort((a, b) => b.geometry.length - a.geometry.length)[0];
      if (outer) polygon = outer.geometry.map(p => [Number(p.lat), Number(p.lon)]);
    }
    if (el.center && finite(el.center.lat) && finite(el.center.lon)) {
      return { lat: Number(el.center.lat), lng: Number(el.center.lon), polygon };
    }
    if (polygon) { const c = SZ.polygonCenter(polygon); return c ? { lat: c.lat, lng: c.lng, polygon } : null; }
    return null;
  }

  // Overpass 응답 → auto-subzones 가 받는 poi 모양
  function parseOverpassPoi(data, meta) {
    const m = meta || {};
    const out = emptyPoi();
    const seen = new Set();
    ((data && data.elements) || []).forEach(el => {
      const cat = categoryOf(el.tags);
      if (!cat) return;
      const id = `${el.type}/${el.id}`;
      if (seen.has(id)) return;
      seen.add(id);
      const place = placeOf(el);
      if (!place) return;
      const item = { lat: place.lat, lng: place.lng, name: (el.tags && el.tags.name) || null, osmId: id };
      if (place.polygon && cat === 'residential') item.polygon = place.polygon;
      out[cat].push(item);
    });
    return {
      ...out,
      version: POI_DATA_VERSION,
      fetchedAt: m.fetchedAt || new Date().toISOString(),
      bboxKey: m.bboxKey || null,
      sources: ['OpenStreetMap(Overpass)'],
      coveredCategories: OSM_CATEGORIES.slice(),
    };
  }

  // 누적 지도의 건물 캐시(accum.js getZoneBuildingPolygons 결과) → 아파트 단지 POI 만
  function fromBuildingCache(entry) {
    const buildings = entry && entry.buildings;
    const complexes = (buildings && buildings.explicitComplexPolygons) || [];
    if (!complexes.length) return null;
    const out = emptyPoi();
    complexes.forEach(poly => {
      if (!Array.isArray(poly) || poly.length < 3) return;
      const c = SZ.polygonCenter(poly);
      if (c) out.residential.push({ lat: c.lat, lng: c.lng, name: null, polygon: poly });
    });
    if (!out.residential.length) return null;
    return {
      ...out,
      version: POI_DATA_VERSION,
      fetchedAt: entry.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
      sources: ['누적 지도 OSM 건물 캐시(아파트 단지 경계)'],
      coveredCategories: ['residential'],
    };
  }

  // 여러 출처를 합친다 — 같은 OSM 요소·같은 좌표는 한 번만. 아무것도 없으면 null(= POI 없음)
  function mergePoi(list) {
    const parts = (list || []).filter(Boolean);
    if (!parts.length) return null;
    const out = emptyPoi();
    const keys = new Set();
    parts.forEach(p => Object.keys(out).forEach(cat => (p[cat] || []).forEach(item => {
      const k = `${cat}|${item.osmId || `${Number(item.lat).toFixed(5)},${Number(item.lng).toFixed(5)}`}`;
      if (keys.has(k)) return;
      keys.add(k);
      out[cat].push(item);
    })));
    const fetched = parts.map(p => p.fetchedAt).filter(Boolean).sort();
    return {
      ...out,
      version: POI_DATA_VERSION,
      fetchedAt: fetched.length ? fetched[fetched.length - 1] : null,
      sources: [...new Set(parts.flatMap(p => p.sources || []))],
      coveredCategories: [...new Set(parts.flatMap(p => p.coveredCategories || []))],
    };
  }

  // 구역 경계 bbox — Overpass 조회 범위
  function bboxOf(polygon, padDeg) {
    const b = SZ.polygonBounds(polygon);
    if (!b) return null;
    const pad = padDeg == null ? 0.002 : padDeg;
    return { minLat: b.minLat - pad, minLng: b.minLng - pad, maxLat: b.maxLat + pad, maxLng: b.maxLng + pad };
  }
  const bboxKey = bbox => (bbox ? [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng].map(n => Number(n).toFixed(5)).join(',') : null);

  return {
    POI_DATA_VERSION, OSM_CATEGORIES,
    categoryOf, overpassPoiQuery, parseOverpassPoi, fromBuildingCache, mergePoi, bboxOf, bboxKey,
  };
}));
