// ══════════════════════════════════════════════════════════
//  subzone-recommendation-test — 세부 수집 구역·도로 구간 단위 추천
//
//   A. 공간 3단계 분리(상위 구역 → 세부 구역 → 도로 구간)와 수동 등록/수정/비활성화
//   B. 실제 지도에 있는 도로만 · 없는 이름을 만들지 않음
//   C. 장소 유형별 후보 시간대(업무지구·학교 인접 도로·고속도로 본선/램프)
//   D. 부족한 조건만 우선 추천(충분하면 하향) · 방향별 추천과 방향 신뢰도
//   E. 지도/카드 일치 · 거리·시작·끝 계산 · 근거와 출처 표시
//   F. 이슈 필터 · SQLite ↔ IndexedDB 일치 · 기존 기능 회귀 없음
//
//  실행: node tests/subzone-recommendation-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SZ = require('../src/js/subzones.js');
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

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-sub-')), 'route-viewer.db');

// 테헤란로 축(강남역~삼성역 방향)을 감싸는 폴리곤 — 실제 HD Map 도로가 들어 있는 범위
const TEHERAN_POLYGON = [[37.4955, 127.0250], [37.5015, 127.0250], [37.5100, 127.0640], [37.5040, 127.0640]];
const SMALL_POLYGON = [[37.4990, 127.0300], [37.5010, 127.0300], [37.5010, 127.0350], [37.4990, 127.0350]];

const XLSX_DIR = path.join(ROOT, '주행기록');
const FILES = fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort().slice(0, 6);
const PARSED = FILES.map(f => {
  const buf = fs.readFileSync(path.join(XLSX_DIR, f));
  return { records: RouteParser.parseBuffer(buf), meta: { filename: f, fileHash: RouteDatabase.hashFile(buf) } };
});

function seededDb(options) {
  const o = options || {};
  const db = new RouteDatabase(freshPath());
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
    'src/js/subzones.js', 'src/js/condition-stats.js', 'src/js/recommendation.js', 'src/js/storage.js']
    .forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  return ctx;
}

