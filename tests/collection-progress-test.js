// ══════════════════════════════════════════════════════════
//  collection-progress-test — 달력 맨 위 "전체 데이터 수집 현황"
//
//   A. 수집 시간 규칙(src/js/collection-stats.js) · 진행률 계산
//   B. SQLite 날짜 요약 collectionSec — 날짜·차량 합산, 중복·재등록·삭제·복원·동기화·재시작·마이그레이션
//   C. SQLite ↔ IndexedDB(실제 core.js buildDaySummaryFromPoints) 동등성 — 합성 데이터 + 실제 주행기록
//   D. 달력 화면(src/js/calendar.js) — 표 표시, 일자 요약 주행 시간, 월 이동·날짜 선택 시 재계산 없음
//
//  각 검사는 입력 · 기대값 · 실제값을 함께 출력한다.
//  실행:  node tests/collection-progress-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const CollectionStats = require('../src/js/collection-stats.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { baseContext, load, readSource } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }
const io = (input, expected, actual) => `입력: ${input} | 기대: ${expected} | 실제: ${actual}`;

// ── 테스트 데이터 ──────────────────────────────────────
function hms(sec) {
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}`;
}
// start부터 stepSec 간격으로 count개 — 좌표는 조금씩 이동(중복 제거 키가 서로 다르게)
function session(date, vehicle, start, count, stepSec, latBase) {
  const [h, m, s] = start.split(':').map(Number);
  const t0 = h * 3600 + m * 60 + s;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ date, time: hms(t0 + i * stepSec), vehicle, zone: '강남', lat: (latBase || 37.5) + i * 0.00005, lng: 127.03 + i * 0.00005 });
  }
  return out;
}
const minutesOf = summaries => CollectionStats.summarizeCollection(summaries).totalSec / 60;
function freshPath() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-collect-')), 'route-viewer.db'); }

// 브라우저(IndexedDB) 저장소 — 날짜 요약은 실제 core.js의 buildDaySummaryFromPoints로 만든다
function fakeDocument() {
  const els = new Map();
  const make = () => ({ textContent: '', innerHTML: '', style: {}, className: '', children: [], appendChild(c) { this.children.push(c); }, classList: { add() {}, remove() {}, toggle() {} } });
  return { getElementById: id => { if (!els.has(id)) els.set(id, make()); return els.get(id); }, createElement: make, querySelectorAll: () => [], querySelector: () => null, els };
}
async function createBrowserStorage(fake) {
  const ctx = baseContext({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange, document: fakeDocument(), setInterval: () => 0 });
  ['src/js/quality.js', 'src/js/collection-stats.js', 'src/js/core.js', 'src/js/coverage-grid.js', 'src/js/storage.js'].forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  return ctx.RouteDB;
}

function unitTests() {
  section('A. 수집 시간 규칙 · 진행률');
  const empty = CollectionStats.collectionProgress(CollectionStats.summarizeCollection([]).totalSec);
  check('1. 데이터가 없으면 수집 시간 0분 · 진행률 0.0%',
    empty.collectedMinutes === 0 && empty.rows.every(r => CollectionStats.formatPercent(r.percent) === '0.0%'),
    io('날짜 요약 0개', '0분 / 0.0% / 0.0%', `${empty.collectedMinutes}분 / ${empty.rows.map(r => CollectionStats.formatPercent(r.percent)).join(' / ')}`));

  const oneHour = session('2026-09-01', '토레스 1호', '09:00:00', 121, 30);
  const secHour = CollectionStats.validDurationSec(oneHour);
  check('2. 30초 간격 정상 기록 1시간 → 60분', secHour === 3600, io('09:00:00~10:00:00, 30초 간격 121점', '3600초(60분)', `${secHour}초(${secHour / 60}분)`));

  const twoSessions = [...oneHour, ...session('2026-09-01', '토레스 1호', '14:00:00', 121, 30, 37.51)];
  const secTwo = CollectionStats.validDurationSec(twoSessions);
  const naive = (15 * 3600 - 9 * 3600) / 60;
  check('3. 하루 중 긴 공백(10:00~14:00)은 수집 시간에 포함되지 않는다', secTwo === 7200,
    io('같은 차량 09:00~10:00 + 14:00~15:00', '120분 (단순 마지막-처음이면 ' + naive + '분)', `${secTwo / 60}분`));
  const boundary = CollectionStats.validDurationSec([{ time: '09:00:00', vehicle: 'A' }, { time: '09:01:30', vehicle: 'A' }, { time: '09:03:01', vehicle: 'A' }]);
  check('   공백 기준: 90초 간격은 포함, 91초 간격은 제외', boundary === 90, io('간격 90초, 91초', '90초', `${boundary}초`));

  const twoVehicles = [...oneHour, ...session('2026-09-01', '토레스 2호', '09:00:00', 61, 30, 37.52)];
  const secVeh = CollectionStats.validDurationSec(twoVehicles);
  check('5. 같은 시간대 다른 차량은 각각 따로 더한다', secVeh === 3600 + 1800, io('1호 60분 + 2호 30분(동시간대)', '90분', `${secVeh / 60}분`));

  const dupSession = [...oneHour, ...oneHour.map(r => ({ ...r, lat: r.lat + 0.001 }))];
  const secDup = CollectionStats.validDurationSec(dupSession);
  check('   같은 차량·같은 시간대의 중복 세션(좌표만 다른 기록)은 두 번 세지 않는다', secDup === 3600, io('1시간 세션 2벌', '60분', `${secDup / 60}분`));

  const at = min => CollectionStats.collectionProgress(min * 60);
  const p1000 = at(1000), p1234 = at(1234), p4500 = at(4500);
  const pct = (p, i) => CollectionStats.formatPercent(p.rows[i].percent);
  check('11. KPI 진행률 = 수집 시간 ÷ 4,000분', pct(p1000, 0) === '25.0%' && pct(p1234, 0) === '30.9%',
    io('1,000분 / 1,234분', '25.0% / 30.9%', `${pct(p1000, 0)} / ${pct(p1234, 0)}`));
  check('12. 제안 진행률 = 수집 시간 ÷ 10,000분', pct(p1000, 1) === '10.0%' && pct(p1234, 1) === '12.3%',
    io('1,000분 / 1,234분', '10.0% / 12.3%', `${pct(p1000, 1)} / ${pct(p1234, 1)}`));
  check('13. 목표를 넘으면 100% 넘는 실제 값 그대로(막대만 100%)',
    pct(p4500, 0) === '112.5%' && p4500.rows[0].barPercent === 100 && pct(p4500, 1) === '45.0%',
    io('4,500분', 'KPI 112.5%(막대 100) / 제안 45.0%', `${pct(p4500, 0)}(막대 ${p4500.rows[0].barPercent}) / ${pct(p4500, 1)}`));
  check('   두 행 모두 같은 현재 수집 시간을 쓴다', p1234.rows.every(r => r.collectedMinutes === 1234));
  check('   목표값은 한 곳(COLLECTION_TARGETS)에서 관리',
    JSON.stringify(CollectionStats.COLLECTION_TARGETS.map(t => [t.label, t.targetClips, t.targetMinutes])) === JSON.stringify([['KPI', 8000, 4000], ['제안', 20000, 10000]]));
}

// 같은 시나리오를 SQLite(RouteDatabase)와 IndexedDB(RouteDB) 양쪽에 돌리기 위한 얇은 어댑터
function sqliteAdapter(dbPath) {
  let db = new RouteDatabase(dbPath);
  return {
    label: 'SQLite',
    importRecords: async (r, m) => db.importRecords(r, m),
    summaries: async () => db.listDateSummaries(),
    deleteDate: async d => db.deleteDate(d),
    backup: async () => db.buildBackupPayload(),
    restore: async (p, mode) => db.restoreBackupPayload(p, mode),
    reopen: async () => { db.close(); db = new RouteDatabase(dbPath); },
    fresh: async () => sqliteAdapter(freshPath()),
    close: () => db.close(),
    raw: () => db,
  };
}
async function idbAdapter(fake) {
  let RouteDB = await createBrowserStorage(fake);
  return {
    label: 'IndexedDB',
    importRecords: (r, m) => RouteDB.importRecords(r, m),
    summaries: () => RouteDB.listDateSummaries(),
    deleteDate: d => RouteDB.deleteDate(d),
    backup: () => RouteDB.buildBackupPayload(),
    restore: (p, mode) => RouteDB.restoreBackupPayload(p, mode),
    reopen: async () => { RouteDB = await createBrowserStorage(fake); },
    fresh: async () => idbAdapter(createFakeIndexedDB()),
    close: () => {},
  };
}

async function scenario(store, results) {
  const step = async (label, expectedMin) => {
    const actual = minutesOf(await store.summaries());
    results.push([label, actual]);
    return actual;
  };
  const A = session('2026-09-01', '토레스 1호', '09:00:00', 121, 30);
  const B = session('2026-09-01', '토레스 1호', '14:00:00', 121, 30, 37.51);
  const C = session('2026-09-02', '토레스 1호', '10:00:00', 121, 30, 37.53);
  const D = session('2026-09-01', '토레스 2호', '09:00:00', 61, 30, 37.52);
  const E = session('2026-09-03', '토레스 3호', '11:00:00', 61, 30, 37.54);
  const L = store.label;

  let m = await step('empty');
  check(`[${L}] 1. 데이터 없음 → 0분`, m === 0, io('빈 DB', '0분', `${m}분`));
  await store.importRecords([...A, ...B], { filename: 'day1-v1.xlsx' });
  m = await step('day1');
  check(`[${L}] 3. 하루 두 세션(긴 공백 제외)`, m === 120, io('09-01 1호 09~10시 + 14~15시', '120분', `${m}분`));
  await store.importRecords(C, { filename: 'day2.xlsx' });
  m = await step('day2');
  check(`[${L}] 4. 여러 날짜 합산`, m === 180, io('+ 09-02 1호 1시간', '180분', `${m}분`));
  await store.importRecords(D, { filename: 'day1-v2.xlsx' });
  m = await step('vehicle2');
  check(`[${L}] 5. 여러 차량 합산(같은 시간대라도 차량별로)`, m === 210, io('+ 09-01 2호 09:00~09:30', '210분', `${m}분`));
  await store.importRecords([...A, ...B], { filename: 'day1-v1.xlsx' });
  await store.importRecords(D, { filename: 'day1-v2 (복사본).xlsx' });
  m = await step('reimport');
  check(`[${L}] 6. 같은 파일을 다시 등록해도 늘지 않는다(중복 제거된 DB 기준)`, m === 210, io('같은 파일 2개 재등록', '210분', `${m}분`));
  await store.importRecords(A.map(r => ({ ...r, lat: r.lat + 0.002 })), { filename: 'overlap.xlsx' });
  m = await step('overlap');
  check(`[${L}]    같은 차량·같은 시간대 중복 세션(좌표만 다름)은 더하지 않는다`, m === 210, io('1호 09~10시를 다른 좌표로 한 벌 더', '210분', `${m}분`));
  await store.deleteDate('2026-09-02');
  m = await step('delete');
  check(`[${L}] 7. 날짜 삭제 → 그만큼 줄어든다`, m === 150, io('09-02 삭제', '150분', `${m}분`));

  const payload = await store.backup();
  const restored = await store.fresh();
  await restored.restore(payload, 'merge');
  const mr = minutesOf(await restored.summaries());
  results.push(['restore', mr]);
  check(`[${L}] 8. 백업을 새 DB에 복원하면 값이 그대로 복구된다`, mr === 150, io('백업 → 빈 DB 병합 복원', '150분', `${mr}분`));
  if (restored.close) restored.close();

  // 서버 동기화 = 서버 payload를 restoreBackupPayload(merge)로 병합(electron/main.js sync:run과 같은 경로)
  const serverPayload = { ...payload, data: { ...payload.data, '2026-09-03': E } };
  await store.restore(serverPayload, 'merge');
  m = await step('sync');
  check(`[${L}] 9. 서버 동기화 → 새 데이터(09-03 30분)만 더해진다`, m === 180, io('기존 전부 + 새 날짜 30분', '180분', `${m}분`));
  await store.restore(serverPayload, 'merge');
  m = await step('sync-again');
  check(`[${L}]    같은 동기화를 반복해도 늘지 않는다`, m === 180, io('같은 payload 한 번 더', '180분', `${m}분`));
  await store.reopen();
  m = await step('restart');
  check(`[${L}] 10. 앱 재시작(DB 다시 열기) 후에도 같은 값`, m === 180, io('닫았다 다시 열기', '180분', `${m}분`));
}

async function storageTests() {
  section('B. SQLite — 날짜 요약의 유효 수집 시간');
  const sqlitePath = freshPath();
  const sqlite = sqliteAdapter(sqlitePath);
  const sqliteSteps = [];
  await scenario(sqlite, sqliteSteps);

  const raw = sqlite.raw();
  raw.db.run('UPDATE date_summaries SET summary_json = ?', [JSON.stringify({ zones: [], vehicles: [] })]);
  raw.setMeta('summary_version', '1');
  const before = minutesOf(raw.listDateSummaries());
  await sqlite.reopen();
  const after = minutesOf(sqlite.raw().listDateSummaries());
  check('   기존 데이터 마이그레이션: collectionSec 없는 예전 요약 → 앱을 켤 때 다시 만들어 채운다',
    before === 0 && after === 180 && sqlite.raw().getMeta('summary_version') === String(CollectionStats.SUMMARY_VERSION),
    io('요약에서 collectionSec 제거 + summary_version=1', '다시 열면 180분', `${before}분 → ${after}분`));
  const rebuiltCount = sqlite.raw().rebuildAllSummaries();
  check('   날짜 요약 재생성(rebuildAllSummaries) 후에도 같은 값',
    minutesOf(sqlite.raw().listDateSummaries()) === 180, io(`${rebuiltCount}일 재생성`, '180분', `${minutesOf(sqlite.raw().listDateSummaries())}분`));
  sqlite.close();

  section('C. IndexedDB(브라우저 모드) — 같은 시나리오');
  const fake = createFakeIndexedDB();
  const idb = await idbAdapter(fake);
  const idbSteps = [];
  await scenario(idb, idbSteps);
  const rows = fake.rawStore('route-viewer', 'summaries');
  rows.forEach((v, k) => { const { collectionSec, ...rest } = v; rows.set(k, rest); });
  fake.rawStore('route-viewer', 'meta').set('summary_version', { key: 'summary_version', value: 1 });
  await idb.reopen();
  const idbAfter = minutesOf(await idb.summaries());
  check('   IndexedDB 마이그레이션: 예전 요약도 앱을 켤 때 다시 만들어 채운다', idbAfter === 180, io('collectionSec 제거 + 버전 1', '180분', `${idbAfter}분`));
  check('14. 모든 단계에서 SQLite와 IndexedDB 결과가 같다',
    JSON.stringify(sqliteSteps) === JSON.stringify(idbSteps), sqliteSteps.map(([k, v], i) => `${k}:${v}/${idbSteps[i] && idbSteps[i][1]}`).join(' '));

  section('C-2. 실제 주행기록(주행기록/ 폴더)로 SQLite ↔ IndexedDB 비교');
  const dir = path.join(__dirname, '..', '주행기록');
  const files = fs.readdirSync(dir).filter(f => /\.xlsx?$/i.test(f)).sort();
  const realDb = new RouteDatabase(freshPath());
  const realIdb = await createBrowserStorage(createFakeIndexedDB());
  for (const f of files) {
    const recs = RouteParser.parseBuffer(fs.readFileSync(path.join(dir, f)));
    realDb.importRecords(recs, { filename: f });
    await realIdb.importRecords(recs, { filename: f });
  }
  const sSum = realDb.listDateSummaries();
  const iSum = await realIdb.listDateSummaries();
  const perDate = s => s.map(r => `${r.date}:${r.collectionSec}`).join(',');
  const realMin = minutesOf(sSum);
  const naiveMin = sSum.reduce((acc, r) => acc + (CollectionStats.timeToSec(r.endTime) - CollectionStats.timeToSec(r.startTime)) / 60, 0);
  check('   실제 기록: 날짜별 수집 시간이 두 저장소에서 같다', perDate(sSum) === perDate(iSum),
    `${files.length}개 파일 · ${sSum.length}일 · 수집 ${Math.round(realMin).toLocaleString('ko-KR')}분 (단순 마지막-처음 합이면 ${Math.round(naiveMin).toLocaleString('ko-KR')}분)`);
  const prog = CollectionStats.collectionProgress(realMin * 60);
  console.log(`         현재 저장소 주행기록 기준 진행률: KPI ${CollectionStats.formatPercent(prog.rows[0].percent)} · 제안 ${CollectionStats.formatPercent(prog.rows[1].percent)}`);
  realDb.close();
}

async function calendarTests() {
  section('D. 달력 화면 — 표 · 일자 요약 · 불필요한 재계산 없음');
  const doc = fakeDocument();
  let summaries = [];
  let listCalls = 0;
  const dayRecords = [...session('2026-09-01', '토레스 1호', '09:00:00', 121, 30), ...session('2026-09-01', '토레스 1호', '14:00:00', 121, 30, 37.51)];
  const ctx = baseContext({
    document: doc, setInterval: () => 0,
    RouteDB: {
      listDateSummaries: async () => { listCalls++; return summaries; },
      getRecordsByDate: async () => dayRecords,
    },
    clearError() {}, showError() {}, renderConsole() {}, switchTab() {},
  });
  ['src/js/quality.js', 'src/js/collection-stats.js', 'src/js/core.js', 'src/js/calendar.js'].forEach(f => load(ctx, f));
  const run = code => vm.runInContext(code, ctx);
  const tableText = () => doc.getElementById('cp-body').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  await run('refreshDateIndex()');
  check('1. 데이터가 없을 때 표: 수집 시간 0 · 진행률 0.0% (빈칸 아님)',
    /KPI 8,000 4,000 0 0\.0%/.test(tableText()) && /제안 20,000 10,000 0 0\.0%/.test(tableText()) && doc.getElementById('cp-latest').textContent === '최근 데이터: 없음',
    io('날짜 요약 0개', 'KPI 8,000 4,000 0 0.0% / 제안 20,000 10,000 0 0.0%', tableText()));

  summaries = [
    { date: '2026-08-31', count: 10, collectionSec: 1234 * 60 - 3600 },
    { date: '2026-09-01', count: 242, collectionSec: 3600, startTime: '09:00:00', endTime: '15:00:00' },
  ];
  await run('refreshDateIndex()');
  check('6. 천 단위 구분 · 두 행이 같은 수집 시간 · 진행률 소수 첫째 자리',
    /KPI 8,000 4,000 1,234 30\.9%/.test(tableText()) && /제안 20,000 10,000 1,234 12\.3%/.test(tableText()),
    io('날짜 요약 합 1,234분', 'KPI … 1,234 30.9% / 제안 … 1,234 12.3%', tableText()));
  check('   최근 데이터 = DB의 가장 최신 기록 날짜', doc.getElementById('cp-latest').textContent === '최근 데이터: 2026-09-01', doc.getElementById('cp-latest').textContent);
  check('   진행률 막대 너비', /width:30\.85%/.test(doc.getElementById('cp-body').innerHTML) && /width:12\.34%/.test(doc.getElementById('cp-body').innerHTML));

  summaries = [{ date: '2026-09-10', count: 1, collectionSec: 4500 * 60 }];
  await run('refreshDateIndex()');
  check('13. 목표 초과: 112.5% 그대로 표시, 막대만 100%',
    /KPI 8,000 4,000 4,500 112\.5%/.test(tableText()) && /width:100\.00%/.test(doc.getElementById('cp-body').innerHTML), tableText());

  summaries = [
    { date: '2026-08-31', count: 10, collectionSec: 1234 * 60 - 3600 },
    { date: '2026-09-01', count: 242, collectionSec: 3600 * 2, startTime: '09:00:00', endTime: '15:00:00' },
  ];
  await run('refreshDateIndex()');
  const comp = run('collectionStats.computations');
  const calls = listCalls;
  run('calMonth=new Date(2026,8,1); renderCalendarGrid(); calShiftMonth(1); calShiftMonth(-1); calShiftMonth(-1); calGoToday();');
  await run("openDayDetail('2026-09-01')");
  check('16. 월 이동·날짜 선택만으로는 전체 집계를 다시 하지 않는다(DB 요약 조회도 없음)',
    run('collectionStats.computations') === comp && listCalls === calls,
    io('월 이동 4번 + 날짜 선택 1번', `집계 ${comp}회·조회 ${calls}회 그대로`, `집계 ${run('collectionStats.computations')}회·조회 ${listCalls}회`));
  const dayText = doc.getElementById('day-summary').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const dayHours = (dayText.match(/주행 시간 ([\d.]+) h \((\d+)분\)/) || []);
  check('15. 일자 요약 "주행 시간"도 같은 규칙(09:00~15:00 사이 쉬는 시간 제외 → 2.0 h, 120분)',
    dayHours[1] === '2.0' && dayHours[2] === '120',
    io('09-01 요약 collectionSec 7200 · 기록 09:00~15:00', '2.0 h (120분) — 예전 방식이면 6.0 h', dayHours[0] || dayText));
  const tableMinutes = Number((tableText().match(/KPI 8,000 4,000 ([\d,]+)/) || [])[1].replace(/,/g, ''));
  check('   표의 수집 시간 = 일자 요약 주행 시간의 합과 같은 값', tableMinutes === Math.round((1234 * 60 - 3600 + 7200) / 60), io('08-31 + 09-01', '1,294분', `${tableMinutes}분`));
}

async function main() {
  unitTests();
  await storageTests();
  await calendarTests();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed) {
    console.log('\n  실패 항목:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
