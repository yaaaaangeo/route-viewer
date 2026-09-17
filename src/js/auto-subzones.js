// ══════════════════════════════════════════════════════════
//  auto-subzones — 지도·GPS 를 분석해 세부 수집 구역을 "자동으로" 만든다
//
//  사용자는 상위 구역만 고르면 된다. 여기서
//    1) 도로 Segment(road-graph.js)마다 성격을 판정하고(semanticTypes),
//    2) 성격이 비슷한 이웃 Segment 를 묶어 자동 세부 구역을 만들고,
//    3) 무엇을 근거로 그렇게 판정했는지(basis)를 함께 남긴다.
//
//  ⚠ 사실성 규칙
//   · 이름은 지도 데이터에 있는 도로명만 쓴다. 학교·IC·상권 이름을 만들어내지 않는다.
//   · "공식 어린이보호구역"은 공식 데이터가 있을 때만 말한다. 학교 POI 만 있으면 '학교 인접 도로'다.
//   · 지도 POI 가 없으면 우리 주행 기록(속도·시간대·방문)으로만 판정하고, 판정 이름도 그에 맞게 쓴다
//     (예: 업무지구 ❌ → '출퇴근 집중 구간' ⭕ — 근거가 주행 패턴이므로).
//   · 모든 판정에 근거 문장과 신뢰도를 붙인다. 근거가 없으면 '확인 불가'로 둔다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./subzones.js'), require('./road-graph.js'), require('./time-conditions.js'));
  } else {
    root.AutoSubZones = factory(root.SubZones, root.RoadGraph, root.TimeConditions);
  }
}(typeof self !== 'undefined' ? self : this, function (SZ, RG, TC) {
  'use strict';

  // 판정 규칙을 바꾸면 올린다 — 저장된 분석이 이 버전과 다르면 다시 분석한다
  const AUTO_ANALYSIS_VERSION = 1;

  // ── 자동 판정 유형 ────────────────────────────────────
  // requires: 이 유형을 말하려면 반드시 있어야 하는 근거. 없으면 그 유형을 쓰지 않는다.
  const SEMANTIC_TYPES = Object.freeze({
    // 지도 이름/태그로 확인되는 것
    expressway_mainline: Object.freeze({
      label: '고속화도로 본선', requires: 'map', placeType: 'expressway_mainline',
      candidateTimes: ['morning_peak', 'evening_peak', 'night'],
      expects: ['고속 합류', '정체 시작·해소', '급격한 속도 변화', 'Cut-in 가능성', '야간 Headlight Glare'],
    }),
    expressway_ramp: Object.freeze({
      label: '진입·진출 램프', requires: 'map', placeType: 'expressway_ramp',
      candidateTimes: ['morning_peak', 'evening_peak', 'night'],
      expects: ['짧은 합류 구간', '연속 차선 변경', '진출 대기행렬', '본선과의 속도 차이', '급감속'],
    }),
    official_school_zone: Object.freeze({
      label: '공식 어린이보호구역', requires: 'official', placeType: 'school_zone',
      candidateTimes: ['morning_peak', 'afternoon_offpeak'],
      expects: ['어린이 보행자', '통학버스', '보호자 차량', '갑작스러운 횡단', '불법 주정차'],
      safetyFirst: true,
    }),
    school_adjacent: Object.freeze({
      label: '학교 인접 도로', requires: 'poi', placeType: 'school_zone',
      candidateTimes: ['morning_peak', 'afternoon_offpeak'],
      expects: ['어린이 보행자', '통학 차량', '불법 주정차', '저속 선행차량', '시야 가림'],
      safetyFirst: true,
    }),
    office_district: Object.freeze({
      label: '업무 밀집 구역', requires: 'poi', placeType: 'office_district',
      candidateTimes: ['morning_peak', 'lunch_peak', 'evening_peak'],
      expects: ['정체', '빈번한 차선 변경', '버스 정차', '택시 승하차', '교차로 꼬리물기'],
    }),
    commercial_district: Object.freeze({
      label: '상업 밀집 구역', requires: 'poi', placeType: 'commercial_district',
      candidateTimes: ['lunch_peak', 'evening_peak', 'night'],
      expects: ['보행자', '택시 승하차', '배달 오토바이', '불법 주정차'],
    }),
    hospital_zone: Object.freeze({
      label: '병원 인접 구역', requires: 'poi', placeType: 'hospital_zone',
      candidateTimes: ['morning_peak', 'morning_offpeak', 'afternoon_offpeak'],
      expects: ['구급차', '승하차 정차', '주차 대기행렬', '보행자'],
    }),
    market_zone: Object.freeze({
      label: '시장 주변', requires: 'poi', placeType: 'market_zone',
      candidateTimes: ['morning_offpeak', 'afternoon_offpeak'],
      expects: ['보행자', '노상 적치물', '배달 차량', '좁은 도로 교행'],
    }),
    transit_hub: Object.freeze({
      label: '역·환승 거점 인접', requires: 'poi', placeType: 'transit_hub',
      candidateTimes: ['morning_peak', 'evening_peak'],
      expects: ['버스 정차', '택시 승하차', '보행자 급증', '정류장 대기 차량'],
    }),
    residential_access: Object.freeze({
      label: '주거단지 진출입 인접 도로', requires: 'poi', placeType: 'residential_complex',
      candidateTimes: ['morning_peak', 'evening_peak', 'afternoon_offpeak'],
      expects: ['단지 진출입 차량', '이중주차', '보행자', '시야 가림'],
    }),

    // 우리 주행 기록으로만 판정하는 것 — 이름도 "지도 사실"이 아니라 "관측"으로 쓴다
    high_speed_corridor: Object.freeze({
      label: '고속 주행 구간(관측)', requires: 'gps', placeType: 'expressway_mainline',
      candidateTimes: ['morning_peak', 'evening_peak', 'night'],
      expects: ['고속 주행', '차선 변경', '속도 변화', '야간 시인성 저하'],
    }),
    merge_candidate: Object.freeze({
      label: '합류·분기 후보(관측)', requires: 'gps', placeType: 'expressway_ramp',
      candidateTimes: ['morning_peak', 'evening_peak'],
      expects: ['합류 차량', '급감속', '연속 차선 변경', '속도 차이'],
    }),
    junction_cluster: Object.freeze({
      label: '교차로 밀집 구간', requires: 'graph', placeType: 'major_intersection',
      candidateTimes: ['morning_peak', 'lunch_peak', 'evening_peak'],
      expects: ['교차로 정체', '좌우회전 대기', '꼬리물기', '보행 신호 대기'],
    }),
    commute_peak_corridor: Object.freeze({
      label: '출퇴근 집중 구간(관측)', requires: 'gps', placeType: 'office_district',
      candidateTimes: ['morning_peak', 'evening_peak'],
      expects: ['정체', '빈번한 차선 변경', '버스 정차', '합류·끼어들기'],
    }),
    congestion_prone: Object.freeze({
      label: '저속·정체 잦은 구간(관측)', requires: 'gps', placeType: 'major_intersection',
      candidateTimes: ['morning_peak', 'lunch_peak', 'evening_peak'],
      expects: ['정체', '정차·재출발', '보행자', '끼어들기'],
    }),
    coverage_gap: Object.freeze({
      label: '미방문·부족 구간', requires: 'gps', placeType: 'manual_custom_zone',
      candidateTimes: [],
      expects: [],
    }),
    unclassified: Object.freeze({
      label: '유형 확인 불가', requires: null, placeType: 'manual_custom_zone',
      candidateTimes: [], expects: [],
    }),
  });
  const semanticLabel = id => (SEMANTIC_TYPES[id] || SEMANTIC_TYPES.unclassified).label;

  // ── 판정 기준값(설정에서 바꿀 수 있게 밖으로 뺀다) ────
  const CLASSIFY_DEFAULTS = Object.freeze({
    highSpeedKmh: 55,         // 이 이상 평균이면 고속 주행 구간(관측)
    mergeSpeedDropKmh: 20,    // 이웃 고속 구간과 이만큼 차이 나면 합류·분기 후보
    congestionSlowRatio: 0.35,// 10km/h 미만 주행 비율이 이 이상이면 저속·정체 잦은 구간
    commutePeakRatio: 0.55,   // 출퇴근 피크 수집 비중이 이 이상이면 출퇴근 집중 구간
    minSamplesForSpeed: 40,   // 속도로 판정하려면 최소 이만큼 기록이 있어야 한다
    junctionClusterMaxM: 150, // 양끝이 교차로이면서 이보다 짧으면 교차로 밀집 구간
    poiRadiusM: 120,          // POI 가 이 안에 있으면 그 구간에 인접한 것으로 본다
    staleDays: 21,
  });

  // ── 1) Segment 판정 ───────────────────────────────────
  // stats: { [segmentId]: {recordCount, collectionSec, speed:{avgKmh,slowRatio,count}, periods:{id:sec}, lastVisitedAt, coverage} }
  // poi: { schools:[{lat,lng,name}], offices:[], ... , officialSchoolZones:[{polygon|lat,lng,name}] } — 없으면 null
  function classifySegments(segments, stats, context) {
    const ctx = context || {};
    const cfg = { ...CLASSIFY_DEFAULTS, ...(ctx.thresholds || {}) };
    const poi = ctx.poi || null;
    const today = ctx.today || null;
    const byId = new Map(segments.map(s => [s.id, s]));

    // 이웃(노드를 공유하는 Segment) — 합류·분기 후보 판정에 쓴다
    const byNode = new Map();
    segments.forEach(s => {
      [s.startNode, s.endNode].forEach(n => {
        if (!byNode.has(n)) byNode.set(n, []);
        byNode.get(n).push(s.id);
      });
    });
    const neighborsOf = s => [...new Set([...(byNode.get(s.startNode) || []), ...(byNode.get(s.endNode) || [])])]
      .filter(id => id !== s.id).map(id => byId.get(id)).filter(Boolean);

    segments.forEach(seg => {
      const st = (stats && stats[seg.id]) || null;
      const types = [];
      const basis = [];
      const add = (type, conf, why, source) => types.push({ type, confidence: conf, basis: why, source });

      // (a) 지도 이름 — 이름에 그렇게 적혀 있을 때만
      const roadClass = SZ.roadClassOf(seg.roadName, seg.osmTags);
      if (roadClass.id === 'ramp') {
        add('expressway_ramp', 'high', `OpenStreetMap 도로 등급 ${seg.osmTags.highway}(연결로) — 본선이 아니라 램프입니다.`, 'map');
      } else if (roadClass.id === 'expressway' || roadClass.id === 'trunk') {
        add('expressway_mainline', 'high', roadClass.source === 'osm'
          ? `OpenStreetMap 도로 등급 ${seg.osmTags.highway}.`
          : `도로명이 "${seg.roadName}" 으로 고속도로임이 지도 데이터에 적혀 있습니다.`, 'map');
      }

      // (c) POI — 있을 때만. 없으면 그 유형 자체를 쓰지 않는다.
      if (poi) {
        const near = (list, radius) => (list || []).filter(p => nearSegment(seg, p, radius || cfg.poiRadiusM));
        const officialZones = near(poi.officialSchoolZones);
        const schools = near(poi.schools);
        if (officialZones.length) {
          add('official_school_zone', 'high', `공식 어린이보호구역 데이터에 ${officialZones.length}건이 이 구간 ${cfg.poiRadiusM}m 안에 있습니다.`, 'official');
        } else if (schools.length) {
          add('school_adjacent', 'medium', `학교 POI ${schools.length}곳이 이 구간 ${cfg.poiRadiusM}m 안에 있습니다. 공식 어린이보호구역 데이터는 없어 지정 여부는 확인되지 않았습니다.`, 'poi');
        }
        const offices = near(poi.offices);
        if (offices.length >= 3) add('office_district', 'medium', `업무시설 POI ${offices.length}곳이 이 구간 주변에 있습니다.`, 'poi');
        const shops = near(poi.commercial);
        if (shops.length >= 5) add('commercial_district', 'medium', `상업시설 POI ${shops.length}곳이 이 구간 주변에 있습니다.`, 'poi');
        const hospitals = near(poi.hospitals);
        if (hospitals.length) add('hospital_zone', 'medium', `병원 POI ${hospitals.length}곳이 이 구간 주변에 있습니다.`, 'poi');
        const markets = near(poi.markets);
        if (markets.length) add('market_zone', 'medium', `시장 POI ${markets.length}곳이 이 구간 주변에 있습니다.`, 'poi');
        const transit = near(poi.transit);
        if (transit.length >= 2) add('transit_hub', 'medium', `역·정류장 POI ${transit.length}곳이 이 구간 주변에 있습니다.`, 'poi');
        const residential = near(poi.residential);
        if (residential.length) add('residential_access', 'medium', `아파트·주거단지 ${residential.length}곳이 이 구간 주변에 있습니다(단지 내부 도로는 Coverage 에서 제외되지만 이 구간은 외곽 공공도로입니다).`, 'poi');
      }

      // (d) 도로망 모양 — 교차로 밀집(양끝이 교차로이면서 아주 짧은 구간만. 도심에서는
      //     교차로 사이 구간이 보통이라, "짧다"는 조건이 없으면 거의 모든 구간이 걸린다)
      const junctions = (seg.startJunction ? 1 : 0) + (seg.endJunction ? 1 : 0);
      if (junctions === 2 && seg.lengthM > 0 && seg.lengthM <= cfg.junctionClusterMaxM) {
        add('junction_cluster', 'medium', `양끝이 교차로인 ${seg.lengthM}m 짧은 구간입니다(교차로가 ${Math.round(1000 / seg.lengthM)}개/km 꼴).`, 'graph');
      }

      // (e) 우리 주행 기록 — 속도·시간대·정체
      if (st && st.speed && st.speed.count >= cfg.minSamplesForSpeed) {
        if (st.speed.avgKmh >= cfg.highSpeedKmh) {
          add('high_speed_corridor', 'medium', `우리 주행 기록 ${st.speed.count}건의 평균 속도가 ${st.speed.avgKmh}km/h 입니다(지도에 등급 정보가 없어 관측값으로 판정).`, 'gps');
        }
        if (st.speed.slowRatio >= cfg.congestionSlowRatio) {
          add('congestion_prone', 'medium', `10km/h 미만 주행 비율이 ${Math.round(st.speed.slowRatio * 100)}% 입니다(기록 ${st.speed.count}건).`, 'gps');
        }
      }
      if (st && st.periods) {
        const total = Object.values(st.periods).reduce((a, b) => a + b, 0);
        const peak = (st.periods.morning_peak || 0) + (st.periods.evening_peak || 0);
        if (total > 600 && peak / total >= cfg.commutePeakRatio) {
          add('commute_peak_corridor', 'medium', `수집 시간의 ${Math.round(peak / total * 100)}%가 출근·퇴근 피크에 몰려 있습니다.`, 'gps');
        }
      }
      // (f) 아직 못 가본 곳
      if (!st || !st.recordCount) {
        add('coverage_gap', 'high', '이 구간에서 우리 주행 기록이 아직 없습니다.', 'gps');
      } else if (today && st.lastVisitedAt) {
        const days = daysBetween(String(st.lastVisitedAt).slice(0, 10), today);
        if (days >= cfg.staleDays) add('coverage_gap', 'medium', `마지막 주행이 ${days}일 전입니다.`, 'gps');
      }

      // (g) 합류·분기 후보 — 고속 이웃과 속도 차이가 큰 짧은 구간
      const fast = neighborsOf(seg).filter(n => {
        const ns = (stats && stats[n.id]) || null;
        return ns && ns.speed && ns.speed.count >= cfg.minSamplesForSpeed && ns.speed.avgKmh >= cfg.highSpeedKmh;
      });
      if (fast.length && st && st.speed && st.speed.count >= cfg.minSamplesForSpeed) {
        const fastest = Math.max(...fast.map(n => stats[n.id].speed.avgKmh));
        if (fastest - st.speed.avgKmh >= cfg.mergeSpeedDropKmh && seg.lengthM <= 400) {
          add('merge_candidate', 'low', `고속 주행 구간(${fastest}km/h)과 이어지는 ${seg.lengthM}m 구간인데 이 구간 평균은 ${st.speed.avgKmh}km/h 입니다 — 합류·분기일 가능성이 있습니다(지도 등급으로 확인된 것은 아닙니다).`, 'gps');
        }
      }

      // 우선순위: 지도/공식 > POI > 관측 > 그래프
      const rank = { official: 5, map: 4, poi: 3, gps: 2, graph: 1 };
      types.sort((a, b) => (rank[b.source] || 0) - (rank[a.source] || 0)
        || confRank(b.confidence) - confRank(a.confidence));
      // "미방문·부족"은 그 구간의 성격이 아니라 지금 상태다 — 유형으로 삼지 않고 근거로만 남긴다
      // (이걸 유형으로 쓰면 아직 안 가본 도로가 전부 한 덩어리로 묶여 버린다)
      const characterTypes = types.filter(t => t.type !== 'coverage_gap');
      if (!characterTypes.length) {
        types.push({ type: 'unclassified', confidence: 'low', basis: '지도 POI·도로 등급이 없고 주행 기록도 적어 유형을 정하지 못했습니다.', source: null });
      }
      seg.semanticTypes = types;
      seg.gap = types.find(t => t.type === 'coverage_gap') || null;
      seg.primaryType = (characterTypes[0] || { type: 'unclassified' }).type;
      seg.primaryLabel = semanticLabel(types[0].type);
      seg.typeBasis = types.map(t => `${semanticLabel(t.type)} — ${t.basis}`);
      seg.evidence = SZ.evidenceLevel({
        hdmap: seg.source && seg.source.type === 'hdmap',
        osm: !!(seg.osmTags || (poi && poi.fetchedAt)),
        gps: !!(st && st.recordCount),
      });
      void basis;
    });
    return segments;
  }

  const confRank = c => (c === 'high' ? 3 : c === 'medium' ? 2 : 1);

  function daysBetween(from, to) {
    const a = Date.parse(`${from}T00:00:00+09:00`), b = Date.parse(`${to}T00:00:00+09:00`);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : 0;
  }

  // POI 하나가 이 구간에서 radius 안인지 — 구간의 모든 선분과의 최단거리로 본다
  // (POI 중심으로 원을 그리는 방식이 아니라, 도로와의 실제 거리로 판정한다)
  function nearSegment(seg, poi, radiusM) {
    const lat = Number(poi.lat), lng = Number(poi.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const pts = seg.geometry;
    for (let i = 1; i < pts.length; i++) {
      if (SZ.pointToSegment(lat, lng, pts[i - 1], pts[i]).distanceM <= radiusM) return true;
    }
    return false;
  }

  // ── 2) 자동 세부 구역 묶기 ────────────────────────────
  // 같은 유형이면서 서로 이어지는(노드를 공유하는) Segment 를 한 구역으로 묶는다.
  // 자동 구역이 너무 커지지 않게 — 한 구역은 도로 하나의 성격이 같은 구간 묶음이어야 한다
  const GROUP_LIMITS = Object.freeze({ maxLengthM: 3000, maxSegments: 12 });

  function groupSubZones(segments, options) {
    const o = options || {};
    const limits = { ...GROUP_LIMITS, ...(o.limits || {}) };
    const parentZone = o.parentZone || '';
    const byNode = new Map();
    segments.forEach(s => [s.startNode, s.endNode].forEach(n => {
      if (!byNode.has(n)) byNode.set(n, []);
      byNode.get(n).push(s);
    }));
    const seen = new Set();
    const zones = [];
    const counters = new Map();

    segments.forEach(seed => {
      if (seen.has(seed.id)) return;
      // 같은 유형 + 연결된 것만 모은다(BFS)
      const group = [];
      const queue = [seed];
      let groupLength = 0;
      seen.add(seed.id);
      while (queue.length) {
        const cur = queue.shift();
        group.push(cur);
        groupLength += cur.lengthM;
        if (group.length >= limits.maxSegments || groupLength >= limits.maxLengthM) break;
        [cur.startNode, cur.endNode].forEach(n => (byNode.get(n) || []).forEach(next => {
          if (seen.has(next.id)) return;
          // 같은 성격 + 같은 도로명일 때만 한 구역으로 본다 — 이름이 다르면 다른 구역이다
          if (next.primaryType !== seed.primaryType) return;
          if (next.roadName !== seed.roadName) return;
          seen.add(next.id);
          queue.push(next);
        }));
      }
      queue.forEach(left => seen.delete(left.id));   // 상한에 걸려 못 담은 것은 다음 구역으로
      const type = SEMANTIC_TYPES[seed.primaryType] || SEMANTIC_TYPES.unclassified;
      const lengthM = group.reduce((a, s) => a + s.lengthM, 0);
      // 도로명이 가장 긴 구간의 이름을 대표로 쓴다(이름을 만들지 않고 실제 이름 중에서 고른다)
      const named = group.filter(s => s.named).sort((a, b) => b.lengthM - a.lengthM);
      const dominantRoad = named.length ? named[0].roadName : null;
      const base = dominantRoad ? `${dominantRoad} ${type.label}` : `${type.label}`;
      const n = (counters.get(base) || 0) + 1;
      counters.set(base, n);
      const center = {
        lat: group.reduce((a, s) => a + s.center.lat, 0) / group.length,
        lng: group.reduce((a, s) => a + s.center.lng, 0) / group.length,
      };
      const polygon = hullOf(group);
      zones.push({
        id: `${parentZone}:auto:${RG.fnv1a(group.map(s => s.id).sort().join(','))}`,
        parentZone,
        name: dominantRoad ? `${base} #${n}` : `${base} #${n} (약 ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)})`,
        nameBasis: dominantRoad
          ? `지도 데이터의 도로명 "${dominantRoad}" + 자동 판정 유형`
          : `지도 데이터에 도로명이 없어 좌표로 표시 — 약 ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`,
        type: type.placeType,
        semanticType: seed.primaryType,
        semanticLabel: type.label,
        auto: true,
        segmentIds: group.map(s => s.id),
        roadNames: [...new Set(group.filter(s => s.named).map(s => s.roadName))],
        lengthM: Math.round(lengthM),
        center,
        polygon,
        candidateTimes: type.candidateTimes.slice(),
        expects: type.expects.slice(),
        safetyFirst: !!type.safetyFirst,
        basis: [...new Set(group.flatMap(s => s.semanticTypes.filter(t => t.type === seed.primaryType).map(t => t.basis)))].slice(0, 3),
        evidence: group[0].evidence,
        active: true,
      });
    });
    return zones.sort((a, b) => b.lengthM - a.lengthM);
  }

  // 구역 경계 — 구간 좌표들의 bounding box 를 조금 부풀린 사각형(지도에 표시용).
  // 정확한 행정 경계가 아니므로 "분석 대상 범위"로만 쓴다.
  function hullOf(segments) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    segments.forEach(s => s.geometry.forEach(([la, lo]) => {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLng) minLng = lo;
      if (lo > maxLng) maxLng = lo;
    }));
    const pad = 0.0004;
    return [[minLat - pad, minLng - pad], [maxLat + pad, minLng - pad], [maxLat + pad, maxLng + pad], [minLat - pad, maxLng + pad]];
  }

  // ── 3) 사용자 보정 덮어쓰기 ───────────────────────────
  // 자동 결과는 그대로 두고(원본 보존), 사용자가 고친 값만 위에 덮는다.
  // 그래서 다시 분석해도 보정이 살아남는다(id 가 안정적이라 붙어 있을 수 있다).
  function applyOverrides(zones, overrides) {
    const map = new Map((overrides || []).map(o => [o.id, o]));
    return zones.map(zone => {
      const ov = map.get(zone.id);
      if (!ov) return zone;
      const merged = { ...zone, override: ov };
      if (ov.name) { merged.name = ov.name; merged.nameBasis = '사용자가 직접 고친 이름'; }
      if (ov.type) merged.type = ov.type;
      if (ov.semanticType) {
        merged.semanticType = ov.semanticType;
        merged.semanticLabel = semanticLabel(ov.semanticType);
        const t = SEMANTIC_TYPES[ov.semanticType];
        if (t) { merged.candidateTimes = t.candidateTimes.slice(); merged.expects = t.expects.slice(); merged.safetyFirst = !!t.safetyFirst; }
        merged.basis = [`사용자가 유형을 "${merged.semanticLabel}" 로 고쳤습니다.`].concat(zone.basis || []);
      }
      if (ov.officialVerified !== undefined) merged.officialVerified = !!ov.officialVerified;
      if (ov.excluded) merged.active = false;
      if (ov.mergeInto) merged.mergeInto = ov.mergeInto;
      return merged;
    }).map((zone, _i, all) => {
      // 병합 보정 — 다른 구역에 합치라고 했으면 그 구역이 구간을 흡수한다
      if (!zone.mergeInto) return zone;
      const host = all.find(z => z.id === zone.mergeInto);
      if (!host) return zone;
      host.segmentIds = [...new Set(host.segmentIds.concat(zone.segmentIds))];
      host.mergedFrom = (host.mergedFrom || []).concat([zone.id]);
      return { ...zone, active: false, mergedInto: host.id };
    });
  }

  // ── 4) 분석 묶음 ──────────────────────────────────────
  // segments·stats·poi 를 받아 자동 구역까지 만든다(저장소가 이 결과를 캐시한다).
  function buildAnalysis(input) {
    const o = input || {};
    const segments = classifySegments(o.segments || [], o.segmentStats || {}, {
      poi: o.poi, today: o.today, thresholds: o.thresholds,
    });
    const zones = applyOverrides(groupSubZones(segments, { parentZone: o.parentZone }), o.overrides);
    const dataLevels = {
      roadGraph: segments.length > 0,
      poi: !!(o.poi && o.poi.fetchedAt),
      officialSchoolZones: !!(o.poi && o.poi.officialSchoolZones && o.poi.officialSchoolZones.length),
      gps: Object.keys(o.segmentStats || {}).length > 0,
      coverage: !!o.coverage,
    };
    const notes = [];
    if (!dataLevels.poi) notes.push('지도 POI(업무시설·학교·병원·시장·역) 데이터를 받지 못해, 업무지구·학교 인접 도로 같은 시설 기반 분류는 하지 않았습니다 — 도로망과 우리 주행 기록(속도·시간대·방문)만으로 판정했습니다.');
    if (dataLevels.poi && !dataLevels.officialSchoolZones) notes.push('공식 어린이보호구역 데이터가 없어, 학교가 가까운 구간은 "학교 인접 도로"로만 분류했습니다(보호구역 지정 여부는 확인되지 않음).');
    if (!dataLevels.gps) notes.push('이 구역에서 우리 주행 기록이 아직 없어 수집량·방향 판단은 하지 못했습니다.');
    return {
      version: AUTO_ANALYSIS_VERSION,
      parentZone: o.parentZone,
      analyzedAt: o.analyzedAt || new Date().toISOString(),
      segments, zones, dataLevels, notes,
      thresholds: { ...CLASSIFY_DEFAULTS, ...(o.thresholds || {}) },
    };
  }

  return {
    AUTO_ANALYSIS_VERSION, SEMANTIC_TYPES, CLASSIFY_DEFAULTS, semanticLabel,
    classifySegments, groupSubZones, applyOverrides, buildAnalysis, nearSegment, hullOf,
  };
}));