async function main() {
  // ══════════════════════════════════════════════════════
  section('A. 공간 3단계 · 세부 구역 등록/수정/비활성화');
  // ══════════════════════════════════════════════════════
  const db = seededDb();
  const saved = db.saveSubZone({
    name: '테헤란로 업무지구', parentZone: '강남', type: 'office_district',
    polygon: TEHERAN_POLYGON, note: '업무시설 밀집 간선도로',
  });
  check('1. 상위 구역과 세부 구역이 따로 관리된다(세부 구역은 상위 구역에 속한다)',
    saved.parentZone === '강남' && saved.name === '테헤란로 업무지구' && saved.type === 'office_district'
    && db.listZones().some(z => z.name === '강남'),
    `${saved.parentZone} → ${saved.name}`);
  check('   경계에서 중심 좌표를 계산해 둔다(지도 이동·일출 계산에 쓴다)',
    !!saved.center && Math.abs(saved.center.lat - 37.5027) < 0.01);

  const edited = db.saveSubZone({ id: saved.id, name: '테헤란로 업무지구(수정)', interestPeriods: ['evening_peak'] });
  check('2. 세부 구역을 수정할 수 있다(이름·관심 시간대)',
    edited.name === '테헤란로 업무지구(수정)' && edited.interestPeriods.join(',') === 'evening_peak'
    && edited.id === saved.id && db.listSubZones().length === 1);
  db.setSubZoneActive(saved.id, false);
  check('   비활성화하면 목록에서 빠지고(기록은 그대로) 다시 켤 수 있다',
    db.listSubZones().length === 0 && db.listSubZones({ includeInactive: true }).length === 1
    && db.setSubZoneActive(saved.id, true).active === true && db.getStats().points > 0);
  let rejected = null;
  try { db.saveSubZone({ name: '', parentZone: '', type: 'nope', polygon: [[1, 2]] }); }
  catch (err) { rejected = err.errors; }
  check('   이름·상위 구역·유형·경계가 없으면 저장을 거부하고 이유를 알려준다',
    rejected && rejected.length === 4, (rejected || []).join(' / '));
  db.saveSubZone({ id: saved.id, name: '테헤란로 업무지구', interestPeriods: [] });

  // ══════════════════════════════════════════════════════
  section('B. 실제 지도에 있는 도로만 — 이름을 만들어내지 않는다');
  // ══════════════════════════════════════════════════════
  const hdNames = new Set(HDMAP_GANGNAM.lines.concat(HDMAP_SEOCHO.lines).map(l => String(l.name).trim()));
  const segments = SZ.roadSegmentsIn(TEHERAN_POLYGON, HDMAP_GANGNAM.lines, { subZoneId: saved.id });
  check('3. 추천 구간의 도로 이름은 전부 HD Map 에 실제로 있는 이름이다',
    segments.length > 0 && segments.every(s => !s.named || hdNames.has(s.name)),
    `${segments.length}개 · 예: ${segments.slice(0, 3).map(s => s.name).join(', ')}`);
  check('   테헤란로처럼 실제 도로가 구간으로 잡힌다(길이·시작·끝 포함)',
    segments.some(s => s.name === '테헤란로' && s.lengthM > 1000 && s.start && s.end),
    (() => { const t = segments.find(s => s.name === '테헤란로'); return t ? `${t.lengthM}m · ${t.start.lat.toFixed(4)},${t.start.lng.toFixed(4)} → ${t.end.lat.toFixed(4)},${t.end.lng.toFixed(4)}` : '없음'; })());
  const unnamed = SZ.roadSegmentsIn(TEHERAN_POLYGON, [{ name: '-', points: [[37.4990, 127.0300], [37.5000, 127.0340]] }], {});
  check('4. 이름이 없는 도로(-)에 임의의 이름을 만들지 않는다',
    unnamed.length === 1 && unnamed[0].name === SZ.UNNAMED_ROAD && unnamed[0].named === false,
    unnamed[0] && unnamed[0].name);
  check('   존재하지 않는 IC·학교 이름을 만들지 않는다(도로 등급도 이름에 적혀 있을 때만 단정)',
    SZ.roadClassOf('올림픽대로').id === 'unknown' && SZ.roadClassOf('경부고속도로').id === 'expressway'
    && SZ.roadClassOf('아무개로', { highway: 'motorway' }).id === 'expressway',
    `올림픽대로=${SZ.roadClassOf('올림픽대로').label} · 경부고속도로=${SZ.roadClassOf('경부고속도로').label}`);

  // ══════════════════════════════════════════════════════
  section('C. 장소 유형별 후보 시간대와 예상 상황');
  // ══════════════════════════════════════════════════════
  check('5. 업무지구는 출근·점심·퇴근 피크를 후보로 본다',
    SZ.candidatePeriods({ type: 'office_district' }).join(',') === 'morning_peak,lunch_peak,evening_peak');
  check('   업무지구 예상 상황에 정체·버스 정차·차선 변경이 들어 있다',
    ['정체', '버스 정차', '빈번한 차선 변경'].every(e => SZ.expectedSituations({ type: 'office_district' }).includes(e)));
  check('6. 학교 인접 도로는 등교·하교 후보 시각을 따로 준다(학교마다 다르므로 후보로만)',
    SZ.PLACE_TYPES.school_zone.candidateClock.length === 2
    && SZ.PLACE_TYPES.school_zone.candidateClock[0].start === '07:30',
    SZ.PLACE_TYPES.school_zone.candidateClock.map(c => `${c.label} ${c.start}~${c.end}`).join(' · '));
  check('7. 보호구역 근거가 없으면 단정하지 않는다(유형 이름이 "학교 인접 도로")',
    SZ.placeTypeLabel('school_zone') === '학교 인접 도로'
    && /확인 필요/.test(SZ.PLACE_TYPES.school_zone.unverifiedNote || ''),
    SZ.PLACE_TYPES.school_zone.unverifiedNote || '(없음)');
  check('   안전 안내를 함께 준다(정문 앞 정차·반복 배회 권장 금지)',
    /정문 앞 정차/.test(SZ.safetyNote({ type: 'school_zone' }) || '')
    && /정상 통과 주행/.test(SZ.safetyNote({ type: 'school_zone' }) || ''));
  check('8. 도시고속도로 본선과 램프를 서로 다른 유형으로 나눈다(예상 상황도 다르다)',
    SZ.PLACE_TYPE_IDS.includes('expressway_mainline') && SZ.PLACE_TYPE_IDS.includes('expressway_ramp')
    && SZ.expectedSituations({ type: 'expressway_ramp' }).includes('짧은 합류 구간')
    && !SZ.expectedSituations({ type: 'expressway_mainline' }).includes('짧은 합류 구간'),
    `본선: ${SZ.expectedSituations({ type: 'expressway_mainline' })[0]} / 램프: ${SZ.expectedSituations({ type: 'expressway_ramp' })[0]}`);

  // ══════════════════════════════════════════════════════
  section('D. 부족한 조건만 우선 추천 · 방향');
  // ══════════════════════════════════════════════════════
  const subZones = db.listSubZones();
  const stats = db.getSubZoneStats(subZones);
  const rec = R.buildSubZoneRecommendations({ subZones, stats, settings: db.getSettings(), now: NOW });
  const byCondition = new Map(rec.recommendations.map(r => [`${r.condition.trafficPeriod}|${r.condition.lightCondition || 'any'}`, r]));
  const s0 = stats[0];
  check('9. 이미 모은 조건일수록 점수가 낮다(우선순위 하향)',
    (() => {
      const withData = rec.recommendations.filter(r => r.current.collectionMinutes > 0);
      const empty = rec.recommendations.filter(r => r.current.collectionMinutes === 0);
      if (!withData.length || !empty.length) return false;
      // 모은 게 있는 조건은 전부, 하나도 없는 조건보다 점수가 낮아야 한다
      return Math.max(...withData.map(r => r.score)) < Math.min(...empty.map(r => r.score));
    })(),
    rec.recommendations.map(r => `${r.conditionLabel} ${r.current.collectionMinutes}분→${r.score}점`).slice(0, 4).join(' · '));
  check('10. 기록이 없는 조건은 100점(가장 부족)으로 올라온다',
    rec.recommendations[0].score === 100 && rec.recommendations[0].current.collectionMinutes === 0,
    `${rec.recommendations[0].conditionLabel} ${rec.recommendations[0].score}점`);
  check('   추천은 구역이 아니라 "세부 구역 + 도로 구간 + 조건 + 시간"까지 말한다',
    rec.recommendations[0].subZoneName === '테헤란로 업무지구'
    && rec.recommendations[0].roads.length > 0
    && /^\d{2}:\d{2}~\d{2}:\d{2}$/.test(rec.recommendations[0].timeWindow.text),
    `${rec.recommendations[0].subZoneName} · ${rec.recommendations[0].roads[0].name} · ${rec.recommendations[0].conditionLabel} · ${rec.recommendations[0].timeWindow.text}`);

  // 방향 판정은 표본이 필요하다 — 실제 테헤란로 좌표 위를 동쪽으로 40번, 서쪽으로 5번 지나간
  // 기록을 만들어서(도로는 진짜, 주행은 합성) 방향별 집계와 "적은 쪽 권장"을 확인한다.
  {
    const line = HDMAP_GANGNAM.lines.filter(l => l.name === '테헤란로' && l.points.length >= 4)
      .sort((a, b) => b.points.length - a.points.length)[0];
    const pts = line.points;
    const dirDb = new RouteDatabase(freshPath());
    const mk = (date, startSec, points, vehicle) => points.map((p, i) => ({
      date, time: [Math.floor((startSec + i * 10) / 3600), Math.floor((startSec + i * 10) / 60) % 60, (startSec + i * 10) % 60]
        .map(n => String(n).padStart(2, '0')).join(':'),
      vehicle, zone: '강남', weather: '맑음', speed: '20.0', lat: p[0], lng: p[1],
    }));
    const east = pts.slice(), west = pts.slice().reverse();
    const rows = [];
    for (let d = 1; d <= 8; d++) rows.push(...mk(`2026-09-0${d}`, 18 * 3600, east, '토레스 1호'));
    rows.push(...mk('2026-09-09', 18 * 3600, west, '토레스 1호'));
    dirDb.importRecords(rows, { filename: 'direction.xlsx' });
    const poly = [[Math.min(...pts.map(p => p[0])) - 0.001, Math.min(...pts.map(p => p[1])) - 0.001],
      [Math.max(...pts.map(p => p[0])) + 0.001, Math.min(...pts.map(p => p[1])) - 0.001],
      [Math.max(...pts.map(p => p[0])) + 0.001, Math.max(...pts.map(p => p[1])) + 0.001],
      [Math.min(...pts.map(p => p[0])) - 0.001, Math.max(...pts.map(p => p[1])) + 0.001]];
    dirDb.saveSubZone({ name: '테헤란로 일부 구간', parentZone: '강남', type: 'office_district', polygon: poly });
    const dz = dirDb.listSubZones();
    const dStats = dirDb.getSubZoneStats(dz);
    const dRec = R.buildSubZoneRecommendations({ subZones: dz, stats: dStats, settings: dirDb.getSettings(), now: NOW });
    const road = dStats[0].roads.find(r => r.name === '테헤란로');
    const evening = dRec.recommendations.find(r => r.condition.trafficPeriod === 'evening_peak' && r.roads.length);
    check('11. 방향별로 나눠 세고, 적게 모인 방향을 권한다',
      road && road.direction.ok && road.forward > road.backward && road.backward > 0
      && evening && evening.roads[0].recommendedDirection.id === 'backward',
      road ? `정방향 ${road.forward} · 역방향 ${road.backward} → ${evening ? evening.roads[0].recommendedDirection.label : '(추천 없음)'}` : '도로 없음');
    check('    권장 방향에 왜 그 방향인지 근거를 적는다',
      !!evening && /건/.test(evening.roads[0].recommendedDirection.reason),
      evening ? evening.roads[0].recommendedDirection.reason : '');
    dirDb.close();
  }
  check('12. 방향 표본이 적으면 방향을 단정하지 않고 양방향으로 본다',
    (() => {
      const low = SZ.directionConfidence(3, 1, 500);
      const ok = SZ.directionConfidence(400, 60, 900);
      return low.ok === false && /확인 불가/.test(low.label) && ok.ok === true;
    })(), SZ.directionConfidence(3, 1, 500).reason);

  // ══════════════════════════════════════════════════════
  section('E. 지도·카드 일치 · 거리 계산 · 근거 표시');
  // ══════════════════════════════════════════════════════
  const card = rec.recommendations[0];
  check('13. 카드의 구간이 집계(지도가 그리는 값)와 같은 도로·같은 좌표다',
    card.roads.every(cr => {
      const src = s0.roads.find(r => r.roadId === cr.roadId);
      return src && src.name === cr.name && src.start.lat === cr.start.lat && src.end.lng === cr.end.lng;
    }), `${card.roads.length}개 구간`);
  check('14. 시작·끝·거리 계산이 실제 도로 좌표와 맞는다',
    (() => {
      const seg = segments.find(s => s.name === '테헤란로');
      if (!seg) return false;
      let sum = 0;
      seg.chunks.forEach(pts => { for (let i = 1; i < pts.length; i++) sum += SZ.distanceM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); });
      const direct = SZ.distanceM(seg.start.lat, seg.start.lng, seg.end.lat, seg.end.lng);
      return Math.abs(sum - seg.lengthM) < 2 && direct > 0 && direct <= seg.lengthM + 1;
    })(),
    (() => { const seg = segments.find(s => s.name === '테헤란로'); return seg ? `${seg.lengthM}m(직선 ${Math.round(SZ.distanceM(seg.start.lat, seg.start.lng, seg.end.lat, seg.end.lng))}m)` : ''; })());
  check('15. 실제로 주행한(도로에 맞은) 구간만 추천에 쓴다',
    s0.roads.every(r => r.recordCount > 0) && s0.match.matchedPoints > 0,
    s0.match.note);
  check('16. 추천 카드의 도로 이름도 전부 지도 데이터에 있는 이름이다',
    rec.recommendations.every(r => r.roads.every(x => !x.named || hdNames.has(x.name))));
  check('18. 근거 수준과 데이터 출처를 함께 표시한다(점수와 다른 값)',
    ['높음', '보통', '낮음'].includes(card.evidence.label) && card.dataSources.length > 0
    && card.evidence.reasons.length > 0,
    `${card.evidence.label} · ${card.dataSources.join(' / ')}`);
  check('   예상 상황은 "가능성"으로만 적는다',
    /보장하지 않습니다/.test(card.edgeCaseDisclaimer) && card.expects.length > 0);

  // ══════════════════════════════════════════════════════
  section('F. 이슈 필터 · 두 저장소 일치 · 회귀');
  // ══════════════════════════════════════════════════════
  const issueDb = seededDb({ markIssues: true });
  issueDb.saveSubZone({ name: '테헤란로 업무지구', parentZone: '강남', type: 'office_district', polygon: TEHERAN_POLYGON });
  const zonesI = issueDb.listSubZones();
  const allStats = issueDb.getSubZoneStats(zonesI, { filter: {} })[0];
  const cleanStats = issueDb.getSubZoneStats(zonesI, { filter: { issueFilter: 'clean' } })[0];
  check('17. 이슈 데이터 제외 필터가 세부 구역 집계에도 적용된다',
    allStats.recordCount > cleanStats.recordCount && cleanStats.recordCount > 0,
    `전체 ${allStats.recordCount}건 → 이슈 없음 ${cleanStats.recordCount}건`);
  issueDb.close();

  const ctx = await idbContext();
  for (const p of PARSED) await ctx.RouteDB.importRecords(p.records, p.meta);
  await ctx.RouteDB.saveSubZone({ name: '작은 구역', parentZone: '강남', type: 'office_district', polygon: SMALL_POLYGON });
  const idbZones = await ctx.RouteDB.listSubZones();
  const idbStats = await ctx.RouteDB.getSubZoneStats(idbZones);
  const sqlDb2 = seededDb();
  sqlDb2.saveSubZone({ name: '작은 구역', parentZone: '강남', type: 'office_district', polygon: SMALL_POLYGON });
  const sqlStats = sqlDb2.getSubZoneStats(sqlDb2.listSubZones());
  const strip = s => ({
    recordCount: s.recordCount, collectionMinutes: s.collectionMinutes, visitCount: s.visitCount,
    uniqueDays: s.uniqueDays, conditions: s.conditions.map(c => `${c.trafficPeriod}|${c.lightCondition}|${c.collectionMinutes}|${c.recordCount}`).sort(),
    roads: s.roads.map(r => `${r.name}|${r.recordCount}|${r.forward}|${r.backward}`).sort(),
  });
  check('19. SQLite 와 IndexedDB 의 세부 구역 집계가 같다',
    JSON.stringify(strip(sqlStats[0])) === JSON.stringify(strip(idbStats[0])),
    `SQLite ${sqlStats[0].recordCount}건 / IndexedDB ${idbStats[0].recordCount}건 · 도로 ${sqlStats[0].roads.length}/${idbStats[0].roads.length}`);
  check('   두 저장소 모두 같은 등록·수정·비활성화 API 를 준다',
    (await ctx.RouteDB.setSubZoneActive(idbZones[0].id, false)).active === false
    && (await ctx.RouteDB.listSubZones()).length === 0
    && (await ctx.RouteDB.listSubZones({ includeInactive: true })).length === 1);

  const summariesBefore = db.listDateSummaries().length;
  const overviewBefore = db.getOverview({}).points;
  db.saveSubZone({ name: '또 다른 구역', parentZone: '강남', type: 'market_zone', polygon: SMALL_POLYGON });
  check('20. 세부 구역을 등록해도 달력·누적 지도·통계 데이터는 그대로다(회귀 없음)',
    db.listDateSummaries().length === summariesBefore && db.getOverview({}).points === overviewBefore
    && db.getStatsBundle({}, {}).points === overviewBefore,
    `요약 ${summariesBefore}일 · 기록 ${overviewBefore}건 그대로`);

  db.close(); sqlDb2.close();

  console.log('\n' + '─'.repeat(60));
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failures.length) failures.forEach(f => console.log('   - ' + f));
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
