// ══════════════════════════════════════════════════════════
//  auto-analysis-test — 지도 기반 자동 세부 구역 생성과 구간 추천
//
//   A. 자동 생성 — 사용자가 아무것도 그리지 않아도 분석된다 · 안정적인 id · 유형 분류 · 이름 사실성
//   B. GPS 매칭·집계 — 구간 연결 · 방향별 · 시간대/조도/요일 · 이슈 필터 · 중복 없음
//   C. 추천 — 구체적인 구간·방향·시간·횟수·부족 근거·신뢰도·안전
//   D. 성능과 캐시 — 탭 전환으로 재분석하지 않음 · 데이터 변경 시 갱신 · 보정 유지 · 오프라인 · 두 저장소 일치
//
//  실행: node tests/auto-analysis-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SZ = require('../src/js/subzones.js');
const RG = require('../src/js/road-graph.js');
const AZ = require('../src/js/auto-subzones.js');
const R = require('../src/js/recommendation.js');
const TC = require('../src/js/time-conditions.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { baseContext, load } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const ROOT = path.join(__dirname, '..');
const HDMAP_GANGNAM = require('../src/data/hdmap_gangnam_roads.json');
const HDMAP_SEOCHO = require('../src/data/hdmap_seocho_roads.json');
const NOW = '2026-09-17T01:00:00Z';
const TODAY = '2026-09-17';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-auto-')), 'route-viewer.db');

// 강남 테헤란로 일대만 보는 작은 분석 범위 — 테스트가 빨리 끝나게
const GANGNAM_POLYGON = [[37.4940, 127.0230], [37.5060, 127.0230], [37.5060, 127.0500], [37.4940, 127.0500]];

const XLSX_DIR = path.join(ROOT, '주행기록');
const FILES = fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort().slice(0, 5);
const PARSED = FILES.map(f => {
  const buf = fs.readFileSync(path.join(XLSX_DIR, f));
  return { records: RouteParser.parseBuffer(buf), meta: { filename: f, fileHash: RouteDatabase.hashFile(buf) } };
});

function seededDb(options) {
  const o = options || {};
  const db = new RouteDatabase(freshPath());
  db.saveZonePolygons({ ...db.getZonePolygons(), 강남: GANGNAM_POLYGON });
  PARSED.forEach((p, i) => db.importRecords(p.records, {
    ...p.meta,
    hasIssue: !!(o.markIssues && i === 0),
    issueNote: o.markIssues && i === 0 ? '테스트 이슈' : '',
  }));
  return db;
}

async function idbContext() {
  const fake = createFakeIndexedDB();
  const ctx = baseContext({
    indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange,
    HDMAP_GANGNAM_ROADS: HDMAP_GANGNAM, HDMAP_SEOCHO_ROADS: HDMAP_SEOCHO,
  });
  ['src/js/coverage-grid.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js',
    'src/js/subzones.js', 'src/js/road-graph.js', 'src/js/auto-subzones.js', 'src/js/condition-stats.js',
    'src/js/recommendation.js', 'src/js/storage.js'].forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  return ctx;
}

// 지도에 실제로 있는 이름 목록 — "만들어낸 이름"이 없는지 대조할 기준
const REAL_NAMES = new Set(HDMAP_GANGNAM.lines.concat(HDMAP_SEOCHO.lines)
  .map(l => String(l.name).trim()).filter(n => n && n !== '-'));

async function main() {
  // ══════════════════════════════════════════════════════
  section('A. 자동 생성 — 사용자가 아무것도 그리지 않아도');
  // ══════════════════════════════════════════════════════
  const db = seededDb();
  const t0 = Date.now();
  const analysis = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  const firstMs = Date.now() - t0;

  check('1. 사용자가 세부 구역을 하나도 등록하지 않아도 자동으로 분석된다',
    db.listSubZones().length === 0 && analysis.segments.length > 0 && analysis.zones.length > 0,
    `등록한 세부 구역 ${db.listSubZones().length}개 · 자동 도로 구간 ${analysis.segments.length}개 · 자동 구역 ${analysis.zones.length}개 (${firstMs}ms)`);
  check('   상위 구역 경계 안의 도로만 분석한다',
    analysis.segments.every(s => s.geometry.some(([la, lo]) => SZ.pointInPolygon(la, lo, GANGNAM_POLYGON))),
    `${analysis.segments.length}구간`);

  const again = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY, force: true });
  check('2. 같은 지도 데이터면 다시 분석해도 같은 id·같은 결과가 나온다',
    analysis.segments.map(s => s.id).sort().join(',') === again.segments.map(s => s.id).sort().join(',')
    && analysis.zones.length === again.zones.length,
    `구간 ${again.segments.length}개 · id 동일`);
  check('   Segment id 는 좌표·도로명에서 만들어져 중복되지 않는다',
    new Set(analysis.segments.map(s => s.id)).size === analysis.segments.length);

  // 도로 분할 기준 — 교차로·도로명 변경·최대 길이
  check('3. 도로를 교차로·도로명 변경·최대 길이 기준으로 나눈다',
    analysis.segments.some(s => s.cutReason === '교차로') && analysis.segments.some(s => s.cutReason === '최대 길이')
    && analysis.segments.every(s => s.lengthM <= RG.DEFAULTS.maxSegmentM + 400)
    && new Set(analysis.segments.map(s => s.roadName)).size > 5,
    `끊은 이유: ${[...new Set(analysis.segments.map(s => s.cutReason))].join(', ')} · 도로 ${new Set(analysis.segments.map(s => s.roadName)).size}종`);
  check('   같은 구간의 양끝이 교차로인지 표시한다(시작·종료 지점 표시에 쓴다)',
    analysis.segments.some(s => s.startJunction) && analysis.segments.some(s => s.endJunction));

  // 유형 분류 — 있는 근거로만
  const withGps = analysis.segments.filter(s => analysis.segmentStats[s.id]);
  check('4. 우리 주행 기록으로 구간 성격을 판정한다(저속·정체, 출퇴근 집중 등)',
    analysis.segments.some(s => ['congestion_prone', 'commute_peak_corridor', 'high_speed_corridor'].includes(s.primaryType)),
    [...new Set(analysis.segments.map(s => s.primaryType))].join(', '));
  check('   판정마다 근거 문장을 남긴다',
    analysis.segments.filter(s => s.primaryType !== 'unclassified').every(s => s.typeBasis.length > 0),
    (analysis.segments.find(s => s.primaryType === 'congestion_prone') || { typeBasis: [] }).typeBasis[0] || '');
  check('5. 공식 어린이보호구역과 학교 인접 도로를 다른 유형으로 구분한다',
    AZ.SEMANTIC_TYPES.official_school_zone.requires === 'official'
    && AZ.SEMANTIC_TYPES.school_adjacent.requires === 'poi'
    && AZ.SEMANTIC_TYPES.official_school_zone.label === '공식 어린이보호구역'
    && AZ.SEMANTIC_TYPES.school_adjacent.label === '학교 인접 도로');
  check('   학교 POI 만 있으면 "공식 어린이보호구역"이라고 말하지 않는다',
    (() => {
      const seg = { ...analysis.segments[0], geometry: analysis.segments[0].geometry };
      const poi = { fetchedAt: NOW, schools: [{ lat: seg.center.lat, lng: seg.center.lng, name: '학교' }], officialSchoolZones: [] };
      const out = AZ.classifySegments([{ ...seg }], {}, { poi, today: TODAY });
      return out[0].primaryType === 'school_adjacent' && /확인되지 않았습니다/.test(out[0].typeBasis.join(' '));
    })());
  check('   공식 보호구역 데이터가 있으면 그때만 공식으로 판정한다',
    (() => {
      const seg = { ...analysis.segments[0] };
      const poi = { fetchedAt: NOW, schools: [], officialSchoolZones: [{ lat: seg.center.lat, lng: seg.center.lng, name: '보호구역' }] };
      const out = AZ.classifySegments([{ ...seg }], {}, { poi, today: TODAY });
      return out[0].primaryType === 'official_school_zone';
    })());
  check('6. 고속화도로 본선과 램프를 다른 유형으로 나눈다(OSM 등급으로 확인될 때)',
    (() => {
      const seg = { ...analysis.segments[0] };
      const main = AZ.classifySegments([{ ...seg, osmTags: { highway: 'motorway' } }], {}, { today: TODAY })[0];
      const ramp = AZ.classifySegments([{ ...seg, osmTags: { highway: 'motorway_link' } }], {}, { today: TODAY })[0];
      return main.primaryType === 'expressway_mainline' && ramp.primaryType === 'expressway_ramp';
    })());
  check('7. 합류·분기 후보는 "가능성"으로만 말한다(지도 등급 확인 아님)',
    /가능성이 있습니다/.test(AZ.SEMANTIC_TYPES.merge_candidate.label + ' ' + JSON.stringify(AZ.SEMANTIC_TYPES.merge_candidate))
    || AZ.SEMANTIC_TYPES.merge_candidate.label.includes('후보'),
    AZ.SEMANTIC_TYPES.merge_candidate.label);
  check('8. 아파트 내부도로는 Coverage 규칙대로 두고, 주거단지 인접 도로는 POI 가 있을 때만 분류한다',
    AZ.SEMANTIC_TYPES.residential_access.requires === 'poi'
    && SZ.PLACE_TYPES.residential_complex.note.includes('단지 안 도로를 제외'),
    SZ.PLACE_TYPES.residential_complex.note);
  check('9. 확인되지 않은 장소 이름을 만들지 않는다(도로명은 전부 지도에 있는 이름)',
    analysis.segments.every(s => !s.named || REAL_NAMES.has(s.roadName))
    && analysis.segments.filter(s => !s.named).every(s => /이름 없는 구간/.test(s.label)),
    `이름 있는 구간 ${analysis.segments.filter(s => s.named).length} · 이름 없는 구간 ${analysis.segments.filter(s => !s.named).length}`);
  check('   자동 구역 이름도 지도 도로명 + 유형으로만 만든다',
    analysis.zones.every(z => !z.roadNames.length || z.roadNames.every(n => REAL_NAMES.has(n)))
    && analysis.zones.every(z => !!z.nameBasis),
    analysis.zones[0].name + ' — ' + analysis.zones[0].nameBasis);

  // ══════════════════════════════════════════════════════
  section('B. GPS 매칭과 집계');
  // ══════════════════════════════════════════════════════
  const stats = analysis.segmentStats;
  const statList = Object.values(stats);
  check('10. GPS 기록이 도로 Segment 에 연결된다(25m 안에서만)',
    statList.length > 0 && analysis.match.matchedPoints > 0 && analysis.match.maxDistanceM === 25,
    `맞춘 기록 ${analysis.match.matchedPoints.toLocaleString('en-US')}건 · 못 맞춘 기록 ${analysis.match.unmatchedPoints.toLocaleString('en-US')}건 · 기록 있는 구간 ${statList.length}개`);
  // 방향별 집계는 표본이 필요하다 — 실제 테헤란로 좌표 위를 동쪽 6번·서쪽 2번 달린 기록을 만들어 확인한다
  {
    const line = HDMAP_GANGNAM.lines.filter(l => l.name === '테헤란로' && l.points.length >= 4)
      .sort((a, b) => b.points.length - a.points.length)[0];
    const pts = line.points;
    const dirDb = new RouteDatabase(freshPath());
    const box = [[Math.min(...pts.map(p => p[0])) - 0.002, Math.min(...pts.map(p => p[1])) - 0.002],
      [Math.max(...pts.map(p => p[0])) + 0.002, Math.min(...pts.map(p => p[1])) - 0.002],
      [Math.max(...pts.map(p => p[0])) + 0.002, Math.max(...pts.map(p => p[1])) + 0.002],
      [Math.min(...pts.map(p => p[0])) - 0.002, Math.max(...pts.map(p => p[1])) + 0.002]];
    dirDb.saveZonePolygons({ ...dirDb.getZonePolygons(), 강남: box });
    const mk = (date, startSec, points) => points.map((p, i) => ({
      date, time: [Math.floor((startSec + i * 10) / 3600), Math.floor((startSec + i * 10) / 60) % 60, (startSec + i * 10) % 60]
        .map(n => String(n).padStart(2, '0')).join(':'),
      vehicle: '토레스 1호', zone: '강남', weather: '맑음', speed: '18.0', lat: p[0], lng: p[1],
    }));
    const rows = [];
    const day = n => `2026-09-${String(n).padStart(2, '0')}`;
    // 방향 판정에는 표본이 20건 넘게 필요하다(정차 구간에서는 방위를 못 구하는 점이 많아서)
    for (let d = 1; d <= 20; d++) rows.push(...mk(day(d), 18 * 3600, pts));
    for (let d = 21; d <= 28; d++) rows.push(...mk(day(d), 9 * 3600, pts.slice().reverse()));
    dirDb.importRecords(rows, { filename: 'direction.xlsx' });
    const dirAnalysis = dirDb.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
    const twoWay = Object.values(dirAnalysis.segmentStats)
      .sort((a, b) => b.recordCount - a.recordCount)
      .find(s => s.directions.forward > 0 && s.directions.backward > 0);
    check('11. 반대 방향 주행이 따로 집계된다',
      !!twoWay && twoWay.cells.some(c => c.direction === 'forward') && twoWay.cells.some(c => c.direction === 'backward'),
      twoWay ? `정방향 ${twoWay.directions.forward}건 · 역방향 ${twoWay.directions.backward}건 · 칸 ${twoWay.cells.length}개` : '(양방향 구간 없음)');
    const dirRec = R.buildSegmentRecommendations({ analysis: dirAnalysis, segmentStats: dirAnalysis.segmentStats, settings: dirDb.getSettings(), now: NOW });
    const directed = dirRec.allRecommendations.find(r => r.direction.confident);
    check('   방향별 부족이 확인되면 적게 모인 방향을 권한다',
      !!directed && /쪽 방향/.test(directed.direction.label) && /적게 모인 쪽/.test(directed.direction.reason),
      directed ? `${directed.segmentLabel} · ${directed.direction.label} — ${directed.direction.reason}` : '(방향 확정 추천 없음)');
    dirDb.close();
  }
  const busiest = statList.slice().sort((a, b) => b.recordCount - a.recordCount)[0];
  check('12. 시간대별 수집량이 집계된다',
    Object.keys(busiest.periods).length > 0
    && Math.abs(Object.values(busiest.periods).reduce((a, b) => a + b, 0) - busiest.collectionSec) < 1,
    Object.entries(busiest.periods).map(([k, v]) => `${TC.TRAFFIC_PERIOD_LABELS[k]} ${Math.round(v / 60)}분`).join(' · '));
  check('13. 조도 조건별로도 나뉜다',
    busiest.cells.some(c => c.lightCondition) && new Set(busiest.cells.map(c => c.lightCondition)).size >= 1,
    [...new Set(busiest.cells.map(c => c.lightCondition))].join(', '));
  check('14. 평일과 주말이 구분된다',
    busiest.cells.every(c => ['weekday', 'weekend', 'unknown'].includes(c.weekdayType)),
    [...new Set(statList.flatMap(s => s.cells.map(c => c.weekdayType)))].join(', '));
  check('16. 같은 GPS 가 여러 구간에 중복으로 세지지 않는다',
    (() => {
      const sum = statList.reduce((a, s) => a + s.recordCount, 0);
      return sum === analysis.match.matchedPoints;
    })(),
    `구간 합계 ${statList.reduce((a, s) => a + s.recordCount, 0)} = 맞춘 기록 ${analysis.match.matchedPoints}`);

  const issueDb = seededDb({ markIssues: true });
  const withIssues = issueDb.getAutoAnalysis('강남', { issueFilter: 'all', today: TODAY });
  const cleanOnly = issueDb.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  check('15. 이슈 데이터 제외 필터가 자동 분석 집계에도 적용된다',
    withIssues.match.matchedPoints > cleanOnly.match.matchedPoints && cleanOnly.match.matchedPoints > 0,
    `전체 ${withIssues.match.matchedPoints}건 → 이슈 없음 ${cleanOnly.match.matchedPoints}건`);
  issueDb.close();

  // ══════════════════════════════════════════════════════
  section('C. 추천 — 구체적인 구간·방향·시간');
  // ══════════════════════════════════════════════════════
  const rec = R.buildSegmentRecommendations({
    analysis, segmentStats: stats, settings: db.getSettings(), now: NOW, issueFilter: 'clean',
  });
  const top = rec.recommendations[0];
  check('17. 넓은 구역이 아니라 실제 도로 구간을 추천한다',
    !!top && !!top.roadName && top.segmentLabel !== top.parentZone && top.lengthM >= 60,
    top ? `${top.parentZone} → ${top.subZoneName} → ${top.segmentLabel} (${top.lengthKm}km)` : '(추천 없음)');
  check('18. 시작점·종료점·진행 방향이 표시된다',
    !!top.start && !!top.end && !!top.direction.label && !!top.startLabel && !!top.endLabel,
    `${top.startLabel} ${top.start.lat.toFixed(4)},${top.start.lng.toFixed(4)} → ${top.endLabel} · ${top.direction.label}`);
  check('19. 현재 수집량과 목표가 함께 나온다',
    Number.isFinite(top.current.collectionMinutes) && top.targets.minutes > 0,
    `${top.current.collectionMinutes}분 / 목표 ${top.targets.minutes}분`);
  check('20. 부족한 조건과 추천 이유가 나온다',
    top.breakdown.some(b => !b.excluded && b.value > 0) && top.reason.length > 20,
    top.reason.slice(0, 90));
  check('21. 권장 시간과 횟수가 나온다',
    /^\d{2}:\d{2}~\d{2}:\d{2}$/.test(top.timeWindow.text) && /회/.test(top.need.text),
    `${top.timeWindow.text} · ${top.need.text}`);
  check('22. 데이터가 부족하면 신뢰도가 낮아진다(점수와 다른 값)',
    (() => {
      const noData = rec.allRecommendations.find(r => !r.current.recordCount && r.confidence.level === 'low');
      const rich = rec.allRecommendations.find(r => r.current.recordCount > 100);
      return !!noData && (!rich || rich.confidence.rank >= noData.confidence.rank);
    })(),
    `신뢰도 분포: ${[...new Set(rec.allRecommendations.map(r => r.confidence.label))].join(', ')}`);
  check('23. 예상 상황을 확정적으로 말하지 않는다',
    /보장하지 않습니다/.test(top.edgeCaseDisclaimer)
    && rec.limitations.some(l => /가능성이며 실제 발생을 보장하지 않습니다/.test(l)));
  check('24. 안전·법규 한계를 밝히고, 보호구역은 안전 우선 문구를 붙인다',
    rec.limitations.some(l => /진입 금지·보행자 전용·사유지/.test(l))
    && /안전과 법규 준수가 먼저/.test(R.buildSegmentRecommendations({
      analysis: { ...analysis, zones: analysis.zones.map(z => ({ ...z, semanticType: 'official_school_zone', semanticLabel: '공식 어린이보호구역', safetyFirst: true })) },
      segmentStats: stats, settings: db.getSettings(), now: NOW,
    }).recommendations[0].safetyNote || ''),
    rec.limitations.find(l => /진입 금지/.test(l)));
  check('   추천 점수 가중치는 설정에서 바꿀 수 있고 합계 100%를 검사한다',
    R.validateSegmentSettings({ weights: { timePeriod: 50 } }).ok === false
    && R.validateSegmentSettings({}).ok === true
    && R.SEGMENT_SCORE_KEYS.length === 8,
    R.validateSegmentSettings({ weights: { timePeriod: 50 } }).errors[0]);

  // ══════════════════════════════════════════════════════
  section('D. 성능 · 캐시 · 보정 · 두 저장소');
  // ══════════════════════════════════════════════════════
  const t1 = Date.now();
  const cachedRun = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  const cachedMs = Date.now() - t1;
  check('25. 탭 전환(같은 조건 재요청)만으로는 전체 분석을 다시 하지 않는다',
    cachedRun.cached === true && cachedRun.stages.every(s => /재사용/.test(s)) && cachedMs < firstMs,
    `${firstMs}ms → ${cachedMs}ms · ${cachedRun.stages.join(' / ')}`);
  check('26. 지도·도로망이 그대로면 도로 Segment 를 다시 만들지 않는다',
    cachedRun.revisions.mapDataRevision === analysis.revisions.mapDataRevision
    && cachedRun.revisions.roadGraphRevision === analysis.revisions.roadGraphRevision);

  db.importRecords(PARSED[0].records.map(r => ({ ...r, date: '2026-09-15' })), { filename: 'extra.xlsx' });
  const afterImport = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  check('27. GPS 를 새로 불러오면 집계와 추천이 갱신된다',
    afterImport.cached === false && afterImport.stages.some(s => /GPS 집계 새로 계산/.test(s))
    && afterImport.revisions.gpsDataRevision !== analysis.revisions.gpsDataRevision
    && afterImport.stages.some(s => /도로망 재사용/.test(s)),
    afterImport.stages.join(' / '));

  const targetZone = afterImport.zones.find(z => z.semanticType !== 'unclassified') || afterImport.zones[0];
  db.saveSubZoneOverride({ id: targetZone.id, parentZone: '강남', name: '우리 회사 앞 구간', semanticType: 'office_district' });
  const afterOverride = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY, force: true });
  const fixed = afterOverride.zones.find(z => z.id === targetZone.id);
  check('28. 사용자 보정은 자동 분석을 다시 해도 유지된다(자동 결과 원본은 그대로)',
    !!fixed && fixed.name === '우리 회사 앞 구간' && fixed.semanticType === 'office_district'
    && !!fixed.override && /사용자가 직접 고친 이름/.test(fixed.nameBasis),
    `${fixed.name} · ${fixed.semanticLabel}`);
  db.saveSubZoneOverride({ id: targetZone.id, excluded: true });
  const afterExclude = db.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  const excluded = afterExclude.zones.find(z => z.id === targetZone.id);
  const recAfter = R.buildSegmentRecommendations({ analysis: afterExclude, segmentStats: afterExclude.segmentStats, settings: db.getSettings(), now: NOW });
  check('   "추천에서 제외" 보정은 그 구역 구간을 추천에서 뺀다',
    excluded.active === false && !recAfter.recommendations.some(r => r.subZoneId === targetZone.id));

  check('29. 인터넷이 없어도(지도 POI 를 못 받아도) 마지막 분석 결과로 동작한다',
    analysis.dataLevels.roadGraph === true && analysis.dataLevels.poi === false
    && analysis.notes.some(n => /POI/.test(n)) && rec.recommendations.length > 0,
    analysis.notes[0].slice(0, 70));

  const ctx = await idbContext();
  for (const p of PARSED) await ctx.RouteDB.importRecords(p.records, p.meta);
  await ctx.RouteDB.saveZonePolygons({ 강남: GANGNAM_POLYGON });
  const idbAnalysis = await ctx.RouteDB.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  const sqlDb2 = seededDb();
  const sqlAnalysis = sqlDb2.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  const strip = a => ({
    segments: a.segments.length,
    ids: a.segments.map(s => s.id).sort().slice(0, 50),
    zones: a.zones.length,
    matched: a.match.matchedPoints,
    stats: Object.keys(a.segmentStats).length,
    sample: (() => {
      const id = Object.keys(a.segmentStats).sort()[0];
      const s = a.segmentStats[id];
      return s ? `${id}|${s.recordCount}|${s.collectionSec}|${s.directions.forward}|${s.directions.backward}|${s.coverage.percent}` : '';
    })(),
  });
  check('30. SQLite 와 IndexedDB 의 자동 분석 결과가 같다',
    JSON.stringify(strip(sqlAnalysis)) === JSON.stringify(strip(idbAnalysis)),
    `SQLite 구간 ${sqlAnalysis.segments.length}/매칭 ${sqlAnalysis.match.matchedPoints} · IndexedDB 구간 ${idbAnalysis.segments.length}/매칭 ${idbAnalysis.match.matchedPoints}`);
  const idbCached = await ctx.RouteDB.getAutoAnalysis('강남', { issueFilter: 'clean', today: TODAY });
  check('   IndexedDB 도 같은 조건이면 캐시를 쓴다',
    idbCached.cached === true && idbCached.stages.every(s => /재사용/.test(s)), idbCached.stages.join(' / '));

  check('   기존 기능(달력·누적 지도·통계)은 그대로다',
    db.listDateSummaries().length > 0 && db.getOverview({}).points > 0 && db.getStatsBundle({}, {}).points > 0
    && db.getCellVisitCounts({ latDeg: 0.00018, lngDeg: 0.00023, minLat: 37.49, maxLat: 37.51, minLng: 127.02, maxLng: 127.05, refLat: 37.5 }, 20).length > 0,
    `요약 ${db.listDateSummaries().length}일 · 기록 ${db.getOverview({}).points}건`);

  db.close(); sqlDb2.close();

  console.log('\n' + '─'.repeat(60));
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failures.length) failures.forEach(f => console.log('   - ' + f));
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
