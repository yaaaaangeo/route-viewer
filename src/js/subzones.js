// ══════════════════════════════════════════════════════════
//  subzones — 세부 수집 구역(생활권·장소 유형)과 도로 구간의 단일 원천
//
//  추천이 "강남"처럼 넓은 구역만 말하면 운전자는 어디를 달려야 할지 알 수 없다.
//  그래서 공간을 세 단계로 나눈다.
//
//    1단계 상위 운영 구역   강남 · 판교 · 시흥           (기존 zones)
//    2단계 세부 수집 구역   테헤란로 업무지구 · 학교 인접 도로 (이 파일: subZone)
//    3단계 실제 추천 구간   테헤란로 <구간>              (이 파일: roadSegment)
//
//  ⚠ 장소·도로 이름을 지어내지 않는다.
//  이름은 (a) 사용자가 직접 입력했거나 (b) 지도 데이터(HD Map / OSM)에 실제로 적혀 있는 것만 쓴다.
//  근거를 못 찾으면 '확인 불가'로 두고 추천에서 그 사실을 밝힌다. 학교·IC·역 이름을 추측해서
//  만들어내면 운전자가 없는 장소를 찾아 헤매게 되고, 그 자체가 틀린 데이터가 된다.
//
//  좌표 계산(점이 구역 안인지·도로에 얼마나 가까운지)은 전부 여기에 모아서
//  SQLite(main) · IndexedDB(브라우저) · 화면 · 테스트가 같은 답을 내게 한다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./time-conditions.js'), require('./collection-stats.js'));
  } else {
    root.SubZones = factory(root.TimeConditions, root.CollectionStats);
  }
}(typeof self !== 'undefined' ? self : this, function (TC, CS) {
  'use strict';

  const SUBZONE_VERSION = 1;

  // 상위 구역에서 쓸 수 있는 HD Map 데이터(실제로 저장소에 들어 있는 것만).
  // 목록에 없는 구역은 도로 데이터가 없는 것이고, 그 사실을 추천에 그대로 적는다.
  const HDMAP_PARENT_SOURCES = Object.freeze({
    '강남': Object.freeze(['gangnam', 'seocho']),
    '서초': Object.freeze(['seocho']),
  });
  const hdmapKeysFor = parentZone => (HDMAP_PARENT_SOURCES[parentZone] || []).slice();

  // ── 장소 유형 ─────────────────────────────────────────
  // candidateTimes: 그 유형에서 "볼 만한" 교통 시간대 후보(time-conditions.js 의 id).
  //   후보일 뿐이고, 실제 추천 여부는 그 구역의 데이터 부족도가 정한다(시간 규칙만으로 추천하지 않는다).
  // expects: 그 조건에서 관찰될 "가능성"이 있는 상황 — 발생을 보장하지 않는다.
  const PLACE_TYPES = Object.freeze({
    office_district: Object.freeze({
      label: '업무지구',
      candidateTimes: ['morning_peak', 'lunch_peak', 'evening_peak'],
      weekdayTypes: ['weekday'],
      expects: ['정체', '빈번한 차선 변경', '버스 정차', '택시 승하차', '보행자 증가', '주정차', '교차로 꼬리물기', '합류·끼어들기'],
    }),
    commercial_district: Object.freeze({
      label: '상업지구',
      candidateTimes: ['lunch_peak', 'evening_peak', 'night'],
      weekdayTypes: ['weekday', 'weekend'],
      expects: ['보행자', '택시 승하차', '배달 오토바이', '불법 주정차', '골목 진출입 차량'],
    }),
    school_zone: Object.freeze({
      label: '학교 인접 도로',
      candidateTimes: ['morning_peak', 'afternoon_offpeak'],
      weekdayTypes: ['weekday'],
      // 등·하교 시각은 학교마다 다르다 — 고정값을 사실처럼 쓰지 않고 "후보"로만 제시한다
      candidateClock: Object.freeze([
        { label: '등교 후보', start: '07:30', end: '09:00' },
        { label: '하교 후보', start: '12:30', end: '16:30' },
      ]),
      expects: ['어린이 보행자', '보호자 차량', '학원 차량', '통학버스', '불법 주정차', '갑작스러운 횡단', '시야 가림', '저속 선행차량'],
      safetyNote: '어린이보호구역 제한속도와 교통법규를 지키세요. 정문 앞 정차·반복 배회처럼 보행 안전을 방해하는 주행은 권장하지 않습니다 — 정상 통과 주행으로만 수집하세요.',
    }),
    residential_complex: Object.freeze({
      label: '아파트·주거단지 진출입부',
      candidateTimes: ['morning_peak', 'evening_peak', 'afternoon_offpeak'],
      weekdayTypes: ['weekday', 'weekend'],
      expects: ['단지 진출입 차량', '보행자', '이중주차', '주정차 차량', '시야 가림', '자전거·PM'],
      note: 'Coverage 는 단지 안 도로를 제외하지만, 단지 외곽 공공도로와 진출입부는 수집 대상입니다.',
    }),
    hospital_zone: Object.freeze({
      label: '종합병원 주변',
      candidateTimes: ['morning_peak', 'morning_offpeak', 'afternoon_offpeak'],
      weekdayTypes: ['weekday', 'weekend'],
      expects: ['구급차', '승하차 정차', '보행자', '주차 대기행렬', '횡단보도 보행'],
    }),
    market_zone: Object.freeze({
      label: '전통시장 주변',
      candidateTimes: ['morning_offpeak', 'afternoon_offpeak'],
      weekdayTypes: ['weekday', 'weekend'],
      expects: ['보행자', '노상 적치물', '배달 차량', '불법 주정차', '좁은 도로 교행'],
    }),
    transit_hub: Object.freeze({
      label: '환승역·버스정류장 밀집',
      candidateTimes: ['morning_peak', 'evening_peak'],
      weekdayTypes: ['weekday'],
      expects: ['버스 정차', '택시 승하차', '보행자 급증', '차선 변경', '정류장 대기 차량'],
    }),
    expressway_mainline: Object.freeze({
      label: '도시고속도로 본선',
      candidateTimes: ['morning_peak', 'evening_peak', 'night'],
      weekdayTypes: ['weekday', 'weekend'],
      lightHints: ['sunset', 'night'],
      expects: ['고속 합류', '정체 시작·해소', '급격한 속도 변화', '차선 변경', 'Cut-in 가능성', '터널 진출입 조도 변화', '야간 Headlight Glare', '우천 물보라·차선 가시성 저하'],
    }),
    expressway_ramp: Object.freeze({
      label: '진입·진출 램프(IC·JC)',
      candidateTimes: ['morning_peak', 'evening_peak', 'afternoon_offpeak', 'night'],
      weekdayTypes: ['weekday', 'weekend'],
      lightHints: ['sunset', 'night'],
      expects: ['짧은 합류 구간', '연속 차선 변경', '진출 대기행렬', '본선과 램프의 속도 차이', '급감속', '길찾기 혼란 차량'],
    }),
    major_intersection: Object.freeze({
      label: '교차로 밀집 구간',
      candidateTimes: ['morning_peak', 'lunch_peak', 'evening_peak'],
      weekdayTypes: ['weekday'],
      expects: ['교차로 정체', '좌우회전 대기', '꼬리물기', '보행 신호 대기', '이륜차 끼어들기'],
    }),
    construction_zone: Object.freeze({
      label: '공사 구간',
      candidateTimes: ['morning_offpeak', 'afternoon_offpeak'],
      weekdayTypes: ['weekday'],
      expects: ['차로 축소', '임시 차선', '작업 차량', '유도원 수신호', '노면 불량'],
    }),
    manual_custom_zone: Object.freeze({
      label: '직접 등록한 구역',
      candidateTimes: [],
      weekdayTypes: ['weekday', 'weekend'],
      expects: [],
    }),
  });
  const PLACE_TYPE_IDS = Object.freeze(Object.keys(PLACE_TYPES));
  const placeTypeLabel = id => (PLACE_TYPES[id] || {}).label || '확인 불가';

  // ── 근거(출처) ────────────────────────────────────────
  const SOURCE_TYPES = Object.freeze(['manual', 'hdmap', 'osm']);
  const SOURCE_LABELS = Object.freeze({ manual: '직접 등록', hdmap: 'HD Map', osm: 'OpenStreetMap', gps: '주행 기록' });

  // 장소 신뢰도 — 추천 점수와는 다른 값이다. 점수가 높아도 공간 근거가 약하면 낮게 표시한다.
  const EVIDENCE_LEVELS = Object.freeze({
    high: { id: 'high', label: '높음', rank: 3 },
    medium: { id: 'medium', label: '보통', rank: 2 },
    low: { id: 'low', label: '낮음', rank: 1 },
  });

  // sources: {hdmap, osm, gps, manual} — 무엇이 실제로 있었는지
  function evidenceLevel(sources) {
    const s = sources || {};
    const map = !!s.hdmap, osm = !!s.osm, gps = !!s.gps;
    const reasons = [];
    if (map) reasons.push('HD Map 도로 구간');
    if (osm) reasons.push('OpenStreetMap 도로·시설');
    if (gps) reasons.push('실제 GPS 주행 이력');
    if (s.manual) reasons.push('사용자 직접 등록');
    let level = EVIDENCE_LEVELS.low;
    if ((map || osm) && gps && (map && osm ? true : true)) level = EVIDENCE_LEVELS.medium;
    if (map && osm && gps) level = EVIDENCE_LEVELS.high;
    if (!map && !osm) level = EVIDENCE_LEVELS.low;
    return {
      ...level,
      reasons,
      note: level.id === 'high'
        ? '지도 데이터와 실제 주행 기록이 모두 있어요.'
        : level.id === 'medium'
          ? '지도 데이터와 주행 기록 중 일부만 있어요 — 장소·도로 이름은 확인된 것만 표시합니다.'
          : '직접 등록했거나 지도 근거가 제한적이에요 — 장소 유형과 이름을 확인해 주세요.',
    };
  }

  // ── 좌표 계산 ─────────────────────────────────────────
  const R_EARTH_M = 6371000;
  const toRad = d => (d * Math.PI) / 180;

  function distanceM(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // 0=북 90=동 180=남 270=서
  function bearingDeg(lat1, lng1, lat2, lng2) {
    const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  const COMPASS = Object.freeze(['북', '북동', '동', '남동', '남', '남서', '서', '북서']);
  function compassOf(bearing) {
    if (!Number.isFinite(bearing)) return null;
    return COMPASS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
  }
  // 두 방위각의 차이(0~180)
  function angleDiff(a, b) {
    const d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  }

  function polygonBounds(polygon) {
    const pts = (polygon || []).filter(p => Array.isArray(p) && p.length >= 2);
    if (pts.length < 3) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    pts.forEach(([la, lo]) => {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLng) minLng = lo;
      if (lo > maxLng) maxLng = lo;
    });
    return { minLat, maxLat, minLng, maxLng };
  }

  function polygonCenter(polygon) {
    const b = polygonBounds(polygon);
    return b ? { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 } : null;
  }

  // ray casting — coverage-grid.js 의 구역 판정과 같은 방식
  function pointInPolygon(lat, lng, polygon) {
    const pts = polygon || [];
    if (pts.length < 3) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [yi, xi] = pts[i], [yj, xj] = pts[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // 점 → 선분 최단거리(m)와 선분 위 진행 방위
  function pointToSegment(lat, lng, [la1, lo1], [la2, lo2]) {
    const mLat = 111320, mLng = 111320 * Math.cos(toRad(lat));
    const px = (lng - lo1) * mLng, py = (lat - la1) * mLat;
    const vx = (lo2 - lo1) * mLng, vy = (la2 - la1) * mLat;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / len2)) : 0;
    const dx = px - vx * t, dy = py - vy * t;
    return { distanceM: Math.sqrt(dx * dx + dy * dy), t, bearing: bearingDeg(la1, lo1, la2, lo2) };
  }

  // ── 도로 구간(3단계) ──────────────────────────────────
  // HD Map 라인(같은 이름끼리)을 구역 안에서 이어 붙여 "추천 구간" 후보를 만든다.
  // 이름이 '-' 이거나 비어 있으면 이름을 지어내지 않고 '이름 없는 도로'로 둔다.
  const UNNAMED_ROAD = '이름 없는 도로';
  function isUsableRoadName(name) {
    const n = String(name == null ? '' : name).trim();
    return !!n && n !== '-' && n !== '_' && n.toLowerCase() !== 'null';
  }

  // lines: [{name, points:[[lat,lng],...]}] · polygon: 세부 구역 경계
  // → [{roadId, name, named, geometry, lengthM, start, end, bearing, direction, source}]
  function roadSegmentsIn(polygon, lines, options) {
    const o = options || {};
    const bounds = polygonBounds(polygon);
    if (!bounds) return [];
    const pad = 0.0009; // 약 100m — 경계에 걸친 도로도 포함
    const byName = new Map();
    (lines || []).forEach(line => {
      const pts = (line && line.points) || [];
      if (pts.length < 2) return;
      const inside = pts.filter(([la, lo]) =>
        la >= bounds.minLat - pad && la <= bounds.maxLat + pad && lo >= bounds.minLng - pad && lo <= bounds.maxLng + pad
        && (pointInPolygon(la, lo, polygon) || o.includeNear));
      if (inside.length < 2) return;
      const key = isUsableRoadName(line.name) ? String(line.name).trim() : UNNAMED_ROAD;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(pts);
    });
    const segments = [];
    byName.forEach((chunks, name) => {
      // 같은 이름의 짧은 조각들을 한 구간으로 본다. 조각을 이어 붙인 순서를 만들지 않고
      // (실제 연결성을 보장할 수 없으므로) 길이·시작/끝만 계산해서 "이 도로의 이 구역 안 구간"으로 쓴다.
      const points = chunks.flat();
      let lengthM = 0;
      chunks.forEach(pts => {
        for (let i = 1; i < pts.length; i++) lengthM += distanceM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      });
      const sorted = points.slice().sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
      const start = sorted[0], end = sorted[sorted.length - 1];
      segments.push({
        roadId: `${o.subZoneId || 'zone'}:${name}`,
        name,
        named: name !== UNNAMED_ROAD,
        chunks,
        geometry: points,
        lengthM: Math.round(lengthM),
        start: { lat: start[0], lng: start[1] },
        end: { lat: end[0], lng: end[1] },
        bearing: bearingDeg(start[0], start[1], end[0], end[1]),
        source: o.source || 'hdmap',
      });
    });
    return segments.sort((a, b) => b.lengthM - a.lengthM);
  }

  // 도로 등급 — 이름에 그렇게 적혀 있을 때만 단정한다(올림픽대로처럼 이름만으로 알 수 없으면 확인 불가)
  function roadClassOf(name, osmTags) {
    const tag = (osmTags && osmTags.highway) || '';
    if (tag === 'motorway' || tag === 'motorway_link') return { id: 'expressway', label: '고속도로·도시고속도로', source: 'osm' };
    if (tag === 'trunk' || tag === 'trunk_link') return { id: 'trunk', label: '자동차전용도로급 간선', source: 'osm' };
    if (tag) return { id: 'road', label: '일반도로', source: 'osm' };
    if (/고속도로/.test(String(name || ''))) return { id: 'expressway', label: '고속도로', source: 'name' };
    return { id: 'unknown', label: '확인 불가', source: null };
  }

  // ── 세부 구역 데이터 모델 ─────────────────────────────
  function normalizeSubZone(input, previous) {
    const prev = previous || {};
    const src = input || {};
    const errors = [];
    const name = String(src.name != null ? src.name : prev.name || '').replace(/\s+/g, ' ').trim();
    const parentZone = String(src.parentZone != null ? src.parentZone : prev.parentZone || '').trim();
    const type = src.type != null ? String(src.type) : (prev.type || 'manual_custom_zone');
    const polygon = Array.isArray(src.polygon) ? src.polygon : (prev.polygon || []);
    const cleanPolygon = polygon
      .map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
      .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    if (!name) errors.push('세부 구역 이름을 적어주세요.');
    if (name.length > 60) errors.push('세부 구역 이름은 60자까지 쓸 수 있어요.');
    if (!parentZone) errors.push('어느 상위 구역에 속하는지 골라주세요.');
    if (!PLACE_TYPE_IDS.includes(type)) errors.push('장소 유형을 목록에서 골라주세요.');
    if (cleanPolygon.length < 3) errors.push('지도에서 구역 경계를 3점 이상 그려주세요.');
    if (errors.length) return { ok: false, errors, value: null };
    const now = new Date().toISOString();
    const sourceType = SOURCE_TYPES.includes(src.sourceType) ? src.sourceType : (prev.sourceType || 'manual');
    return {
      ok: true,
      errors: [],
      value: {
        id: prev.id || src.id || slugId(parentZone, name),
        parentZone, name, type,
        polygon: cleanPolygon,
        center: polygonCenter(cleanPolygon),
        note: String(src.note != null ? src.note : prev.note || '').slice(0, 300),
        // 어떤 근거로 만든 구역인지 — 자동 탐지와 직접 등록을 화면에서 구분한다
        sourceType,
        sourceIdentifiers: Array.isArray(src.sourceIdentifiers) ? src.sourceIdentifiers.map(String).slice(0, 50)
          : (prev.sourceIdentifiers || []),
        verifiedAt: src.verifiedAt || prev.verifiedAt || (sourceType === 'manual' ? now : null),
        // 사용자가 특히 보고 싶은 시간대(없으면 장소 유형의 후보 시간을 쓴다)
        interestPeriods: Array.isArray(src.interestPeriods) ? src.interestPeriods.map(String)
          : (prev.interestPeriods || []),
        active: src.active === undefined ? (prev.active === undefined ? true : !!prev.active) : !!src.active,
        createdAt: prev.createdAt || now,
        updatedAt: now,
      },
    };
  }

  // id 는 화면에 보이지 않는 식별자다. 한글 이름을 그대로 쓰되 공백만 정리한다(이름을 지어내지 않는다).
  function slugId(parentZone, name) {
    const base = `${parentZone}-${name}`.replace(/\s+/g, '-').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎ가-힣\-_.]/g, '');
    return `${base || 'subzone'}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // 그 세부 구역에서 "볼 만한" 교통 시간대 — 사용자가 고른 게 있으면 그걸 먼저
  function candidatePeriods(subZone) {
    const chosen = (subZone && subZone.interestPeriods) || [];
    if (chosen.length) return chosen.slice();
    const type = PLACE_TYPES[(subZone && subZone.type) || ''];
    return type ? type.candidateTimes.slice() : [];
  }

  function expectedSituations(subZone) {
    const type = PLACE_TYPES[(subZone && subZone.type) || ''];
    return type ? type.expects.slice() : [];
  }

  function safetyNote(subZone) {
    const type = PLACE_TYPES[(subZone && subZone.type) || ''];
    return (type && type.safetyNote) || null;
  }

  // ── 격자 색인 — 기록마다 가장 가까운 도로를 빨리 찾기 위한 것 ──
  // 평행한 옆 도로에 잘못 붙지 않도록, 일정 거리(기본 25m) 안에 있는 선분만 후보로 본다.
  const MATCH_CELL_DEG = 0.002;      // 약 200m
  const DEFAULT_MATCH_DISTANCE_M = 25;

  function buildRoadIndex(segments) {
    const cells = new Map();
    (segments || []).forEach(seg => {
      (seg.chunks || [seg.geometry]).forEach(pts => {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const key = `${Math.floor(((a[0] + b[0]) / 2) / MATCH_CELL_DEG)}_${Math.floor(((a[1] + b[1]) / 2) / MATCH_CELL_DEG)}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push({ seg, a, b });
        }
      });
    });
    return { cells };
  }

  // lat/lng 와 진행 방위(heading) 를 받아 가장 가까운 도로 구간과 방향을 판정한다.
  // 거리 기준을 넘으면 null — 붙일 수 없으면 붙이지 않는다(잘못된 도로에 붙이는 것보다 낫다).
  function matchToRoad(index, lat, lng, heading, options) {
    const o = options || {};
    const maxDist = o.maxDistanceM || DEFAULT_MATCH_DISTANCE_M;
    let best = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${Math.floor(lat / MATCH_CELL_DEG) + dy}_${Math.floor(lng / MATCH_CELL_DEG) + dx}`;
        const list = index.cells.get(key);
        if (!list) continue;
        list.forEach(({ seg, a, b }) => {
          const r = pointToSegment(lat, lng, a, b);
          if (r.distanceM > maxDist) return;
          if (!best || r.distanceM < best.distanceM) best = { seg, distanceM: r.distanceM, bearing: r.bearing };
        });
      }
    }
    if (!best) return null;
    let direction = null;
    if (Number.isFinite(heading)) {
      const diff = angleDiff(heading, best.bearing);
      // 도로와 60도 이상 어긋난 진행은 그 도로를 달린 것으로 보지 않는다(교차로 통과·평행도로)
      if (diff <= 60) direction = 'forward';
      else if (diff >= 120) direction = 'backward';
    }
    return { roadId: best.seg.roadId, name: best.seg.name, distanceM: best.distanceM, segBearing: best.bearing, direction };
  }

  // 방향별 수집량이 믿을 만한지 — 표본이 적거나 한쪽만 있으면 "확인 불가"로 둔다
  const DIRECTION_MIN_SAMPLES = 20;
  const DIRECTION_MIN_RATIO = 0.1;
  // 정체·정차 구간에서는 앞 기록과 3m 도 안 움직여서 진행 방위를 못 구하는 점이 많다.
  // 그래서 "방위를 구한 표본"이 충분한지로 판단하고, 부족하면 방향을 단정하지 않는다(양방향 표시).
  function directionConfidence(forwardSamples, backwardSamples, noHeadingSamples) {
    const directional = (forwardSamples || 0) + (backwardSamples || 0);
    const total = directional + (noHeadingSamples || 0);
    if (directional < DIRECTION_MIN_SAMPLES || (total && directional / total < DIRECTION_MIN_RATIO)) {
      return {
        ok: false, label: '확인 불가',
        reason: `진행 방향을 구한 기록이 적어요(${directional}건 / 이 도로에 맞춘 ${total}건) — 방향별 부족 여부는 확인할 수 없어 양방향으로 봅니다.`,
      };
    }
    return {
      ok: true, label: '확인됨',
      reason: `진행 방향을 구한 기록 ${directional}건으로 방향을 나눴어요(도로에서 60도 넘게 벗어난 진행은 그 도로 주행으로 세지 않습니다).`,
    };
  }

  // ══════════════════════════════════════════════════════
  //  세부 구역 집계 — "이 구역의 이 조건이 얼마나 모였나"
  //
  //  rows: 그 구역 bbox 안 기록을 (차량, 시각) 순으로 정렬한 것.
  //        {date, time, vehicle, weather, speed, lat, lng, issueMask}
  //  같은 규칙을 SQLite(main) 와 IndexedDB(브라우저) 가 함께 쓴다 — 두 저장소 결과가 같아야 한다.
  //
  //  수집 시간은 날짜 요약과 같은 규칙(차량별 90초 넘는 간격은 빼는 유효 수집 시간)이고,
  //  방문 횟수는 (날짜 × 차량) 수다. 방향은 앞 기록에서 지금 기록으로의 진행 방위를 도로에 맞춰 센다.
  // ══════════════════════════════════════════════════════
  function aggregateSubZone(subZone, rows, options) {
    const o = options || {};
    const cfg = o.classification || TC.classificationConfig({});
    const polygon = (subZone && subZone.polygon) || [];
    const segments = o.roadSegments || [];
    const index = segments.length ? buildRoadIndex(segments) : null;
    const maxDist = o.matchDistanceM || DEFAULT_MATCH_DISTANCE_M;

    const conditions = new Map();     // 조건 키 → 집계
    const roads = new Map();          // roadId → 방향별 집계
    const vehicles = new Map();
    const dates = new Set();
    const visits = new Set();
    let recordCount = 0, collectionSec = 0, lastVisitedAt = null;
    let matchedPoints = 0, unmatchedPoints = 0;
    const issueCounts = { total: 0, issue: 0 };

    // 같은 차량의 직전 기록 — 간격(수집 시간)과 진행 방위(방향)를 구하는 데 쓴다
    const prevByVehicle = new Map();

    (rows || []).forEach(r => {
      if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return;
      if (!pointInPolygon(r.lat, r.lng, polygon)) return;
      recordCount++;
      dates.add(r.date);
      visits.add(`${r.date}|${r.vehicle || ''}`);
      vehicles.set(r.vehicle || '', (vehicles.get(r.vehicle || '') || 0) + 1);
      issueCounts.total++;
      if ((Number(r.issueMask) || 0) & (2 | 4)) issueCounts.issue++;

      const cls = TC.classifyRecord(r, cfg);
      const key = [cls.weekdayType, cls.trafficPeriod, cls.lightCondition || 'any', r.weather || ''].join('|');
      let acc = conditions.get(key);
      if (!acc) {
        acc = {
          weekdayType: cls.weekdayType, trafficPeriod: cls.trafficPeriod,
          lightCondition: cls.lightCondition || null, weather: r.weather || '',
          recordCount: 0, collectionSec: 0, visits: new Set(), dates: new Set(), lastVisitedAt: null,
        };
        conditions.set(key, acc);
      }
      acc.recordCount++;
      acc.visits.add(`${r.date}|${r.vehicle || ''}`);
      acc.dates.add(r.date);

      const prev = prevByVehicle.get(r.vehicle || '');
      let heading = null;
      if (prev && prev.date === r.date) {
        const dt = CS.timeToSec(r.time) - CS.timeToSec(prev.time);
        if (dt > 0 && dt <= CS.COLLECTION_GAP_SEC) {
          collectionSec += dt;
          acc.collectionSec += dt;
        }
        if (distanceM(prev.lat, prev.lng, r.lat, r.lng) >= 3) {
          heading = bearingDeg(prev.lat, prev.lng, r.lat, r.lng);
        }
      }

      if (index) {
        const m = matchToRoad(index, r.lat, r.lng, heading, { maxDistanceM: maxDist });
        if (m) {
          matchedPoints++;
          let road = roads.get(m.roadId);
          if (!road) {
            const seg = segments.find(s => s.roadId === m.roadId);
            road = {
              roadId: m.roadId, name: m.name, named: !!(seg && seg.named),
              lengthM: seg ? seg.lengthM : null, bearing: seg ? seg.bearing : null,
              start: seg ? seg.start : null, end: seg ? seg.end : null,
              recordCount: 0, forward: 0, backward: 0, unknownDirection: 0,
              collectionSec: 0, conditions: new Map(), lastVisitedAt: null,
            };
            roads.set(m.roadId, road);
          }
          road.recordCount++;
          if (m.direction === 'forward') road.forward++;
          else if (m.direction === 'backward') road.backward++;
          else road.unknownDirection++;
          const rk = [cls.weekdayType, cls.trafficPeriod, cls.lightCondition || 'any'].join('|');
          const rc = road.conditions.get(rk) || { weekdayType: cls.weekdayType, trafficPeriod: cls.trafficPeriod, lightCondition: cls.lightCondition || null, recordCount: 0, forward: 0, backward: 0 };
          rc.recordCount++;
          if (m.direction === 'forward') rc.forward++;
          else if (m.direction === 'backward') rc.backward++;
          road.conditions.set(rk, rc);
          if (!road.lastVisitedAt || `${r.date}T${r.time}` > road.lastVisitedAt) road.lastVisitedAt = `${r.date}T${r.time}`;
        } else {
          unmatchedPoints++;
        }
      }

      const stamp = `${r.date}T${r.time || '00:00:00'}+09:00`;
      if (!lastVisitedAt || stamp > lastVisitedAt) lastVisitedAt = stamp;
      if (!acc.lastVisitedAt || stamp > acc.lastVisitedAt) acc.lastVisitedAt = stamp;
      prevByVehicle.set(r.vehicle || '', r);
    });

    const conditionList = [...conditions.values()].map(c => ({
      weekdayType: c.weekdayType, trafficPeriod: c.trafficPeriod, lightCondition: c.lightCondition, weather: c.weather,
      recordCount: c.recordCount, collectionSec: c.collectionSec,
      collectionMinutes: Math.round(c.collectionSec / 60),
      visitCount: c.visits.size, uniqueDays: c.dates.size, lastVisitedAt: c.lastVisitedAt,
    })).sort((a, b) => b.collectionSec - a.collectionSec);

    const roadList = [...roads.values()].map(r => ({
      roadId: r.roadId, name: r.name, named: r.named, lengthM: r.lengthM, bearing: r.bearing,
      start: r.start, end: r.end, recordCount: r.recordCount,
      forward: r.forward, backward: r.backward, unknownDirection: r.unknownDirection,
      direction: directionConfidence(r.forward, r.backward, r.unknownDirection),
      lastVisitedAt: r.lastVisitedAt,
      conditions: [...r.conditions.values()].sort((a, b) => b.recordCount - a.recordCount),
    })).sort((a, b) => b.recordCount - a.recordCount);

    return {
      id: subZone.id,
      recordCount, collectionSec, collectionMinutes: Math.round(collectionSec / 60),
      uniqueDays: dates.size, visitCount: visits.size, lastVisitedAt,
      vehicles: [...vehicles.entries()].sort((a, b) => b[1] - a[1]),
      issueRecordCount: issueCounts.issue,
      conditions: conditionList,
      roads: roadList,
      match: {
        matchedPoints, unmatchedPoints,
        segments: segments.length,
        note: segments.length
          ? `${maxDist}m 안의 도로에만 맞췄어요(맞춘 기록 ${matchedPoints}건 · 못 맞춘 기록 ${unmatchedPoints}건).`
          : '도로 데이터가 없어 구간·방향은 계산하지 않았어요.',
      },
    };
  }

  return {
    SUBZONE_VERSION,
    HDMAP_PARENT_SOURCES, hdmapKeysFor,
    aggregateSubZone,
    PLACE_TYPES, PLACE_TYPE_IDS, placeTypeLabel,
    SOURCE_TYPES, SOURCE_LABELS, EVIDENCE_LEVELS, evidenceLevel,
    UNNAMED_ROAD, isUsableRoadName, roadClassOf,
    distanceM, bearingDeg, compassOf, angleDiff,
    polygonBounds, polygonCenter, pointInPolygon, pointToSegment,
    roadSegmentsIn, normalizeSubZone, candidatePeriods, expectedSituations, safetyNote,
    buildRoadIndex, matchToRoad, directionConfidence,
    DEFAULT_MATCH_DISTANCE_M, DIRECTION_MIN_SAMPLES,
  };
}));
