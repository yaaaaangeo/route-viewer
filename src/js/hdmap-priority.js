// ══════════════════════════════════════════════════════════
//  hdmap-priority — 2차년도 HD Map 우선 구축 구역 ①~⑫ 와 그 비교 통계
//
//  왜 따로 있나
//    상위 운영 구역(zone = '강남')은 건드리지 않는다. ①~⑫ 는 그 안을 다시 나눈
//    "HD Map 구축 우선순위" 개념이라, 기존 zone·subZone 과 섞지 않고 여기에만 둔다.
//    ①~⑫ 는 사용자가 등록하는 세부 구역(subZones 테이블)이 아니라 사업에서 정해진
//    고정 목록이므로 DB 에 저장하지 않고 데이터 파일(src/data/hdmap-priority-areas.json)로 갖는다.
//
//  우선순위 (사업에서 정해진 값 — 여기서 추측하지 않는다)
//    최우선 primary   ⑤
//    우선   priority  ① ② ⑥ ⑨ ⑩
//    일반   normal    ③ ④ ⑦ ⑧ ⑪ ⑫
//
//  ⚠ 경계(polygon) 는 협의체 자료에 없다 — 사용자가 직접 그린다.
//    자료 폴더의 폴리곤 레이어는 강남구 8개·서초구 3개 '법정동' 경계뿐이고(나머지는 도로 선·노드 점),
//    QGIS 프로젝트에도 ①~⑫ 레이어가 없다. 지도 이미지의 숫자 위치를 보고 위경도를 지어내면
//    그 위에 올라가는 숫자가 전부 거짓이 되므로 추측하지 않는다.
//    대신 앱에서 직접 그려 저장한 경계(savedPolygons)를 파일 정의 위에 덮어쓴다.
//    경계가 없는 구역은 집계에서 빼고 "경계 미설정"으로만 표시한다.
//
//  집계는 여기서 새로 만들지 않는다.
//    구역별 수집량은 subzones.js 의 aggregateSubZone() 이 계산한 결과를 그대로 받는다
//    (SQLite·IndexedDB 가 같은 함수를 쓰므로 두 저장소 결과가 같다).
//    이 파일이 하는 일은 (a) 구역 목록을 읽고 (b) 그 집계를 우선/일반으로 갈라 비교하는 것뿐이다.
//
//  대표 지표는 "유효 수집 시간"이다 — GPS 점 개수로 "몇 번 수집"이라고 말하지 않는다.
//    수집 시간(collectionMinutes) > 방문 횟수(visitCount) > 수집 세션(sessionCount)
//    > 수집 일수(uniqueDays) > 기록 수(recordCount) 순으로 본다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./subzones.js'), () => require('../data/hdmap-priority-areas.json'));
  } else {
    // 경계 데이터(<script src="data/hdmap-priority-areas.js">)가 이 파일보다 늦게 올라와도
    // 되도록 함수로 넘긴다 — 읽는 시점은 화면을 그릴 때다.
    root.HDMapPriority = factory(root.SubZones, () => root.HDMAP_PRIORITY_AREAS);
  }
}(typeof self !== 'undefined' ? self : this, function (SZ, defaultData) {
  'use strict';

  const HDMAP_PRIORITY_VERSION = 1;

  const PRIMARY_AREA_NO = 5;
  const PRIORITY_AREA_NOS = Object.freeze([1, 2, 5, 6, 9, 10]);   // 최우선 ⑤ 포함
  const NORMAL_AREA_NOS = Object.freeze([3, 4, 7, 8, 11, 12]);    // 비교군
  const ALL_AREA_NOS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // 색만으로 뜻을 전하지 않는다 — 화면에는 언제나 이 라벨(글자)을 함께 쓴다.
  const PRIORITY_LEVELS = Object.freeze({
    primary: Object.freeze({ id: 'primary', label: '최우선', rank: 3, note: '2차년도 HD Map 우선 구축 구역' }),
    priority: Object.freeze({ id: 'priority', label: '우선', rank: 2, note: '데이터 수집 우선 대상' }),
    normal: Object.freeze({ id: 'normal', label: '일반', rank: 1, note: '비교군' }),
  });
  const priorityLabel = id => (PRIORITY_LEVELS[id] || {}).label || '확인 불가';

  // 우선순위는 사업에서 정한 값이다. 데이터 파일이 다른 값을 들고 있으면 그건 오류이므로
  // 파일 값을 믿지 않고 여기 정의를 기준으로 삼는다(그리고 validateAreas 가 어긋남을 알린다).
  function priorityOf(areaNo) {
    const n = Number(areaNo);
    if (n === PRIMARY_AREA_NO) return 'primary';
    if (PRIORITY_AREA_NOS.includes(n)) return 'priority';
    if (NORMAL_AREA_NOS.includes(n)) return 'normal';
    return null;
  }

  // 왜 못 세는지를 "—" 하나로 뭉뚱그리지 않는다 — 원인마다 할 일이 다르기 때문이다.
  //   no_polygon : 경계를 그려야 한다            no_data : 그 구역을 달려야 한다
  //   error      : 집계가 실패했다(다시 계산)     ok      : 정상
  const AREA_STATES = Object.freeze({
    ok: Object.freeze({ id: 'ok', label: '집계됨' }),
    no_polygon: Object.freeze({ id: 'no_polygon', label: '경계 미설정' }),
    no_data: Object.freeze({ id: 'no_data', label: '경계 안 기록 0건' }),
    error: Object.freeze({ id: 'error', label: '계산 실패' }),
  });
  const areaStateLabel = id => (AREA_STATES[id] || {}).label || '확인 불가';

  const isPriorityArea = areaNo => PRIORITY_AREA_NOS.includes(Number(areaNo));
  const isNormalArea = areaNo => NORMAL_AREA_NOS.includes(Number(areaNo));

  // ── 구역 목록 읽기 ───────────────────────────────────
  // GeoJSON 은 [경도, 위도] 순서, subzones.js 는 [위도, 경도] 순서를 쓴다 — 여기서 한 번만 뒤집는다.
  function ringToPolygon(ring) {
    const pts = (ring || [])
      .map(p => (Array.isArray(p) && p.length >= 2 ? [Number(p[1]), Number(p[0])] : null))
      .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    // GeoJSON 링은 첫 점과 끝 점이 같다 — 판정에는 중복이 필요 없으니 닫는 점만 뺀다
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) pts.pop();
    }
    return pts;
  }

  // Polygon 과 MultiPolygon 만 받는다. MultiPolygon 은 가장 점이 많은 바깥 링 하나만 쓴다
  // (aggregateSubZone 의 경계 판정이 단일 링만 다루기 때문) — 그 사실은 warning 으로 남긴다.
  function geometryToPolygon(geometry) {
    if (!geometry || !geometry.type) return { polygon: [], warning: null };
    if (geometry.type === 'Polygon') {
      const rings = geometry.coordinates || [];
      return {
        polygon: ringToPolygon(rings[0]),
        warning: rings.length > 1 ? '구멍(내부 링)이 있는 경계는 바깥 링만 씁니다.' : null,
      };
    }
    if (geometry.type === 'MultiPolygon') {
      const outers = (geometry.coordinates || []).map(p => ringToPolygon((p || [])[0]));
      const best = outers.slice().sort((a, b) => b.length - a.length)[0] || [];
      return {
        polygon: best,
        warning: outers.length > 1 ? `조각이 ${outers.length}개인 경계라 가장 큰 조각만 씁니다.` : null,
      };
    }
    return { polygon: [], warning: `지원하지 않는 geometry 형식이에요(${geometry.type}).` };
  }

  // featureCollection → [{id, areaNo, name, parentZone, priority, priorityLabel, polygon, hasPolygon, center, warning}]
  // 언제나 ①~⑫ 열두 칸을 모두 돌려준다 — 파일에 없는 번호도 "경계 미설정"으로 자리를 채운다.
  function parseAreas(featureCollection) {
    const fc = featureCollection || {};
    const byNo = new Map();
    (fc.features || []).forEach(f => {
      const props = (f && f.properties) || {};
      const areaNo = Number(props.areaNo);
      if (!ALL_AREA_NOS.includes(areaNo)) return;
      const { polygon, warning } = geometryToPolygon(f.geometry);
      byNo.set(areaNo, {
        id: String((f && f.id) || props.id || `hdmap_${String(areaNo).padStart(2, '0')}`),
        areaNo,
        name: String(props.name || `${areaNo}`),
        parentZone: String(props.parentZone || '강남'),
        declaredPriority: props.priority ? String(props.priority) : null,
        polygon,
        warning: polygon.length >= 3 ? warning : null,
      });
    });
    return ALL_AREA_NOS.map(areaNo => {
      const found = byNo.get(areaNo) || {
        id: `hdmap_${String(areaNo).padStart(2, '0')}`,
        areaNo, name: String(areaNo), parentZone: '강남', declaredPriority: null, polygon: [], warning: null,
      };
      const priority = priorityOf(areaNo);
      const hasPolygon = found.polygon.length >= 3;
      return {
        id: found.id,
        areaNo,
        name: found.name,
        parentZone: found.parentZone,
        priority,
        priorityLabel: priorityLabel(priority),
        polygon: found.polygon,
        hasPolygon,
        center: hasPolygon ? SZ.polygonCenter(found.polygon) : null,
        declaredPriority: found.declaredPriority,
        warning: found.warning,
      };
    });
  }

  // ── 앱에서 직접 그린 경계 ─────────────────────────────
  //  화면(Leaflet)·SQLite·IndexedDB 가 같은 규칙으로 받아들이도록 검증을 여기 한 곳에 둔다.
  //  좌표는 언제나 WGS84 [위도, 경도] — 실제 GPS 기록과 바로 비교할 수 있어야 한다.
  function normalizeAreaPolygon(areaNo, polygon) {
    const no = Number(areaNo);
    const errors = [];
    if (!ALL_AREA_NOS.includes(no)) errors.push('①~⑫ 중 하나를 골라주세요.');
    const pts = (Array.isArray(polygon) ? polygon : [])
      .map(p => (Array.isArray(p) && p.length >= 2 ? [Number(p[0]), Number(p[1])] : null))
      .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    // 같은 자리를 연달아 찍은 점은 경계 모양을 바꾸지 않는다 — 정리해서 저장한다
    const clean = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    if (clean.length > 1) {
      const a = clean[0], b = clean[clean.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) clean.pop();   // 닫는 점은 판정에 필요 없다
    }
    if (clean.length < 3) errors.push('꼭짓점을 3개 이상 찍어야 구역이 돼요.');
    if (clean.length > 2000) errors.push('꼭짓점이 너무 많아요(2000개까지).');
    if (errors.length) return { ok: false, errors, value: null };
    return { ok: true, errors: [], value: { areaNo: no, polygon: clean, updatedAt: new Date().toISOString() } };
  }

  // 저장된 경계 묶음 {areaNo: {polygon, updatedAt}} 을 쓸 수 있는 모양으로 — 깨진 값은 버린다
  function normalizeSavedPolygons(saved) {
    const out = {};
    Object.keys(saved || {}).forEach(key => {
      const entry = (saved || {})[key];
      const pts = Array.isArray(entry) ? entry : (entry && entry.polygon);
      const v = normalizeAreaPolygon(key, pts);
      if (v.ok) out[v.value.areaNo] = { polygon: v.value.polygon, updatedAt: (entry && entry.updatedAt) || null };
    });
    return out;
  }

  // 파일 정의(고정 목록) 위에 앱에서 직접 그린 경계를 덮어쓴다.
  // savedPolygons: RouteDB.getHDMapPriorityPolygons() 가 준 {areaNo: {polygon, updatedAt}}
  function listAreas(featureCollection, savedPolygons) {
    const areas = parseAreas(featureCollection || (typeof defaultData === 'function' ? defaultData() : null) || {});
    const saved = normalizeSavedPolygons(savedPolygons);
    return areas.map(a => {
      const own = saved[a.areaNo];
      if (!own) return { ...a, polygonSource: a.hasPolygon ? 'file' : null, polygonUpdatedAt: null };
      return {
        ...a,
        polygon: own.polygon,
        hasPolygon: true,
        center: SZ.polygonCenter(own.polygon),
        polygonSource: 'drawn',
        polygonUpdatedAt: own.updatedAt,
        warning: null,
      };
    });
  }

  // ── 구역 데이터 점검 ─────────────────────────────────
  //  경계가 겹치면 한 기록이 두 구역에 모두 들어간다(각 구역을 서로 독립으로 판정하므로).
  //  그건 합계·비중을 부풀리므로 숫자를 보여주기 전에 알려야 한다.
  //  겹침을 정확히 계산하려면 폴리곤 교차가 필요한데, 여기서는 (a) bbox 가 겹치는지,
  //  (b) 한쪽 꼭짓점이 다른 쪽 안에 있는지만 본다 — "겹칠 수 있음"과 "겹침 확인됨"을 나눠 말한다.
  function validateAreas(areas) {
    const list = areas || [];
    const missingPolygon = list.filter(a => !a.hasPolygon).map(a => a.areaNo);
    const errors = [];
    const warnings = [];

    list.forEach(a => {
      if (a.declaredPriority && a.priority && a.declaredPriority !== a.priority) {
        errors.push(`${a.name} 의 데이터 파일 우선순위(${a.declaredPriority})가 사업 정의(${a.priority})와 달라요 — 사업 정의를 씁니다.`);
      }
      if (a.warning) warnings.push(`${a.name}: ${a.warning}`);
    });

    const overlaps = [];
    const withPolygon = list.filter(a => a.hasPolygon);
    for (let i = 0; i < withPolygon.length; i++) {
      for (let j = i + 1; j < withPolygon.length; j++) {
        const a = withPolygon[i], b = withPolygon[j];
        const ba = SZ.polygonBounds(a.polygon), bb = SZ.polygonBounds(b.polygon);
        if (!ba || !bb) continue;
        if (ba.maxLat < bb.minLat || bb.maxLat < ba.minLat || ba.maxLng < bb.minLng || bb.maxLng < ba.minLng) continue;
        const shared = a.polygon.some(([la, lo]) => SZ.pointInPolygon(la, lo, b.polygon))
          || b.polygon.some(([la, lo]) => SZ.pointInPolygon(la, lo, a.polygon));
        overlaps.push({ a: a.areaNo, b: b.areaNo, confirmed: shared });
      }
    }
    const confirmed = overlaps.filter(o => o.confirmed);
    if (confirmed.length) {
      warnings.push(`경계가 겹치는 구역이 있어요(${confirmed.map(o => `${o.a}↔${o.b}`).join(', ')}) — 겹친 자리의 기록은 두 구역에 모두 들어가서 합계와 비중이 실제보다 커질 수 있어요.`);
    }

    return {
      ok: errors.length === 0,
      ready: withPolygon.length > 0,
      allReady: missingPolygon.length === 0,
      areaCount: list.length,
      readyCount: withPolygon.length,
      missingPolygon,
      overlaps,
      errors,
      warnings,
    };
  }

  // 경계가 있는 구역만 골라 subzones.js 가 아는 모양으로 바꾼다.
  // getSubZoneStats(list, ...) 는 넘긴 목록을 그대로 쓰므로(DB 에 등록할 필요가 없다)
  // ①~⑫ 를 DB 에 저장하지 않고도 같은 집계 함수를 그대로 재사용할 수 있다.
  function toSubZoneInputs(areas) {
    return (areas || []).filter(a => a.hasPolygon).map(a => ({
      id: a.id,
      name: a.name,
      parentZone: a.parentZone,
      type: 'manual_custom_zone',
      polygon: a.polygon,
      center: a.center,
      active: true,
    }));
  }

  // ── 비교 통계 ────────────────────────────────────────
  const round1 = n => Math.round(n * 10) / 10;

  // 일반지역 평균 — ③④⑦⑧⑪⑫ 중 "경계가 있는" 구역의 수집 분 평균.
  // 경계가 없는 구역을 0분으로 넣으면 평균이 가짜로 낮아지므로 아예 뺀다.
  function normalAverage(rows) {
    const basis = (rows || []).filter(r => isNormalArea(r.areaNo) && r.hasPolygon && r.state !== 'error');
    const minutes = basis.reduce((sum, r) => sum + r.collectionMinutes, 0);
    return {
      avgMinutes: basis.length ? minutes / basis.length : 0,
      totalMinutes: minutes,
      areaCount: basis.length,
      areaNos: basis.map(r => r.areaNo),
      excludedAreaNos: NORMAL_AREA_NOS.filter(n => !basis.some(r => r.areaNo === n)),
    };
  }

  // 일반지역 평균 대비 — 평균이 0이면 나눌 수 없다(0으로 나누면 Infinity/NaN 이 화면에 뜬다).
  // 그때는 비율·퍼센트를 null 로 두고 왜 못 냈는지 이유를 함께 준다.
  function compareToAverage(minutes, avgMinutes) {
    const m = Number.isFinite(minutes) ? minutes : 0;
    if (!Number.isFinite(avgMinutes) || avgMinutes <= 0) {
      return {
        diffVsNormalAvgMinutes: Math.round(m),
        ratioVsNormalAvg: null,
        percentVsNormalAvg: null,
        comparable: false,
        note: '일반지역 평균이 0분이라 배수·퍼센트를 계산할 수 없어요(0으로 나눌 수 없음).',
      };
    }
    return {
      diffVsNormalAvgMinutes: Math.round(m - avgMinutes),
      ratioVsNormalAvg: round1((m / avgMinutes) * 100) / 100,
      percentVsNormalAvg: round1(((m - avgMinutes) / avgMinutes) * 100),
      comparable: true,
      note: null,
    };
  }

  // stats: getSubZoneStats 가 돌려준 배열(aggregateSubZone 결과). id 로 구역과 맞춘다.
  function statsById(stats) {
    const map = new Map();
    (stats || []).forEach(s => { if (s && s.id != null) map.set(String(s.id), s); });
    return map;
  }

  // areas + stats → 구역별 행 + 요약. 화면은 이 결과만 그린다(여기서 계산을 끝낸다).
  function buildComparison(input) {
    const o = input || {};
    const areas = o.areas || listAreas();
    const byId = statsById(o.stats);
    const failed = !!o.error;   // 집계 자체가 실패했으면 0분이 아니라 '계산 실패'다

    const rows = areas.map(a => {
      const s = a.hasPolygon && !failed ? byId.get(String(a.id)) : null;
      const collectionSec = s && Number.isFinite(s.collectionSec) ? s.collectionSec : 0;
      const collectionMinutes = s && Number.isFinite(s.collectionMinutes) ? s.collectionMinutes : 0;
      // 왜 숫자가 없는지를 구분해서 들고 다닌다(화면이 "—" 하나로 합치지 않도록)
      const state = !a.hasPolygon ? 'no_polygon'
        : failed ? 'error'
          : (s && s.recordCount > 0) ? 'ok' : 'no_data';
      return {
        id: a.id,
        state,
        stateLabel: areaStateLabel(state),
        polygonSource: a.polygonSource || null,
        polygonUpdatedAt: a.polygonUpdatedAt || null,
        polygonPoints: a.hasPolygon ? a.polygon.length : 0,
        areaNo: a.areaNo,
        name: a.name,
        parentZone: a.parentZone,
        priority: a.priority,
        priorityLabel: a.priorityLabel,
        hasPolygon: a.hasPolygon,
        // 집계는 돌았는데 기록이 하나도 없는 것과, 경계가 없어 아예 못 센 것은 다르다
        measured: !!s,
        hasData: state === 'ok',
        collectionSec,
        collectionMinutes,
        visitCount: s ? (s.visitCount || 0) : 0,
        sessionCount: s ? (s.sessionCount || 0) : 0,
        uniqueDays: s ? (s.uniqueDays || 0) : 0,
        recordCount: s ? (s.recordCount || 0) : 0,
        lastVisitedAt: s ? (s.lastVisitedAt || null) : null,
        // Coverage 는 도로 데이터를 함께 넘겼을 때만 나온다 — 없으면 0% 가 아니라 null
        coveragePct: s && s.coverage ? s.coverage.percent : null,
        coverage: s ? (s.coverage || null) : null,
      };
    });

    const normal = normalAverage(rows);
    rows.forEach(r => {
      const cmp = (r.hasPolygon && r.state !== 'error')
        ? compareToAverage(r.collectionMinutes, normal.avgMinutes)
        : {
          diffVsNormalAvgMinutes: null, ratioVsNormalAvg: null, percentVsNormalAvg: null,
          comparable: false,
          note: r.state === 'error' ? '집계가 실패해서 비교할 수 없어요.' : '경계(polygon)가 없어 집계하지 않았어요.',
        };
      Object.assign(r, cmp);
    });

    const measured = rows.filter(r => r.hasPolygon && r.state !== 'error');
    const priorityRows = measured.filter(r => isPriorityArea(r.areaNo));
    const normalRows = measured.filter(r => isNormalArea(r.areaNo));
    const sum = list => list.reduce((acc, r) => acc + r.collectionMinutes, 0);

    const priorityTotalMinutes = sum(priorityRows);
    const normalTotalMinutes = sum(normalRows);
    const allAreaMinutes = priorityTotalMinutes + normalTotalMinutes;
    const priorityAvgMinutes = priorityRows.length ? priorityTotalMinutes / priorityRows.length : 0;

    // 우선지역 중 가장 부족한 곳 — 수집 분이 가장 적은 구역(같으면 번호가 작은 쪽).
    // 경계가 없는 구역은 "적다"고 말할 수 없으니 후보에서 뺀다.
    const weakestPriority = priorityRows.length
      ? priorityRows.slice().sort((a, b) => a.collectionMinutes - b.collectionMinutes || a.areaNo - b.areaNo)[0]
      : null;

    const primary = rows.find(r => r.areaNo === PRIMARY_AREA_NO) || null;
    const validation = validateAreas(areas);

    return {
      version: HDMAP_PRIORITY_VERSION,
      rows,
      validation,
      summary: {
        ready: validation.ready,
        allReady: validation.allReady,
        primary,
        normalAvgMinutes: round1(normal.avgMinutes),
        normalAvgBasis: normal,
        priorityAvgMinutes: round1(priorityAvgMinutes),
        priorityAreaCount: priorityRows.length,
        normalAreaCount: normalRows.length,
        priorityTotalMinutes,
        normalTotalMinutes,
        allAreaMinutes,
        // 전체 ①~⑫ 수집 시간 중 우선지역 몫. 분모가 0이면 비중을 말할 수 없다.
        prioritySharePercent: allAreaMinutes > 0 ? round1((priorityTotalMinutes / allAreaMinutes) * 100) : null,
        // 우선 평균이 일반 평균보다 몇 % 많은가(질문 3의 답)
        priorityVsNormal: compareToAverage(priorityAvgMinutes, normal.avgMinutes),
        weakestPriority,
        missingPolygonAreaNos: validation.missingPolygon,
        noDataAreaNos: rows.filter(r => r.state === 'no_data').map(r => r.areaNo),
        errorAreaNos: rows.filter(r => r.state === 'error').map(r => r.areaNo),
        // Coverage 는 구역 안에 HD Map 도로가 있어야 나온다 — 없으면 0% 가 아니라 '미계산'
        noCoverageAreaNos: rows.filter(r => r.state === 'ok' && r.coveragePct == null).map(r => r.areaNo),
        drawnAreaNos: rows.filter(r => r.polygonSource === 'drawn').map(r => r.areaNo),
      },
    };
  }

  // 화면·보고서에서 같은 문장을 쓰도록 여기서 만든다
  function formatRatio(ratio) {
    return Number.isFinite(ratio) ? `${(Math.round(ratio * 100) / 100).toFixed(2)}배` : '—';
  }
  function formatPercentDiff(percent) {
    if (!Number.isFinite(percent)) return '—';
    const p = Math.round(percent * 10) / 10;
    return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
  }
  function formatMinutes(minutes) {
    if (!Number.isFinite(minutes)) return '—';
    const m = Math.round(minutes);
    if (Math.abs(m) < 60) return `${m}분`;
    return `${m}분 (${(m / 60).toFixed(1)}시간)`;
  }

  return {
    HDMAP_PRIORITY_VERSION,
    PRIMARY_AREA_NO, PRIORITY_AREA_NOS, NORMAL_AREA_NOS, ALL_AREA_NOS,
    PRIORITY_LEVELS, priorityLabel, priorityOf, isPriorityArea, isNormalArea,
    AREA_STATES, areaStateLabel,
    parseAreas, listAreas, geometryToPolygon, ringToPolygon,
    normalizeAreaPolygon, normalizeSavedPolygons,
    validateAreas, toSubZoneInputs,
    normalAverage, compareToAverage, buildComparison,
    formatRatio, formatPercentDiff, formatMinutes,
  };
}));
