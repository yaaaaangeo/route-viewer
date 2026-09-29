// ══════════════════════════════════════════════════════════
//  hdmap-priority-debug.js — ①~⑫ 구역 분류가 실제로 몇 건을 잡는지 확인한다
//
//  "경계를 저장했는데 정말 기존 기록이 분류되고 있나?" 를 화면 밖에서 검증하는 도구다.
//  앱이 쓰는 것과 똑같은 경로(RouteDatabase.getSubZoneStats → SubZones.aggregateSubZone)로
//  세기 때문에, 여기 나온 숫자와 [통계] → HD Map 우선 수집 화면의 숫자는 같아야 한다.
//
//  찍어 주는 것
//    · DB 전체 기록 수 / 날짜 수
//    · 구역별 recordCount · 수집 분 · 방문 · 세션 · 수집일 · 마지막 수집
//    · ①~⑫ 합계와, 어느 구역에도 안 들어간(경계 밖) 기록 수
//    · 겹침 때문에 두 번 이상 세어진 기록 수
//
//  실행
//    node tools/hdmap-priority-debug.js                 (앱이 쓰는 실제 DB)
//    node tools/hdmap-priority-debug.js <db경로>
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { RouteDatabase } = require('../electron/database.js');
const SubZones = require('../src/js/subzones.js');
const HDMapPriority = require('../src/js/hdmap-priority.js');
const PriorityPolicy = require('../src/js/priority-policy.js');

// Electron 이 쓰는 기본 경로 — app.getPath('userData')/database/route-viewer.db 와 같은 자리
function defaultDbPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Route Viewer', 'database', 'route-viewer.db');
}

const dbPath = process.argv[2] || defaultDbPath();
if (!fs.existsSync(dbPath)) {
  console.error(`DB 를 찾지 못했어요: ${dbPath}`);
  console.error('앱을 한 번 켜서 기록을 넣은 뒤 다시 실행하거나, 경로를 인자로 넘겨주세요.');
  process.exit(1);
}

const db = new RouteDatabase(dbPath);
const total = db.db.get('SELECT COUNT(*) AS n FROM driving_records').n;
const days = db.db.get('SELECT COUNT(DISTINCT date) AS n FROM driving_records').n;
const bbox = db.db.get(`SELECT MIN(latitude) AS minLat, MAX(latitude) AS maxLat,
                               MIN(longitude) AS minLng, MAX(longitude) AS maxLng FROM driving_records`);

console.log('══════════════════════════════════════════════════════');
console.log(` DB     : ${dbPath}`);
console.log(` 기록   : ${total.toLocaleString('ko-KR')}건 · ${days}일`);
if (total) console.log(` 범위   : 위도 ${bbox.minLat}~${bbox.maxLat} · 경도 ${bbox.minLng}~${bbox.maxLng}`);
console.log('══════════════════════════════════════════════════════');

const saved = db.getHDMapPriorityPolygons();
// 우선순위는 앱과 같은 활성 Priority Policy(저장된 설정 → 없으면 초기 정책)에서
const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const policy = PriorityPolicy.resolveActive((db.getSettings() || {}).priorityPolicies, HDMapPriority.listAreas(), null, todayKst).policy;
const areas = HDMapPriority.listAreas(null, saved, policy);
const ready = areas.filter(a => a.hasPolygon);
console.log(`\n경계 설정: ${ready.length} / ${areas.length}개` + (ready.length ? ` (${ready.map(a => a.areaNo).join(', ')})` : ''));
if (!ready.length) {
  console.log('\n아직 ①~⑫ 경계가 하나도 없어요 — 그래서 모든 구역이 "경계 미설정"입니다.');
  console.log('앱의 [통계] → HD Map 우선 수집 → [구역 경계 설정]에서 지도에 경계를 그린 뒤 다시 실행하세요.');
  console.log('(기본 경계 파일을 다시 만들려면: node tools/derive-hdmap-priority-areas.js)');
  db.close();
  process.exit(0);
}

// 앱 화면과 똑같은 경로로 집계한다
const stats = db.getSubZoneStats(HDMapPriority.toSubZoneInputs(areas), {});
const result = HDMapPriority.buildComparison({ areas, stats, policy });

