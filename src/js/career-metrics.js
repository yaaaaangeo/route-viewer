// ══════════════════════════════════════════════════════════
//  career-metrics — 개인용 Career Log / Project Impact 의 순수 계산
//
//  왜 따로 있나
//    Route Viewer 본 기능(달력·누적 지도·통계·추천)과 섞지 않는 개인 기록이다.
//    화면(career-log-view.js)·수집기(kpi-history.js)·SQLite(electron/database.js)·
//    IndexedDB(storage.js)·테스트가 같은 규칙을 쓰도록 계산은 전부 여기 한 곳에 둔다.
//
//  새로 집계하지 않는다
//    · 규모(기록 수·거리·수집/주행 시간)   → 날짜 요약 + CollectionStats
//    · 조건별 수집량(시간대·조도·Maneuver·Road Context) → ConditionStats.aggregate/aggregateAnalysis
//    · ①~⑫ 구역 수집량                    → getSubZoneStats(aggregateSubZone) 결과
//    · Coverage 방문 횟수                   → CoverageGrid visitCounts(누적 지도가 계산한 칸별 방문 수)
//    · 부족 조건                            → Recommendation.buildRecommendations 의 priority
//    여기서 하는 일은 그 결과를 "목표 대비 얼마인가"로 읽고, 시간축(snapshot)으로 남기는 것뿐이다.
//
//  반복 주행은 이 프로젝트에서 의도한 수집 방식이다 — 여러 번 지나간 칸은
//  "Coverage Depth / Repeated Collection Depth" 로 부른다.
//
//  Privacy
//    Career Log 데이터는 로컬 전용(localOnly)이다. 백업 파일·서버 동기화 payload 에 넣지 않고,
//    Export 에도 원본 GPS 좌표는 싣지 않는다(stripGeoFields 로 한 번 더 걸러낸다).
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./collection-stats.js'), require('./condition-stats.js'));
  } else {
    root.CareerMetrics = factory(root.CollectionStats, root.ConditionStats);
  }
}(typeof self !== 'undefined' ? self : this, function (CS, CSt) {
  'use strict';

  const CAREER_VERSION = 1;
  const EXPORT_TYPE = 'route-viewer-career-log';

  // 저장 영역 — SQLite 테이블 / IndexedDB 스토어. 둘 다 백업·동기화 대상이 아니다(local-only).
  const CAREER_KINDS = Object.freeze({
    kpiSnapshots: Object.freeze({ table: 'career_kpi_snapshots', store: 'careerKpiSnapshots', label: 'KPI Snapshot' }),
    collectionPlans: Object.freeze({ table: 'career_collection_plans', store: 'careerCollectionPlans', label: 'Collection Plan' }),
    contributions: Object.freeze({ table: 'career_contribution_log', store: 'careerContributionLog', label: 'Contribution Log' }),
    workTimes: Object.freeze({ table: 'career_work_time_log', store: 'careerWorkTimeLog', label: 'Work Time Log' }),
  });
  const CAREER_KIND_IDS = Object.freeze(Object.keys(CAREER_KINDS));

  // 추천(recommendation.js)과 같은 기준 — 아직 확인하지 않은 이슈 데이터로 "충분하다"고 판단하지 않는다
  const CAREER_ISSUE_FILTER = 'clean';

  const DEPTH_LEVELS = Object.freeze([1, 3, 5, 10]);
  const AREA_NOS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const CIRCLED = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];

  // recommendation.js 와 같은 ID — 값을 여기서 다시 정하지 않고 이름만 맞춘다
  const MANEUVER_EVENT_IDS = Object.freeze(['LEFT_TURN', 'RIGHT_TURN', 'U_TURN', 'MERGE', 'DIVERGE']);
  const MANEUVER_DURATION_IDS = Object.freeze(['STRAIGHT']);
  const OPTIONAL_MANEUVER_IDS = Object.freeze(['MERGE', 'DIVERGE']); // 확인된 곳에서만 목표로 본다(추천과 같은 규칙)

  const TARGET_KINDS = Object.freeze({
    coverageDepth: Object.freeze({ label: 'Coverage Depth', unit: '%' }),
    totalTime: Object.freeze({ label: '수집 시간', unit: '분' }),
    trafficPeriod: Object.freeze({ label: '교통 시간대', unit: '분' }),
    lightCondition: Object.freeze({ label: '조도', unit: '분' }),
    maneuver: Object.freeze({ label: 'Ego Maneuver', unit: null }),
    drivingState: Object.freeze({ label: 'Driving State', unit: '분' }),
    roadContext: Object.freeze({ label: 'Road Context', unit: '분' }),
  });
  const TARGET_KIND_IDS = Object.freeze(Object.keys(TARGET_KINDS));

  const PRIORITY_IDS = Object.freeze(['high', 'medium', 'low']);
  const PRIORITY_LABELS = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low' });

  const WORK_MODES = Object.freeze({ manual: 'Manual', route_viewer: 'Route Viewer' });

  // ── 작은 도구 ─────────────────────────────────────────
  const round1 = n => Math.round(n * 10) / 10;
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const str = v => (v == null ? '' : String(v).trim());
  const num = v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  const clone = v => JSON.parse(JSON.stringify(v));
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : null);

  function daysBetweenInclusive(from, to) {
    if (!isDate(from) || !isDate(to)) return 0;
    const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
    return Math.round((b - a) / 86400000) + 1;
  }

  function compactDate(date) { return String(date || '').replace(/-/g, ''); }

  // ── 구역(scope) ───────────────────────────────────────
  // "5" 처럼 숫자 1~12 면 HD Map 우선 구축 구역 ①~⑫, 그 밖은 운영 구역 이름('강남' 등)
  function isAreaScope(scope) { return /^(?:[1-9]|1[0-2])$/.test(String(scope)); }
  function scopeLabel(scope) { return isAreaScope(scope) ? CIRCLED[Number(scope)] : String(scope); }
  function scopeSort(a, b) {
    const aa = isAreaScope(a), bb = isAreaScope(b);
    if (aa && bb) return Number(a) - Number(b);
    if (aa !== bb) return aa ? -1 : 1;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }

  // ══════════════════════════════════════════════════════
  //  1) Project Scale — 날짜 요약·저장소 통계로만 센다
  //  input: {summaries, stats, vehicles, zones, areas, plan, targetCount, analysisUnitCount, today}
  // ══════════════════════════════════════════════════════
  function buildProjectScale(input) {
    const o = input || {};
    const summaries = (o.summaries || []).filter(Boolean);
    const dated = summaries.filter(s => isDate(s.date)).map(s => s.date).sort();
    const first = dated[0] || null, last = dated[dated.length - 1] || null;
    const collection = CS.summarizeCollection(summaries);
    const progress = CS.collectionProgress(collection.totalSec, undefined, collection.totalSpanSec);

    let recordCount = 0, distanceKm = 0, vehicleDays = 0;
    const vehicles = new Set();
    summaries.forEach(s => {
      recordCount += Number(s.count) || 0;
      distanceKm += Number(s.distanceKm) || 0;
      const vs = (s.vehicles || []).filter(v => v && v[0] && (Number(v[1]) || 0) > 0).map(v => String(v[0]));
      vs.forEach(v => vehicles.add(v));
      if (isDate(s.date)) vehicleDays += vs.length;
    });
    const activeVehicleSettings = (o.vehicles || []).filter(v => v && v.active !== false).length;
    const activeZones = (o.zones || []).filter(z => z && z.active !== false).map(z => z.name);
    const areas = o.areas || [];
    const areasWithPolygon = areas.filter(a => a && a.hasPolygon).length;
    const today = isDate(o.today) ? o.today : last;
    const imports = o.stats && Number.isFinite(o.stats.imports) ? o.stats.imports : null;
    const kpiRow = progress.rows[0] || null;

    const items = [
      { key: 'operationStart', label: '운영 시작일', value: first, display: first || '—',
        basis: '저장된 날짜 요약 중 가장 이른 날짜(날짜를 읽지 못한 묶음 제외).' },
      { key: 'operationPeriod', label: '운영 기간', value: first ? daysBetweenInclusive(first, today) : 0,
        display: first ? `${first} ~ ${today} · ${daysBetweenInclusive(first, today)}일` : '—',
        basis: '첫 기록 날짜부터 오늘(한국 시간)까지 달력 일수(양 끝 포함). 쉬는 날도 포함한 기간이에요.' },
      { key: 'collectionDays', label: '데이터 수집 일수', value: dated.length, display: `${dated.length}일`,
        basis: 'GPS 기록이 1건 이상 있는 날짜 수(날짜 요약 개수).' },
      { key: 'vehicleDays', label: '총 주행 일수(차량·일)', value: vehicleDays, display: `${vehicleDays}일`,
        basis: '날짜마다 기록이 있는 차량 수를 더한 값 — 하루에 2대가 달리면 2일로 셉니다.' },
      { key: 'vehicleCount', label: '차량', value: vehicles.size, display: `${vehicles.size}대`,
        basis: `기록에 한 번이라도 나온 차량 수. 설정에서 활성인 차량은 ${activeVehicleSettings}대예요.` },
      { key: 'recordCount', label: 'GPS Records', value: recordCount, display: recordCount.toLocaleString('en-US'),
        basis: 'import 때 date|time|vehicle|lat|lng 로 중복을 걸러 DB 에 남은 GPS 기록 수(날짜 요약 합).' },
      { key: 'distanceKm', label: '총 주행거리', value: round1(distanceKm), display: `${Math.round(distanceKm).toLocaleString('en-US')} km`,
        basis: '날짜 요약의 거리 합 — 날짜·차량별로 앞뒤 기록 사이 직선 거리(haversine)를 더한 값.' },
      { key: 'driveMinutes', label: '총 주행 시간', value: progress.driveMinutes, display: `${progress.driveMinutes.toLocaleString('en-US')} min`,
        basis: '날짜·차량별 첫 기록 ~ 마지막 기록(휴식·GPS 공백 포함)의 합(collection-stats.js spanDurationSec).' },
      { key: 'collectionMinutes', label: '유효 수집시간', value: progress.collectedMinutes, display: `${progress.collectedMinutes.toLocaleString('en-US')} min`,
        basis: `같은 차량 기록 간격이 ${CS.COLLECTION_GAP_SEC}초 이하인 구간만 더한 시간(collection-stats.js validDurationSec).` },
      { key: 'zoneCount', label: '관리 Zone', value: activeZones.length + areasWithPolygon,
        display: `운영 ${activeZones.length} · HD Map ${areasWithPolygon}/${areas.length || 12}`,
        basis: `활성 운영 구역(${activeZones.join(', ') || '없음'}) + 경계가 있는 HD Map 우선 구축 구역 ①~⑫.` },
      { key: 'conditionCount', label: '관리 조건', value: Number.isFinite(o.targetCount) ? o.targetCount : (o.analysisUnitCount || 0),
        display: Number.isFinite(o.targetCount) ? `${o.targetCount} Targets` : `${o.analysisUnitCount || 0} 조건`,
        basis: Number.isFinite(o.targetCount)
          ? `현재 Collection Plan(${o.plan ? o.plan.id : '—'})의 Target 수.`
          : '현재 Plan 이 없어 추천 엔진의 분석 단위(구역×요일×교통×조도×날씨) 수를 표시해요.' },
      { key: 'importCount', label: 'Import 파일', value: imports, display: imports == null ? '—' : `${imports}개`,
        basis: 'Import History 에 남은 파일 수(백업 복구로 들어온 묶음 포함).' },
      { key: 'progressPercent', label: '수집 목표 진행률', value: kpiRow ? round1(kpiRow.percent) : null,
        display: progress.rows.map(r => `${r.label} ${CS.formatPercent(r.percent)}`).join(' · ') || '—',
        basis: progress.rows.map(r => `${r.label} 목표 ${r.targetMinutes.toLocaleString('en-US')}분`).join(' · ')
          + ' 대비 유효 수집시간(collection-stats.js COLLECTION_TARGETS — 달력 "전체 데이터 수집 현황"과 같은 값).' },
    ];
    return {
      items,
      raw: {
        firstDate: first, lastDate: last, today, collectionDays: dated.length, vehicleDays,
        vehicleCount: vehicles.size, vehicles: [...vehicles].sort(), recordCount, distanceKm: round1(distanceKm),
        collectionMinutes: progress.collectedMinutes, driveMinutes: progress.driveMinutes,
        importCount: imports, activeZones, areaCount: areas.length, areasWithPolygon,
        progress: progress.rows.map(r => ({ key: r.key, label: r.label, percent: round1(r.percent), targetMinutes: r.targetMinutes })),
        missingSummaries: collection.missing,
      },
    };
  }

  // ══════════════════════════════════════════════════════
  //  2) Coverage Depth — 유효 칸의 방문 횟수(visitCounts)만 받는다
  //  visits: [칸별 방문 횟수] (누적 지도 computeZoneCoverageCells 의 valid 칸 visits)
  // ══════════════════════════════════════════════════════
  function depthFromVisits(visits, levels) {
    const lv = levels || DEPTH_LEVELS;
    const list = (visits || []).map(v => Number(v) || 0);
    const counts = {}, percent = {};
    lv.forEach(k => {
      counts[k] = list.filter(v => v >= k).length;
      percent[k] = list.length ? round1((counts[k] / list.length) * 100) : null;
    });
    return { total: list.length, counts, percent };
  }

  // 여러 구역을 합친 Depth — 칸 수로 가중(구역 평균의 평균이 아니다)
  function combineDepth(list, levels) {
    const lv = levels || DEPTH_LEVELS;
    let total = 0;
    const counts = {};
    lv.forEach(k => { counts[k] = 0; });
    (list || []).filter(d => d && d.total > 0).forEach(d => {
      total += d.total;
      lv.forEach(k => { counts[k] += (d.counts && d.counts[k]) || 0; });
    });
    const percent = {};
    lv.forEach(k => { percent[k] = total ? round1((counts[k] / total) * 100) : null; });
    return { total, counts, percent };
  }

  // ══════════════════════════════════════════════════════
  //  3) 측정값 — 구역(scope) 하나가 지금 얼마나 모였는가
  //   { totalMinutes, trafficPeriod:{id:분}, lightCondition:{id:분},
  //     maneuver:{id:{events,minutes}}|null, drivingState:{id:{minutes}}|null, roadContext:{id:{minutes}}|null,
  //     depth:{total,counts,percent}|null, notes:{...} }
  //   null = 이 구역 단위로는 집계가 없다(0 이 아니다 — "안 달렸다"와 "잴 수 없다"는 다른 말).
  // ══════════════════════════════════════════════════════
  const toMinutesMap = (rows, dim) => {
    const out = {};
    (rows || []).forEach(r => { if (r[dim] != null) out[r[dim]] = (out[r[dim]] || 0) + Math.round((r.collectionSec || 0) / 60); });
    return out;
  };

  // 운영 구역(날짜 요약의 zone 값) — ConditionStats 의 집계를 그대로 읽는다(추천과 같은 필터·LOW 제외 규칙)
  function measureZoneFromSummaries(summaries, zone, issueFilter) {
    const filter = { zone };
    const f = issueFilter === undefined ? CAREER_ISSUE_FILTER : issueFilter;
    if (f && f !== 'all') filter.issueFilter = f;
    const total = CSt.aggregate(summaries, { filter, groupBy: [] });
    const tp = CSt.aggregate(summaries, { filter, groupBy: ['trafficPeriod'] }).rows;
    const lc = CSt.aggregate(summaries, { filter, groupBy: ['lightCondition'] }).rows;
    const man = CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter, groupBy: ['egoManeuver'] }).rows;
    const st = CSt.aggregateAnalysis(summaries, { kind: 'maneuver', filter, groupBy: ['drivingState'] }).rows;
    const rc = CSt.aggregateAnalysis(summaries, { kind: 'roadContext', filter, groupBy: ['roadContext'] }).rows;
    const maneuver = {};
    man.forEach(r => { if (r.egoManeuver && r.egoManeuver !== 'UNKNOWN') maneuver[r.egoManeuver] = { events: r.eventCount || 0, minutes: Math.round((r.collectionSec || 0) / 60) }; });
    const drivingState = {};
    st.forEach(r => { if (r.drivingState && r.drivingState !== 'UNKNOWN') drivingState[r.drivingState] = { minutes: Math.round((r.collectionSec || 0) / 60) }; });
    const roadContext = {};
    rc.forEach(r => { if (r.roadContext && r.roadContext !== 'UNKNOWN') roadContext[r.roadContext] = { minutes: Math.round((r.collectionSec || 0) / 60) }; });
    return {
      scope: zone,
      totalMinutes: total.totals.collectionMinutes,
      recordCount: total.totals.recordCount,
      trafficPeriod: toMinutesMap(tp, 'trafficPeriod'),
      lightCondition: toMinutesMap(lc, 'lightCondition'),
      maneuver, drivingState, roadContext,
      depth: null,
      notes: {},
    };
  }

  // ①~⑫ — getSubZoneStats(aggregateSubZone) 한 구역 결과. Maneuver/Road Context 는 운영 구역 단위로만
  // 집계돼 있어서 이 구역 단위로는 "측정 불가"다(새 집계를 만들지 않는다).
  function measureAreaFromSubZoneStat(areaNo, stat) {
    const conditions = (stat && stat.conditions) || [];
    const tp = {}, lc = {};
    conditions.forEach(c => {
      const sec = c.collectionSec || 0;
      if (c.trafficPeriod) tp[c.trafficPeriod] = (tp[c.trafficPeriod] || 0) + sec;
      if (c.lightCondition) lc[c.lightCondition] = (lc[c.lightCondition] || 0) + sec;
    });
    const minutes = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Math.round(v / 60)]));
    const reason = 'Ego Maneuver·Road Context 는 운영 구역(강남 등) 단위로만 집계돼 있어 ①~⑫ 구역 단위로는 측정하지 않아요.';
    return {
      scope: String(areaNo),
      totalMinutes: stat ? Math.round((stat.collectionSec || 0) / 60) : 0,
      recordCount: stat ? (stat.recordCount || 0) : 0,
      trafficPeriod: minutes(tp),
      lightCondition: minutes(lc),
      maneuver: null, drivingState: null, roadContext: null,
      depth: null,
      notes: { maneuver: reason, drivingState: reason, roadContext: reason },
    };
  }

  // ══════════════════════════════════════════════════════
  //  4) Collection Plan — 버전이 쌓이는 목표 묶음
  //   수정은 덮어쓰기가 아니라 "새 버전"이다(previousVersionId 로 이어진다). 예전 버전은 지우지 않는다.
  // ══════════════════════════════════════════════════════
  const PLAN_TARGET_FIELDS = Object.freeze(['coverageTargets', 'coverageDepthTargets', 'maneuverTargets', 'drivingStateTargets', 'roadContextTargets', 'timeTargets']);

  // 추천 설정(recommendation.js effectiveRecommendationSettings)을 첫 Plan 의 출발점으로 복사한다.
  // 추천의 목표는 "조건 한 칸(구역×요일×교통×조도)"의 목표이고, Plan 은 "구역 전체 누적" 목표라 뜻이 다르다 —
  // 그래서 값을 그대로 쓰지 않고 초안으로만 채우고, 사용자가 고쳐 저장한다.
  function defaultPlanDraft(input) {
    const o = input || {};
    const rec = o.recommendationSettings || {};
    const priorityAreas = (o.priorityAreaNos || []).map(String);
    const zones = (o.operatingZones || []).map(String);
    const covDefault = rec.zoneCoverageTargets && Number.isFinite(rec.zoneCoverageTargets.default) ? rec.zoneCoverageTargets.default : 80;
    const covZones = (rec.zoneCoverageTargets && rec.zoneCoverageTargets.zones) || {};
    const plan = {
      title: '', validFrom: '', validTo: '', reason: '',
      priorityZones: priorityAreas.slice(),
      coverageTargets: {}, coverageDepthTargets: {}, maneuverTargets: {}, drivingStateTargets: {}, roadContextTargets: {}, timeTargets: {},
    };
    priorityAreas.forEach(a => {
      plan.coverageTargets[a] = covDefault;
      const tp = {};
      Object.entries(rec.periodTargets || {}).forEach(([id, t]) => { if (t && t.minutes > 0) tp[id] = t.minutes; });
      if (Object.keys(tp).length) plan.timeTargets[a] = { trafficPeriod: tp };
    });
    zones.forEach(z => {
      plan.coverageTargets[z] = Number.isFinite(covZones[z]) ? covZones[z] : covDefault;
      const m = {};
      ['LEFT_TURN', 'RIGHT_TURN', 'U_TURN'].forEach(id => { const t = (rec.maneuverTargets || {})[id]; if (t && t.events > 0) m[id] = { events: t.events }; });
      const s = (rec.maneuverTargets || {}).STRAIGHT; if (s && s.minutes > 0) m.STRAIGHT = { minutes: s.minutes };
      if (Object.keys(m).length) plan.maneuverTargets[z] = m;
      const rc = {};
      Object.entries(rec.roadContextTargets || {}).forEach(([id, t]) => { if (t && t.minutes > 0) rc[id] = { minutes: t.minutes }; });
      if (Object.keys(rc).length) plan.roadContextTargets[z] = rc;
    });
    return plan;
  }

  // Plan → 평평한 Target 목록 [{key, scope, kind, value, metric, target, priority, label}]
  function expandPlanTargets(plan) {
    const p = plan || {};
    const rows = [];
    const push = (scope, kind, value, metric, target) => {
      const t = Number(target);
      if (!Number.isFinite(t) || t <= 0) return;
      rows.push({ key: `${scope}|${kind}|${value}`, scope: String(scope), kind, value: String(value), metric, target: t, priority: targetPriority(p, scope) });
    };
    Object.entries(p.coverageTargets || {}).forEach(([scope, v]) => push(scope, 'coverageDepth', '1', 'percent', v));
    Object.entries(p.coverageDepthTargets || {}).forEach(([scope, byLevel]) => {
      Object.entries(byLevel || {}).forEach(([lv, v]) => { if (String(lv) !== '1') push(scope, 'coverageDepth', String(lv), 'percent', v); });
    });
    Object.entries(p.timeTargets || {}).forEach(([scope, t]) => {
      if (t && t.total != null) push(scope, 'totalTime', 'total', 'minutes', t.total);
      Object.entries((t && t.trafficPeriod) || {}).forEach(([id, v]) => push(scope, 'trafficPeriod', id, 'minutes', v));
      Object.entries((t && t.lightCondition) || {}).forEach(([id, v]) => push(scope, 'lightCondition', id, 'minutes', v));
    });
    Object.entries(p.maneuverTargets || {}).forEach(([scope, byId]) => {
      Object.entries(byId || {}).forEach(([id, t]) => {
        if (t && t.events != null) push(scope, 'maneuver', id, 'events', t.events);
        else if (t && t.minutes != null) push(scope, 'maneuver', id, 'minutes', t.minutes);
      });
    });
    Object.entries(p.drivingStateTargets || {}).forEach(([scope, byId]) => {
      Object.entries(byId || {}).forEach(([id, t]) => push(scope, 'drivingState', id, 'minutes', t && t.minutes));
    });
    Object.entries(p.roadContextTargets || {}).forEach(([scope, byId]) => {
      Object.entries(byId || {}).forEach(([id, t]) => push(scope, 'roadContext', id, 'minutes', t && t.minutes));
    });
    const kindOrder = k => TARGET_KIND_IDS.indexOf(k);
    return rows.sort((a, b) => scopeSort(a.scope, b.scope) || (kindOrder(a.kind) - kindOrder(b.kind)) || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }

  // 편집 화면의 평평한 목록 → Plan 의 묶음 필드(expandPlanTargets 의 반대)
  function collapseTargetRows(rows) {
    const out = { coverageTargets: {}, coverageDepthTargets: {}, maneuverTargets: {}, drivingStateTargets: {}, roadContextTargets: {}, timeTargets: {} };
    (rows || []).forEach(r => {
      const scope = str(r.scope), value = str(r.value), t = Number(num(r.target));
      if (!scope || !Number.isFinite(t) || t <= 0) return;
      const time = () => (out.timeTargets[scope] = out.timeTargets[scope] || {});
      switch (r.kind) {
        case 'coverageDepth':
          if (value === '1') out.coverageTargets[scope] = t;
          else (out.coverageDepthTargets[scope] = out.coverageDepthTargets[scope] || {})[value] = t;
          break;
        case 'totalTime': time().total = t; break;
        case 'trafficPeriod': (time().trafficPeriod = time().trafficPeriod || {})[value] = t; break;
        case 'lightCondition': (time().lightCondition = time().lightCondition || {})[value] = t; break;
        case 'maneuver':
          (out.maneuverTargets[scope] = out.maneuverTargets[scope] || {})[value] = MANEUVER_DURATION_IDS.includes(value) || r.metric === 'minutes' ? { minutes: t } : { events: t };
          break;
        case 'drivingState': (out.drivingStateTargets[scope] = out.drivingStateTargets[scope] || {})[value] = { minutes: t }; break;
        case 'roadContext': (out.roadContextTargets[scope] = out.roadContextTargets[scope] || {})[value] = { minutes: t }; break;
        default: break;
      }
    });
    return out;
  }

  // Target 의 우선순위 — Plan 의 priorityZones 첫 번째 구역 = high, 나머지 priorityZones = medium, 그 밖 = low
  function targetPriority(plan, scope) {
    const list = ((plan && plan.priorityZones) || []).map(String);
    const i = list.indexOf(String(scope));
    if (i === 0) return 'high';
    if (i > 0) return 'medium';
    return 'low';
  }

  function metricOf(kind, value) {
    if (kind === 'coverageDepth') return 'percent';
    if (kind === 'maneuver' && MANEUVER_EVENT_IDS.includes(value)) return 'events';
    return 'minutes';
  }

  function validatePlan(input) {
    const p = input || {};
    const errors = [];
    const title = str(p.title);
    if (!title) errors.push('Plan 제목을 입력해주세요.');
    const validFrom = str(p.validFrom), validTo = str(p.validTo);
    if (validFrom && !isDate(validFrom)) errors.push('시작일은 YYYY-MM-DD 형식이어야 해요.');
    if (validTo && !isDate(validTo)) errors.push('종료일은 YYYY-MM-DD 형식이어야 해요.');
    if (isDate(validFrom) && isDate(validTo) && validFrom > validTo) errors.push('시작일이 종료일보다 늦어요.');
    const priorityZones = [...new Set((Array.isArray(p.priorityZones) ? p.priorityZones : String(p.priorityZones || '').split(','))
      .map(str).filter(Boolean))];
    const groups = {};
    PLAN_TARGET_FIELDS.forEach(f => { groups[f] = p[f] && typeof p[f] === 'object' ? clone(p[f]) : {}; });
    expandPlanTargets({ ...groups, priorityZones }).forEach(t => {
      if (t.metric === 'percent' && t.target > 100) errors.push(`${scopeLabel(t.scope)} ${t.value}x Coverage 목표는 100% 이하여야 해요.`);
    });
    const bad = [];
    const walk = (obj, path) => Object.entries(obj || {}).forEach(([k, v]) => {
      if (v && typeof v === 'object') walk(v, path.concat(k));
      else { const n = Number(num(v)); if (!Number.isFinite(n) || n < 0) bad.push(path.concat(k).join('.')); }
    });
    PLAN_TARGET_FIELDS.forEach(f => walk(groups[f], [f]));
    if (bad.length) errors.push(`목표값은 0 이상의 숫자여야 해요: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''}`);
    if (errors.length) return { ok: false, errors, value: null };
    return {
      ok: true, errors: [],
      value: { title, validFrom, validTo, reason: str(p.reason), priorityZones, ...groups },
    };
  }

  // 같은 달에 Plan 이 여러 개면 PLAN-2026-10, PLAN-2026-10b, PLAN-2026-10c …
  function newPlanSeriesId(existingPlans, validFrom, nowIso) {
    const ym = (isDate(validFrom) ? validFrom : String(nowIso || new Date().toISOString()).slice(0, 10)).slice(0, 7);
    const used = new Set((existingPlans || []).map(p => p && p.seriesId).filter(Boolean));
    const base = `PLAN-${ym}`;
    if (!used.has(base)) return base;
    for (let i = 1; i < 26; i++) {
      const id = base + String.fromCharCode(97 + i);
      if (!used.has(id)) return id;
    }
    return `${base}-${Date.parse(nowIso || new Date().toISOString()) || Date.now()}`;
  }

  // 새 Plan(v1)
  function createPlan(input, existingPlans, nowIso) {
    const v = validatePlan(input);
    if (!v.ok) return v;
    const now = nowIso || new Date().toISOString();
    const seriesId = newPlanSeriesId(existingPlans, v.value.validFrom, now);
    return {
      ok: true, errors: [],
      value: {
        ...v.value, id: `${seriesId}-v1`, seriesId, version: 1, createdAt: now,
        previousVersionId: null, changeReason: str(input && input.changeReason) || '최초 작성', localOnly: true,
      },
    };
  }

  // 기존 버전을 고치면 새 버전이 생긴다 — 변경 사유 필수, 이전 버전은 그대로 남는다
  function revisePlan(previous, input, nowIso) {
    if (!previous || !previous.id) return { ok: false, errors: ['이전 버전이 없어요.'], value: null };
    const changeReason = str(input && input.changeReason);
    const v = validatePlan(input);
    const errors = v.ok ? [] : v.errors.slice();
    if (!changeReason) errors.push('변경 사유를 입력해주세요 — 나중에 왜 목표를 바꿨는지 남기기 위한 칸이에요.');
    if (errors.length) return { ok: false, errors, value: null };
    const version = (Number(previous.version) || 1) + 1;
    const seriesId = previous.seriesId || String(previous.id).replace(/-v\d+$/, '');
    return {
      ok: true, errors: [],
      value: {
        ...v.value, id: `${seriesId}-v${version}`, seriesId, version, createdAt: nowIso || new Date().toISOString(),
        previousVersionId: previous.id, changeReason, localOnly: true,
      },
    };
  }

  // 다른 버전이 이어받은 버전(= 예전 버전)인가
  function supersededIds(plans) {
    return new Set((plans || []).map(p => p && p.previousVersionId).filter(Boolean));
  }

  // date 에 적용되는 Plan — 각 계열의 최신 버전 중 기간이 date 를 포함하는 것, 여럿이면 가장 최근에 만든 것.
  // 기간을 비워 두면 그쪽 끝은 제한 없음.
  function activePlanFor(plans, date) {
    const sup = supersededIds(plans);
    const d = isDate(date) ? date : null;
    const live = (plans || []).filter(p => p && p.id && !sup.has(p.id))
      .filter(p => !d || ((!p.validFrom || p.validFrom <= d) && (!p.validTo || p.validTo >= d)));
    return live.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }

  // 계열별 버전 목록(최신 계열 먼저, 버전은 최신 먼저)
  function planHistory(plans) {
    const bySeries = new Map();
    (plans || []).filter(p => p && p.id).forEach(p => {
      const s = p.seriesId || String(p.id).replace(/-v\d+$/, '');
      if (!bySeries.has(s)) bySeries.set(s, []);
      bySeries.get(s).push(p);
    });
    return [...bySeries.entries()].map(([seriesId, versions]) => {
      versions.sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
      return { seriesId, latest: versions[0], versions };
    }).sort((a, b) => String(b.latest.createdAt || '').localeCompare(String(a.latest.createdAt || '')));
  }

  // 두 버전의 Target 차이 — 버전 기록 화면에서 "무엇을 바꿨는지"
  function diffPlanTargets(prev, next) {
    const a = new Map(expandPlanTargets(prev).map(t => [t.key, t]));
    const b = new Map(expandPlanTargets(next).map(t => [t.key, t]));
    const added = [], removed = [], changed = [];
    b.forEach((t, k) => { if (!a.has(k)) added.push(t); else if (a.get(k).target !== t.target) changed.push({ ...t, from: a.get(k).target }); });
    a.forEach((t, k) => { if (!b.has(k)) removed.push(t); });
    return { added, removed, changed };
  }

  // ══════════════════════════════════════════════════════
  //  5) Scenario Fulfillment — Target 하나하나를 측정값과 맞춰 본다
  // ══════════════════════════════════════════════════════
  function evaluateTarget(t, measurements) {
    const m = measurements && measurements[t.scope];
    const base = { ...t, current: null, percent: null, achieved: false, measurable: false, reason: null };
    if (!m) return { ...base, reason: '이 구역의 측정값이 없어요(경계 미설정이거나 구역이 비활성).' };
    let current = null, reason = null;
    switch (t.kind) {
      case 'coverageDepth': {
        const level = Number(t.value);
        if (!m.depth || !(m.depth.total > 0)) { reason = (m.notes && m.notes.depth) || 'Coverage 가 계산되지 않았어요.'; break; }
        if (m.depth.percent[level] == null) { reason = `${t.value}x Depth 는 계산 단계(${DEPTH_LEVELS.join('·')}x)에 없어요.`; break; }
        current = m.depth.percent[level];
        break;
      }
      case 'totalTime': current = m.totalMinutes || 0; break;
      case 'trafficPeriod': current = (m.trafficPeriod && m.trafficPeriod[t.value]) || 0; break;
      case 'lightCondition': current = (m.lightCondition && m.lightCondition[t.value]) || 0; break;
      case 'maneuver': {
        if (!m.maneuver) { reason = m.notes && m.notes.maneuver; break; }
        const row = m.maneuver[t.value];
        if (!row && OPTIONAL_MANEUVER_IDS.includes(t.value)) { reason = `${t.value} 는 이 구역에서 확인된 적이 없어 목표로 보지 않아요(추천과 같은 규칙).`; break; }
        current = row ? (t.metric === 'events' ? row.events : row.minutes) : 0;
        break;
      }
      case 'drivingState':
        if (!m.drivingState) { reason = m.notes && m.notes.drivingState; break; }
        current = (m.drivingState[t.value] && m.drivingState[t.value].minutes) || 0;
        break;
      case 'roadContext':
        if (!m.roadContext) { reason = m.notes && m.notes.roadContext; break; }
        if (!m.roadContext[t.value]) { reason = `이 구역에서 확인된 ${t.value} 가 없어요 — 지도 데이터가 없는 것과 덜 모은 것을 구분하려고 미달로 세지 않아요(추천과 같은 규칙).`; break; }
        current = m.roadContext[t.value].minutes || 0;
        break;
      default: reason = `알 수 없는 Target 종류(${t.kind})예요.`;
    }
    if (current == null) return { ...base, reason: reason || '측정할 수 없어요.' };
    const percent = round1(pct(current, t.target));
    return { ...base, current, percent, achieved: current >= t.target, measurable: true };
  }

  function evaluatePlan(plan, measurements) {
    const rows = expandPlanTargets(plan).map(t => evaluateTarget(t, measurements));
    return { rows, summary: summarizeFulfillment(rows, plan) };
  }

  function summarizeFulfillment(rows, plan) {
    const measurable = (rows || []).filter(r => r.measurable);
    const achieved = measurable.filter(r => r.achieved).length;
    const byPriority = {};
    PRIORITY_IDS.forEach(id => {
      const list = measurable.filter(r => r.priority === id);
      const a = list.filter(r => r.achieved).length;
      byPriority[id] = { total: list.length, achieved: a, deficit: list.length - a };
    });
    const pz = new Set(((plan && plan.priorityZones) || []).map(String));
    const inPz = measurable.filter(r => pz.has(r.scope));
    const pzAchieved = inPz.filter(r => r.achieved).length;
    return {
      total: measurable.length,
      achieved,
      deficit: measurable.length - achieved,
      percent: measurable.length ? round1((achieved / measurable.length) * 100) : null,
      unmeasurable: (rows || []).length - measurable.length,
      planned: (rows || []).length,
      byPriority,
      priorityZone: { total: inPz.length, achieved: pzAchieved, percent: inPz.length ? round1((pzAchieved / inPz.length) * 100) : null },
    };
  }

  // 추천 엔진이 이미 계산한 부족 조건 — priority band 로만 센다(점수를 다시 매기지 않는다).
  // total = "보통" 이상(점수 40+, 추천 카드의 deficitConditions 와 같은 경계)
  function recommendationDeficitCounts(result) {
    const counts = { veryHigh: 0, high: 0, medium: 0, low: 0 };
    ((result && result.recommendations) || []).forEach(r => {
      if (r.priority === 'very_high') counts.veryHigh++;
      else if (r.priority === 'high') counts.high++;
      else if (r.priority === 'medium') counts.medium++;
      else if (r.priority === 'low') counts.low++;
    });
    return { ...counts, total: counts.veryHigh + counts.high + counts.medium, candidates: ((result && result.recommendations) || []).length };
  }

  // ══════════════════════════════════════════════════════
  //  6) KPI Snapshot — 하루 한 줄(같은 날짜는 최신으로 갱신)
  // ══════════════════════════════════════════════════════
  const SNAPSHOT_FIELDS = Object.freeze([
    'date', 'planId', 'recordCount', 'collectionDays', 'vehicleCount', 'distanceKm', 'collectionMinutes', 'driveMinutes',
    'coverage1x', 'coverage3x', 'coverage5x', 'coverage10x',
    'targetTotal', 'targetAchieved', 'targetDeficit', 'fulfillmentPercent', 'priorityZoneAchievementPercent',
    'deficitHigh', 'deficitMedium', 'deficitLow',
    'recDeficitTotal', 'recDeficitVeryHigh', 'recDeficitHigh', 'recDeficitMedium',
  ]);

  // input: {date, plan, scale(raw), depth(combined, priority zones), depthByScope, fulfillment(summary), recDeficits, source, nowIso, previous}
  function buildKpiSnapshot(input) {
    const o = input || {};
    const s = o.scale || {};
    const d = o.depth || { percent: {} };
    const f = o.fulfillment || null;
    const r = o.recDeficits || null;
    const now = o.nowIso || new Date().toISOString();
    const prev = o.previous || null;
    const date = isDate(o.date) ? o.date : now.slice(0, 10);
    const byScope = {};
    Object.entries(o.depthByScope || {}).forEach(([scope, v]) => {
      if (v && v.total > 0) byScope[scope] = { total: v.total, percent: v.percent };
    });
    return {
      id: date,
      date,
      planId: o.plan ? o.plan.id : null,
      recordCount: s.recordCount || 0,
      collectionDays: s.collectionDays || 0,
      vehicleCount: s.vehicleCount || 0,
      distanceKm: s.distanceKm || 0,
      collectionMinutes: s.collectionMinutes || 0,
      driveMinutes: s.driveMinutes || 0,
      coverage1x: d.percent[1] != null ? d.percent[1] : null,
      coverage3x: d.percent[3] != null ? d.percent[3] : null,
      coverage5x: d.percent[5] != null ? d.percent[5] : null,
      coverage10x: d.percent[10] != null ? d.percent[10] : null,
      coverageCells: d.total || 0,
      coverageScopes: o.depthScopes || [],
      coverageByScope: byScope,
      targetTotal: f ? f.total : null,
      targetAchieved: f ? f.achieved : null,
      targetDeficit: f ? f.deficit : null,
      targetUnmeasurable: f ? f.unmeasurable : null,
      fulfillmentPercent: f ? f.percent : null,
      priorityZoneAchievementPercent: f ? f.priorityZone.percent : null,
      deficitHigh: f ? f.byPriority.high.deficit : null,
      deficitMedium: f ? f.byPriority.medium.deficit : null,
      deficitLow: f ? f.byPriority.low.deficit : null,
      recDeficitTotal: r ? r.total : null,
      recDeficitVeryHigh: r ? r.veryHigh : null,
      recDeficitHigh: r ? r.high : null,
      recDeficitMedium: r ? r.medium : null,
      issueBasis: CAREER_ISSUE_FILTER,
      source: str(o.source) || 'manual',
      createdAt: prev && prev.createdAt ? prev.createdAt : now,
      updatedAt: now,
      updateCount: prev ? (Number(prev.updateCount) || 1) + 1 : 1,
      version: CAREER_VERSION,
      localOnly: true,
    };
  }

  // ══════════════════════════════════════════════════════
  //  6-1) 기본 화면(Notebook) — 이번 달 규모 · 월초 대비 변화
  // ══════════════════════════════════════════════════════
  function monthStartOf(date) { return isDate(date) ? String(date).slice(0, 8) + '01' : null; }

  // 이번 달(1일 ~ today) 날짜 요약만으로 센 규모 — buildProjectScale 과 같은 규칙
  function buildMonthScale(summaries, today) {
    const from = monthStartOf(today);
    const inMonth = (summaries || []).filter(s => s && isDate(s.date) && s.date >= from && s.date <= today);
    const r = buildProjectScale({ summaries: inMonth, today }).raw;
    return {
      from, to: today, distanceKm: r.distanceKm, collectionMinutes: r.collectionMinutes,
      collectionDays: r.collectionDays, vehicleCount: r.vehicleCount, recordCount: r.recordCount,
    };
  }

  // 월초 → 현재. 기준 = 이번 달 1일 전의 마지막 Snapshot, 없으면 이번 달 첫 Snapshot.
  // 현재 = 가장 최근 Snapshot. Snapshot 에 값이 없는 지표는 null(0 으로 채우지 않는다).
  function monthlyImpact(snapshots, today) {
    const from = monthStartOf(today);
    const snaps = sortSnapshots(snapshots).filter(s => !today || s.date <= today);
    const pick = field => {
      const series = snaps.filter(s => Number.isFinite(s[field]));
      if (!series.length) return null;
      const before = series.filter(s => s.date < from);
      const base = before.length ? before[before.length - 1] : series.find(s => s.date >= from);
      const cur = series[series.length - 1];
      if (!base) return null;
      return {
        from: round1(base[field]), to: round1(cur[field]), delta: round1(cur[field] - base[field]),
        fromDate: base.date, toDate: cur.date, single: base === cur,
      };
    };
    return {
      monthStart: from,
      coverage5x: pick('coverage5x'),
      fulfillment: pick('fulfillmentPercent'),
      deficit: pick('targetDeficit'),
    };
  }

  // "오늘 내가 한 일" 한 줄 기록 — Contribution Log 항목 하나로 저장한다(따로 저장 영역을 만들지 않는다).
  // memo 는 기존 problem 칸에도 넣어서 상세 편집·Export·예전 화면이 그대로 읽는다.
  // 저장 시점 KPI(오늘 Snapshot 값)를 kpiAtSave 로 붙인다.
  function buildQuickNote(input, nowIso) {
    const o = input || {};
    const memo = String(o.memo == null ? '' : o.memo).replace(/\r\n/g, '\n').trim();
    const s = o.snapshot || {};
    const date = isDate(o.date) ? o.date : (isDate(s.date) ? s.date : String(nowIso || new Date().toISOString()).slice(0, 10));
    const v = normalizeContribution({ date, problem: memo, planId: s.planId || '' }, null, nowIso);
    if (!v.ok) return { ok: false, errors: memo ? v.errors : ['기록할 내용을 입력해주세요.'], value: null };
    const num = x => (Number.isFinite(x) ? x : null);
    return {
      ok: true, errors: [],
      value: {
        ...v.value,
        entryType: 'quick',
        memo,
        kpiAtSave: {
          snapshotDate: s.date || null,
          coverage1x: num(s.coverage1x), coverage3x: num(s.coverage3x), coverage5x: num(s.coverage5x), coverage10x: num(s.coverage10x),
          fulfillmentPercent: num(s.fulfillmentPercent), targetDeficit: num(s.targetDeficit), recDeficitTotal: num(s.recDeficitTotal),
          collectionMinutes: num(s.collectionMinutes), distanceKm: num(s.distanceKm), planId: s.planId || null,
        },
      },
    };
  }

  function sortSnapshots(list) {
    return (list || []).filter(s => s && isDate(s.date)).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // 시간축 그래프용 [{x:date, y}] — 값이 없는 날은 뺀다(0 으로 그리지 않는다)
  function snapshotSeries(list, field) {
    return sortSnapshots(list).filter(s => Number.isFinite(s[field])).map(s => ({ x: s.date, y: s[field] }));
  }

  function deficitHistory(list) {
    return sortSnapshots(list).filter(s => Number.isFinite(s.targetDeficit) || Number.isFinite(s.recDeficitTotal)).map(s => ({
      date: s.date, planId: s.planId, total: s.targetDeficit, high: s.deficitHigh, medium: s.deficitMedium, low: s.deficitLow,
      recTotal: s.recDeficitTotal,
    }));
  }

  // ══════════════════════════════════════════════════════
  //  7) Contribution Log · Work Time Log (사용자가 직접 쓰는 기록)
  // ══════════════════════════════════════════════════════
  const CONTRIBUTION_FIELDS = Object.freeze(['date', 'problem', 'analysis', 'decision', 'implementation', 'result', 'zones', 'features', 'planId', 'quantResult']);

  function splitList(v) {
    if (Array.isArray(v)) return [...new Set(v.map(str).filter(Boolean))];
    return [...new Set(String(v || '').split(/[,\n]/).map(str).filter(Boolean))];
  }

  function normalizeContribution(input, previous, nowIso) {
    const p = input || {};
    const errors = [];
    const date = str(p.date);
    if (!isDate(date)) errors.push('날짜(YYYY-MM-DD)를 입력해주세요.');
    if (!str(p.problem)) errors.push('문제 / 요구사항을 입력해주세요.');
    if (errors.length) return { ok: false, errors, value: null };
    const now = nowIso || new Date().toISOString();
    const id = str(previous && previous.id) || str(p.id) || `C-${compactDate(date)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      ok: true, errors: [],
      value: {
        id, date,
        problem: str(p.problem), analysis: str(p.analysis), decision: str(p.decision),
        implementation: str(p.implementation), result: str(p.result),
        zones: splitList(p.zones), features: splitList(p.features),
        planId: str(p.planId) || null, quantResult: str(p.quantResult),
        createdAt: (previous && previous.createdAt) || p.createdAt || now, updatedAt: now,
        // 한 줄 기록(buildQuickNote)을 상세 화면에서 고쳐도 저장 당시 KPI 는 그대로 남긴다
        ...(previous && previous.entryType ? { entryType: previous.entryType } : {}),
        ...(previous && previous.entryType === 'quick' ? { memo: str(p.problem) } : {}),
        ...(previous && previous.kpiAtSave ? { kpiAtSave: previous.kpiAtSave } : {}),
        localOnly: true,
      },
    };
  }

  function sortContributions(list, order) {
    const dir = order === 'desc' ? -1 : 1;
    return (list || []).filter(Boolean).slice().sort((a, b) =>
      (a.date < b.date ? -dir : a.date > b.date ? dir : 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) * dir);
  }

  function normalizeWorkTime(input, previous, nowIso) {
    const p = input || {};
    const errors = [];
    const task = str(p.task);
    const mode = str(p.mode);
    const minutes = Number(num(p.minutes));
    const date = str(p.date);
    if (!task) errors.push('작업 이름(Task)을 입력해주세요.');
    if (!Object.prototype.hasOwnProperty.call(WORK_MODES, mode)) errors.push('방식(Manual / Route Viewer)을 골라주세요.');
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) errors.push('소요 시간은 0 초과 1440 이하의 분이어야 해요.');
    if (!isDate(date)) errors.push('측정 날짜(YYYY-MM-DD)를 입력해주세요.');
    if (errors.length) return { ok: false, errors, value: null };
    const now = nowIso || new Date().toISOString();
    return {
      ok: true, errors: [],
      value: {
        id: str(previous && previous.id) || str(p.id) || `W-${compactDate(date)}-${Math.random().toString(36).slice(2, 8)}`,
        task, mode, minutes: round1(minutes), date, note: str(p.note),
        createdAt: (previous && previous.createdAt) || p.createdAt || now, updatedAt: now, localOnly: true,
      },
    };
  }

  // 사용자가 직접 잰 값만 쓴다 — 빈 칸을 추정하거나 채우지 않는다. 한쪽 방식 측정이 없으면 감소율도 없다.
  function workTimeStats(entries) {
    const byTask = new Map();
    (entries || []).filter(e => e && e.task && WORK_MODES[e.mode] && Number.isFinite(e.minutes)).forEach(e => {
      if (!byTask.has(e.task)) byTask.set(e.task, { manual: [], route_viewer: [] });
      byTask.get(e.task)[e.mode].push(e.minutes);
    });
    const stat = list => ({ n: list.length, avg: list.length ? round1(list.reduce((a, b) => a + b, 0) / list.length) : null, min: list.length ? Math.min(...list) : null, max: list.length ? Math.max(...list) : null });
    return [...byTask.entries()].map(([task, m]) => {
      const manual = stat(m.manual), tool = stat(m.route_viewer);
      const reductionPercent = manual.n && tool.n && manual.avg > 0 ? round1(((manual.avg - tool.avg) / manual.avg) * 100) : null;
      return { task, manual, routeViewer: tool, reductionPercent, comparable: reductionPercent != null };
    }).sort((a, b) => (b.manual.n + b.routeViewer.n) - (a.manual.n + a.routeViewer.n) || (a.task < b.task ? -1 : 1));
  }

  // ══════════════════════════════════════════════════════
  //  8) Impact Summary(화면 이름, 예전 Resume Metrics) — 숫자와 사실만(문장을 만들지 않는다)
  // ══════════════════════════════════════════════════════
  function firstLast(series) {
    if (!series.length) return null;
    const a = series[0], b = series[series.length - 1];
    return { from: a.y, to: b.y, fromDate: a.x, toDate: b.x, points: series.length };
  }

  function buildResumeMetrics(input) {
    const o = input || {};
    const s = (o.scale && o.scale.raw) || o.scale || {};
    const snaps = o.snapshots || [];
    const fmt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
    const scale = [];
    if (s.vehicleCount) scale.push({ label: '차량', value: `${s.vehicleCount}대` });
    if (s.collectionDays) scale.push({ label: '수집 일수', value: `${s.collectionDays}일` });
    if (s.firstDate) scale.push({ label: '운영 기간', value: `${s.firstDate} ~ ${s.today || s.lastDate}` });
    if (s.distanceKm) scale.push({ label: '총 주행거리', value: `${fmt(s.distanceKm)} km` });
    if (s.collectionMinutes) scale.push({ label: '유효 수집시간', value: `${fmt(s.collectionMinutes)} min` });
    if (s.recordCount) scale.push({ label: 'GPS Records', value: fmt(s.recordCount) });

    const coverage = [];
    const change = (label, field, unit) => {
      const series = snapshotSeries(snaps, field).map(p => ({ ...p, y: round1(p.y) })); // 가져온 값의 부동소수 꼬리는 표시하지 않는다
      const fl = firstLast(series);
      if (!fl) return;
      const u = unit || '';
      coverage.push({
        label,
        value: fl.points > 1 ? `${fl.from}${u} → ${fl.to}${u}` : `${fl.to}${u}`,
        from: fl.from, to: fl.to, fromDate: fl.fromDate, toDate: fl.toDate, points: fl.points,
      });
    };
    change('Priority Zone 1x Coverage', 'coverage1x', '%');
    change('Priority Zone 3x Coverage', 'coverage3x', '%');
    change('Priority Zone 5x Coverage', 'coverage5x', '%');
    change('Scenario Fulfillment', 'fulfillmentPercent', '%');
    change('Priority Zone Target 달성률', 'priorityZoneAchievementPercent', '%');
    change('Deficit Targets', 'targetDeficit', '');

    const automation = (o.workStats || []).filter(w => w.comparable).map(w => ({
      label: w.task,
      value: `${w.manual.avg} min → ${w.routeViewer.avg} min (${w.reductionPercent}% 감소)`,
      manual: w.manual, routeViewer: w.routeViewer, reductionPercent: w.reductionPercent,
    }));

    // "내 기여" 영역 — 사용자가 Contribution Log 의 "관련 기능"에 직접 적은 것만 모은다(자동 생성 문구 없음)
    const featureCount = new Map();
    (o.contributions || []).forEach(c => (c.features || []).forEach(f => featureCount.set(f, (featureCount.get(f) || 0) + 1)));
    const contribution = [...featureCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([label, n]) => ({ label, value: `${n}건` }));

    return { scale, coverage, automation, contribution, contributionCount: (o.contributions || []).length };
  }

  // ══════════════════════════════════════════════════════
  //  9) Export — 집계 수치와 직접 쓴 기록만. 원본 GPS 좌표는 싣지 않는다.
  // ══════════════════════════════════════════════════════
  const GEO_KEYS = new Set(['lat', 'lng', 'latitude', 'longitude', 'polygon', 'points', 'coords', 'coordinates', 'geometry', 'center', 'start', 'end', 'cells', 'data']);

  function stripGeoFields(value) {
    if (Array.isArray(value)) return value.map(stripGeoFields);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    Object.keys(value).forEach(k => { if (!GEO_KEYS.has(k)) out[k] = stripGeoFields(value[k]); });
    return out;
  }

  function exportFileNames(date) {
    const d = compactDate(isDate(date) ? date : new Date().toISOString().slice(0, 10));
    return { json: `career-log-${d}.json`, csv: `career-metrics-${d}.csv`, md: `career-summary-${d}.md` };
  }

  function buildExportPayload(input) {
    const o = input || {};
    return stripGeoFields({
      type: EXPORT_TYPE,
      version: CAREER_VERSION,
      exportedAt: o.nowIso || new Date().toISOString(),
      localOnly: true,
      note: '집계 수치와 직접 작성한 기록만 포함합니다. 원본 GPS 좌표는 포함하지 않습니다.',
      projectScale: o.scale ? o.scale.raw : null,
      kpiSnapshots: sortSnapshots(o.snapshots),
      collectionPlans: (o.plans || []).slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
      contributions: sortContributions(o.contributions, 'asc'),
      workTimes: (o.workTimes || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      workTimeStats: o.workStats || [],
      resumeMetrics: o.resume || null,
    });
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // KPI Snapshot 을 날짜별 한 줄 — 엑셀에서 한글이 깨지지 않게 BOM 을 붙인다
  function toMetricsCsv(snapshots) {
    const rows = sortSnapshots(snapshots);
    const lines = [SNAPSHOT_FIELDS.join(',')];
    rows.forEach(s => lines.push(SNAPSHOT_FIELDS.map(f => csvCell(s[f])).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function mdEscape(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

  function toSummaryMarkdown(input) {
    const o = input || {};
    const r = o.resume || buildResumeMetrics(o);
    const lines = [];
    lines.push(`# Project Impact Summary`);
    lines.push('');
    lines.push(`- 작성: ${String(o.nowIso || new Date().toISOString()).slice(0, 10)} · Route Viewer Career Log (로컬 기록)`);
    lines.push('- 원본 GPS 좌표는 포함하지 않습니다.');
    const section = (title, list) => {
      lines.push('', `## ${title}`, '');
      if (!list.length) { lines.push('- (기록 없음)'); return; }
      list.forEach(x => lines.push(`- ${mdEscape(x.label)}: ${mdEscape(x.value)}`));
    };
    section('PROJECT SCALE', r.scale);
    section('DATA COVERAGE', r.coverage);
    section('AUTOMATION', r.automation);
    section('MY CONTRIBUTION (관련 기능별 기록 수)', r.contribution);
    const contribs = sortContributions(o.contributions, 'asc');
    if (contribs.length) {
      lines.push('', '## Decision / Contribution Log', '');
      contribs.forEach(c => {
        lines.push(`### ${c.date} — ${mdEscape(c.problem)}`);
        [['분석', c.analysis], ['결정/제안', c.decision], ['구현', c.implementation], ['결과', c.result], ['정량 결과', c.quantResult],
          ['관련 Zone', (c.zones || []).join(', ')], ['관련 기능', (c.features || []).join(', ')], ['관련 Plan', c.planId]]
          .filter(([, v]) => v).forEach(([k, v]) => lines.push(`- ${k}: ${mdEscape(v)}`));
        const a = c.kpiAtSave;
        if (a) {
          const p = v => (Number.isFinite(v) ? `${v}%` : '—');
          lines.push(`- 저장 당시: 5x Coverage ${p(a.coverage5x)} · Fulfillment ${p(a.fulfillmentPercent)} · Deficit ${Number.isFinite(a.targetDeficit) ? a.targetDeficit : '—'}${a.planId ? ` · ${a.planId}` : ''}`);
        }
        lines.push('');
      });
    }
    const hist = deficitHistory(o.snapshots);
    if (hist.length) {
      lines.push('', '## Deficit History', '', '| 날짜 | 미달 Target | High | Medium | Low |', '|---|---:|---:|---:|---:|');
      hist.forEach(h => lines.push(`| ${h.date} | ${h.total ?? ''} | ${h.high ?? ''} | ${h.medium ?? ''} | ${h.low ?? ''} |`));
    }
    return lines.join('\n') + '\n';
  }

  // 이전에 Export 한 JSON 을 되돌려 넣기 — 같은 id 는 Plan 이면 그대로 둔다(버전은 바뀌지 않는 기록),
  // 나머지는 updatedAt 이 더 최신인 쪽이 이긴다. → {kind: [저장할 항목]}
  function planCareerImport(payload, existing) {
    if (!payload || payload.type !== EXPORT_TYPE) throw new Error('Career Log Export 파일이 아니에요.');
    const cur = existing || {};
    const pick = (kind, list, keepExisting) => {
      const have = new Map((cur[kind] || []).map(x => [x.id, x]));
      return (list || []).filter(x => x && x.id).filter(x => {
        const old = have.get(x.id);
        if (!old) return true;
        if (keepExisting) return false;
        return String(x.updatedAt || '') > String(old.updatedAt || '');
      }).map(x => ({ ...stripGeoFields(x), localOnly: true }));
    };
    return {
      kpiSnapshots: pick('kpiSnapshots', payload.kpiSnapshots, false),
      collectionPlans: pick('collectionPlans', payload.collectionPlans, true),
      contributions: pick('contributions', payload.contributions, false),
      workTimes: pick('workTimes', payload.workTimes, false),
    };
  }

  // 저장소(SQLite/IndexedDB)가 받는 항목 검사 — id 와 local-only 표시만 강제한다(내용 검증은 위 normalize* 가 한다)
  function normalizeStoredItem(kind, item) {
    if (!CAREER_KINDS[kind]) throw new Error(`알 수 없는 Career Log 영역이에요(${kind}).`);
    if (!item || typeof item !== 'object') throw new Error('저장할 항목이 없어요.');
    const id = str(item.id);
    if (!id) throw new Error('항목 id 가 없어요.');
    const clean = stripGeoFields(clone(item));
    return { ...clean, id, localOnly: true };
  }

  function storedSortKey(kind, item) {
    if (kind === 'collectionPlans') return String(item.createdAt || '');
    return String(item.date || item.createdAt || '');
  }

  return {
    CAREER_VERSION, EXPORT_TYPE, CAREER_KINDS, CAREER_KIND_IDS, CAREER_ISSUE_FILTER,
    DEPTH_LEVELS, AREA_NOS, TARGET_KINDS, TARGET_KIND_IDS, PRIORITY_IDS, PRIORITY_LABELS, WORK_MODES,
    MANEUVER_EVENT_IDS, MANEUVER_DURATION_IDS, SNAPSHOT_FIELDS, CONTRIBUTION_FIELDS, PLAN_TARGET_FIELDS,
    isDate, isAreaScope, scopeLabel, scopeSort, daysBetweenInclusive,
    buildProjectScale,
    depthFromVisits, combineDepth,
    measureZoneFromSummaries, measureAreaFromSubZoneStat,
    defaultPlanDraft, expandPlanTargets, collapseTargetRows, targetPriority, metricOf, validatePlan,
    newPlanSeriesId, createPlan, revisePlan, supersededIds, activePlanFor, planHistory, diffPlanTargets,
    evaluateTarget, evaluatePlan, summarizeFulfillment, recommendationDeficitCounts,
    buildKpiSnapshot, sortSnapshots, snapshotSeries, deficitHistory,
    monthStartOf, buildMonthScale, monthlyImpact, buildQuickNote,
    normalizeContribution, sortContributions, normalizeWorkTime, workTimeStats,
    buildResumeMetrics,
    stripGeoFields, exportFileNames, buildExportPayload, toMetricsCsv, toSummaryMarkdown, planCareerImport,
    normalizeStoredItem, storedSortKey,
  };
}));