const pad = (s, n) => String(s).padStart(n);
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log('\n구역별 분류 결과 (앱 화면과 같은 계산)');
console.log('───────────────────────────────────────────────────────────────────────────────');
console.log(' 지역  구분    상태            기록수     수집분   방문  세션  수집일  마지막수집');
console.log('───────────────────────────────────────────────────────────────────────────────');
result.rows.forEach(r => {
  const last = r.lastVisitedAt ? String(r.lastVisitedAt).slice(0, 10) : '—';
  console.log(` ${padR(r.name, 5)} ${padR(r.priorityLabel, 7)} ${padR(r.stateLabel, 15)}`
    + ` ${pad(r.recordCount.toLocaleString('ko-KR'), 9)} ${pad(r.collectionMinutes.toLocaleString('ko-KR'), 8)}`
    + ` ${pad(r.visitCount, 5)} ${pad(r.sessionCount, 5)} ${pad(r.uniqueDays, 6)}  ${last}`);
});
console.log('───────────────────────────────────────────────────────────────────────────────');

const sumRecords = result.rows.reduce((a, r) => a + r.recordCount, 0);
console.log(`\n①~⑫ 합계        : ${sumRecords.toLocaleString('ko-KR')}건 (구역별 합 — 겹치면 중복으로 세어짐)`);

// 경계 밖 / 중복 — 기록 하나하나를 직접 훑어서 센다(집계와 별개로 검산)
const rows = db.db.all('SELECT latitude AS lat, longitude AS lng FROM driving_records');
let inside = 0, outside = 0, multi = 0;
const hitCount = new Map();
rows.forEach(r => {
  let hits = 0;
  ready.forEach(a => { if (SubZones.pointInPolygon(r.lat, r.lng, a.polygon)) hits++; });
  if (hits === 0) outside++; else { inside++; if (hits > 1) multi++; }
  hitCount.set(hits, (hitCount.get(hits) || 0) + 1);
});
const pct = n => (total ? ((n / total) * 100).toFixed(1) : '0.0');
console.log(`어느 구역엔가 포함 : ${inside.toLocaleString('ko-KR')}건 (${pct(inside)}%)`);
console.log(`경계 밖           : ${outside.toLocaleString('ko-KR')}건 (${pct(outside)}%)`);
console.log(`두 구역 이상 겹침  : ${multi.toLocaleString('ko-KR')}건` + (multi ? ' ← 합계가 부풀어 있어요(경계 겹침 확인 필요)' : ''));

console.log(`\n적용 정책          : ${policy ? `${policy.policyName} — ${PriorityPolicy.summarize(policy)}` : '없음(모든 구역 비우선)'}`);
const primary = result.summary.primary;
if (primary) {
  console.log(`${primary.name} 최우선 지역      : ${primary.recordCount.toLocaleString('ko-KR')}건 · ${primary.collectionMinutes}분`
    + ` · 방문 ${primary.visitCount}회 · 세션 ${primary.sessionCount}회 · 수집일 ${primary.uniqueDays}일`);
} else {
  console.log('최우선 지역        : 없음(활성 정책에 우선도 100 구역 없음)');
}
const s = result.summary;
console.log(`우선지역 비중      : ${s.prioritySharePercent == null ? '—' : s.prioritySharePercent + '%'}`
  + ` (우선 ${s.priorityTotalMinutes}분 / 전체 ${s.allAreaMinutes}분)`);
console.log(`우선 평균 vs 일반   : ${Math.round(s.priorityAvgMinutes)}분 vs ${Math.round(s.normalAvgMinutes)}분`
  + (s.priorityVsNormal.comparable ? ` (${HDMapPriority.formatPercentDiff(s.priorityVsNormal.percentVsNormalAvg)})` : ''));
if (s.weakestPriority) {
  console.log(`가장 부족한 우선지역: ${s.weakestPriority.name} · ${s.weakestPriority.collectionMinutes}분`
    + (s.weakestPriority.comparable ? ` (${HDMapPriority.formatPercentDiff(s.weakestPriority.percentVsNormalAvg)})` : ''));
}
if (s.missingPolygonAreaNos.length) console.log(`경계 미설정        : ${s.missingPolygonAreaNos.join(', ')}`);
if (s.noDataAreaNos.length) console.log(`경계 안 기록 0건    : ${s.noDataAreaNos.join(', ')}`);
if (s.noCoverageAreaNos.length) console.log(`Coverage 미계산    : ${s.noCoverageAreaNos.join(', ')}`);

db.close();
