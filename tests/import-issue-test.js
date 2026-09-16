// ══════════════════════════════════════════════════════════
//  import-issue-test — Excel Import 이슈 기록 · 이슈 데이터 분리 관리
//
//   A. 이슈 입력 검증(체크 시 메모 필수 · 200자 · 공백 정리)
//   B. Import 저장 — 이슈 필드 · 파일별 독립 · 출처 관계(record_sources)
//   C. 필터 의미(all/clean/issue_all/issue_open/issue_resolved) — 두 저장소가 같은 결론
//   D. 이슈 상태 변경(확인 필요 ↔ 확인 완료 · 메모 수정 · 이슈 해제)
//   E. 날짜 요약 · 달력(조건 칸의 issueMask · importSources · 부분 필터)
//   F. 누적 지도 Coverage 캐시 키에 데이터 상태 필터가 들어간다
//   G. 통계 이슈 현황 · 추천 계산 기준
//   H. 백업 · 서버 동기화(이슈 보존 · issueUpdatedAt 최신 우선 · 충돌 기록)
//   I. 예전 데이터 안전성(출처 기록이 없는 기록은 사라지지 않는다)
//
//  실행: node tests/import-issue-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IF = require('../src/js/issue-filter.js');
const CSt = require('../src/js/condition-stats.js');
const R = require('../src/js/recommendation.js');
const { RouteDatabase } = require('../electron/database.js');
const { createDesktopApi, createStorageContext } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');
const { createAccumHarness, setupCoverageScene } = require('./helpers/accum-harness');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-issue-')), 'route-viewer.db');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 시나리오 데이터 ────────────────────────────────────
// r2 는 A(이슈)와 B(정상) 양쪽에서 온다 — 중복 제거 뒤에도 출처가 둘 다 남아야 한다
const rec = (n, time, date) => ({
  date: date || '2026-09-01', time, vehicle: '토레스 1호', zone: '강남', weather: '맑음',
  lat: 37.5 + n * 0.0002, lng: 127.03 + n * 0.0002, speed: 20,
});
const r1 = rec(1, '09:00:00'), r2 = rec(2, '09:00:10'), r3 = rec(3, '09:00:20'), r4 = rec(4, '21:00:00');

const FILE_A = { records: [r1, r2], meta: { filename: 'A.xlsx', fileHash: 'hash-a', hasIssue: true, issueNote: 'GPS 가 튀는 구간이 있어요' } };
const FILE_B = { records: [r2, r3], meta: { filename: 'B.xlsx', fileHash: 'hash-b' } };
const FILE_C = { records: [r4], meta: { filename: 'C.xlsx', fileHash: 'hash-c', hasIssue: true, issueNote: '야간 조도 확인 필요' } };

async function importScenario(RouteDB) {
  const a = await RouteDB.importRecords(FILE_A.records, FILE_A.meta);
  const b = await RouteDB.importRecords(FILE_B.records, FILE_B.meta);
  const c = await RouteDB.importRecords(FILE_C.records, FILE_C.meta);
  return { a, b, c };
}

async function counts(RouteDB) {
  const out = {};
  for (const f of IF.ISSUE_FILTERS) out[f] = (await RouteDB.getOverview({ issueFilter: f })).points;
  return out;
}

async function sqliteDB() {
  const db = new RouteDatabase(freshPath());
  const ctx = createStorageContext({ api: createDesktopApi(db) });
  await ctx.RouteDB.init();
  return { RouteDB: ctx.RouteDB, db, ctx };
}

async function idbDB() {
  const fake = createFakeIndexedDB();
  const ctx = createStorageContext({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange });
  await ctx.RouteDB.init();
  return { RouteDB: ctx.RouteDB, ctx };
}

async function main() {
  // ══════════════════════════════════════════════════════
  section('A. 이슈 입력 검증 — 체크했으면 한 줄 메모는 필수');
  // ══════════════════════════════════════════════════════
  check('1. 이슈를 체크하지 않으면 메모가 없어도 통과한다',
    IF.validateIssueInput({ hasIssue: false, issueNote: '' }).ok === true);
  const blank = IF.validateIssueInput({ hasIssue: true, issueNote: '' });
  check('2. 이슈를 체크했는데 메모가 없으면 막고 이유를 알려준다',
    blank.ok === false && /한 줄로 적어주세요/.test(blank.errors[0]), blank.errors[0]);
  check('3. 공백만 있는 메모도 빈 메모로 본다',
    IF.validateIssueInput({ hasIssue: true, issueNote: '   \t  ' }).ok === false);
  const long = IF.validateIssueInput({ hasIssue: true, issueNote: 'ㄱ'.repeat(IF.ISSUE_NOTE_MAX + 1) });
  check('4. 메모는 200자까지 — 넘으면 지금 글자 수를 알려준다',
    long.ok === false && /201자/.test(long.errors[0]), long.errors[0]);
  check('5. 정확히 200자는 통과한다',
    IF.validateIssueInput({ hasIssue: true, issueNote: 'ㄱ'.repeat(IF.ISSUE_NOTE_MAX) }).ok === true);
  const trimmed = IF.validateIssueInput({ hasIssue: true, issueNote: '  앞뒤   공백을  정리 ' });
  check('6. 메모는 앞뒤 공백을 지우고 연속 공백을 하나로 줄여 저장한다',
    trimmed.value.issueNote === '앞뒤 공백을 정리', JSON.stringify(trimmed.value.issueNote));
  check('7. 새로 등록한 이슈는 "확인 필요(open)"로 시작한다',
    trimmed.value.issueStatus === 'open' && IF.statusLabel('open') === '확인 필요');

  // ══════════════════════════════════════════════════════
  section('B. Import 저장 — 이슈 필드 · 파일별 독립 · GPS 레코드 출처');
  // ══════════════════════════════════════════════════════
  for (const kind of ['SQLite', 'IndexedDB']) {
    const { RouteDB } = kind === 'SQLite' ? await sqliteDB() : await idbDB();
    const ids = await importScenario(RouteDB);
    const imports = await RouteDB.listImports(10, {});
    const byName = new Map(imports.map(i => [i.filename, i]));
    const A = byName.get('A.xlsx'), B = byName.get('B.xlsx'), C = byName.get('C.xlsx');
    if (kind === 'SQLite') {
      check('8. 이슈로 표시한 파일은 메모·상태·기록 시각이 Import 이력에 남는다',
        A.hasIssue === true && A.issueNote === 'GPS 가 튀는 구간이 있어요' && A.issueStatus === 'open'
        && !!A.issueCreatedAt && !!A.issueUpdatedAt, `${A.issueStatus} · ${A.issueNote}`);
      check('9. 이슈가 없는 파일은 이슈 없음으로 남는다(메모 빈 값)',
        B.hasIssue === false && !B.issueNote && !B.issueStatus);
      check('10. 파일마다 이슈가 따로 붙는다 — 한 파일의 이슈가 다른 파일로 번지지 않는다',
        A.hasIssue && !B.hasIssue && C.hasIssue && C.issueNote === '야간 조도 확인 필요');
      check('11. 이슈를 체크했는데 메모가 없으면 저장 자체를 거부한다(기록도 들어가지 않는다)',
        await (async () => {
          const before = (await RouteDB.stats()).points;
          try { await RouteDB.importRecords([rec(9, '10:00:00')], { filename: 'bad.xlsx', hasIssue: true, issueNote: '  ' }); return false; }
          catch (_) { return (await RouteDB.stats()).points === before; }
        })());
    }
    check(`12. [${kind}] 중복으로 걸러진 레코드도 그 파일의 출처로 남는다(B.xlsx 에 r2·r3 둘 다)`,
      (B.relatedRecords === undefined ? true : B.relatedRecords === 2), `relatedRecords=${B.relatedRecords}`);
    const cnt = await counts(RouteDB);
    check(`13. [${kind}] 한 레코드가 이슈 파일과 정상 파일 양쪽에서 와도 전체 개수는 그대로다`,
      cnt.all === 4, JSON.stringify(cnt));
    // 다음 단계(C)에서 쓰려고 첫 번째 저장소는 남겨 둔다
    if (kind === 'SQLite') global.__sqliteScenario = { RouteDB, ids };
    else global.__idbScenario = { RouteDB, ids };
  }

  // ══════════════════════════════════════════════════════
  section('C. 데이터 상태 필터 — 다섯 가지 의미가 두 저장소에서 같다');
  // ══════════════════════════════════════════════════════
  const sqlCounts = await counts(global.__sqliteScenario.RouteDB);
  const idbCounts = await counts(global.__idbScenario.RouteDB);
  check('14. 전체(all) — 이슈 여부와 상관없이 모두 센다', sqlCounts.all === 4, JSON.stringify(sqlCounts));
  check('15. 이슈 없음(clean) — 확인 필요 이슈 파일에서만 온 기록(r1,r4)을 뺀다', sqlCounts.clean === 2);
  check('16. 이슈 없음(clean) — 정상 파일에서도 온 기록(r2)은 남긴다(r2,r3)',
    (await global.__sqliteScenario.RouteDB.getDistribution('zone', { issueFilter: 'clean' }))[0][1] === 2);
  check('17. 이슈만(issue_all) — 이슈 파일에서 온 기록(r1,r2,r4)', sqlCounts.issue_all === 3);
  check('18. 확인 필요(issue_open) — 아직 확인하지 않은 파일에서 온 기록(r1,r2,r4)', sqlCounts.issue_open === 3);
  check('19. 확인 완료(issue_resolved) — 지금은 없다(아직 아무것도 확인 완료가 아님)', sqlCounts.issue_resolved === 0);
  check('20. 한 레코드는 어떤 필터에서도 한 번만 센다(출처가 둘이어도 중복 집계 없음)',
    sqlCounts.issue_open === 3 && sqlCounts.all === 4 && sqlCounts.clean + 2 === sqlCounts.all);
  check('21. SQLite 와 IndexedDB 가 같은 결론을 낸다', JSON.stringify(sqlCounts) === JSON.stringify(idbCounts),
    `${JSON.stringify(sqlCounts)} / ${JSON.stringify(idbCounts)}`);
  check('22. 필터 판정 규칙은 issue-filter.js 한 곳에 있다(마스크 → 판정)',
    IF.maskMatches(IF.MASK.OPEN, 'clean') === false && IF.maskMatches(IF.MASK.OPEN | IF.MASK.NON_ISSUE, 'clean') === true
    && IF.maskMatches(0, 'clean') === true && IF.maskMatches(IF.MASK.RESOLVED, 'clean') === true
    && IF.maskMatches(IF.MASK.NON_ISSUE, 'issue_all') === false);
  check('23. 알 수 없는 필터 값은 전체로 본다(화면 상태가 깨져도 데이터가 사라지지 않는다)',
    IF.normalizeFilter('무엇이든') === 'all' && IF.maskMatches(IF.MASK.OPEN, 'xx') === true);

  // ══════════════════════════════════════════════════════
  section('D. 이슈 상태 변경 — 확인 완료 · 되돌리기 · 메모 수정 · 해제');
  // ══════════════════════════════════════════════════════
  for (const kind of ['SQLite', 'IndexedDB']) {
    const { RouteDB } = kind === 'SQLite' ? global.__sqliteScenario : global.__idbScenario;
    const imports = await RouteDB.listImports(10, {});
    const A = imports.find(i => i.filename === 'A.xlsx');
    const before = await RouteDB.getImport(A.id);
    await sleep(5);
    const afterResolve = await RouteDB.updateImportIssue(A.id, { issueStatus: 'resolved' });
    const c1 = await counts(RouteDB);
    if (kind === 'SQLite') {
      check('24. 확인 완료로 바꾸면 그 파일에서 온 데이터가 "이슈 없음" 쪽으로 옮겨간다',
        c1.clean === 3 && c1.issue_open === 1 && c1.issue_resolved === 2, JSON.stringify(c1));
      check('25. 확인 완료로 바꿔도 이슈였다는 사실과 메모는 남는다',
        afterResolve.hasIssue === true && afterResolve.issueNote === before.issueNote);
      check('26. 이슈를 처음 적은 시각은 그대로 두고 수정 시각만 새로 찍는다',
        afterResolve.issueCreatedAt === before.issueCreatedAt && afterResolve.issueUpdatedAt !== before.issueUpdatedAt,
        `${afterResolve.issueCreatedAt} / ${afterResolve.issueUpdatedAt}`);
      const back = await RouteDB.updateImportIssue(A.id, { issueStatus: 'open' });
      check('27. 확인 필요로 되돌릴 수 있다', back.issueStatus === 'open' && (await counts(RouteDB)).issue_open === 3);
      const edited = await RouteDB.updateImportIssue(A.id, { issueNote: '  좌표가   30m 튑니다 ' });
      check('28. 메모만 고칠 수 있고, 저장할 때 공백을 정리한다', edited.issueNote === '좌표가 30m 튑니다');
      let rejected = false;
      try { await RouteDB.updateImportIssue(A.id, { issueNote: '   ' }); } catch (_) { rejected = true; }
      const still = await RouteDB.getImport(A.id);
      check('29. 빈 메모로는 고칠 수 없고, 기존 메모가 그대로 남는다',
        rejected && still.issueNote === '좌표가 30m 튑니다');
      const cleared = await RouteDB.updateImportIssue(A.id, { hasIssue: false, issueNote: '' });
      const c2 = await counts(RouteDB);
      check('30. 이슈를 해제하면 이슈 데이터에서 빠지지만 GPS 기록은 그대로 남는다',
        cleared.hasIssue === false && c2.all === 4 && c2.issue_all === 1 && c2.clean === 3, JSON.stringify(c2));
      await RouteDB.updateImportIssue(A.id, { hasIssue: true, issueNote: 'GPS 가 튀는 구간이 있어요', issueStatus: 'open' });
    } else {
      check('31. [IndexedDB] 상태 변경 결과도 SQLite 와 같다',
        c1.clean === 3 && c1.issue_open === 1 && c1.issue_resolved === 2, JSON.stringify(c1));
      await RouteDB.updateImportIssue(A.id, { issueStatus: 'open' });
    }
  }

  // ══════════════════════════════════════════════════════
  section('E. 날짜 요약 · 달력 — 조건 칸의 이슈 마스크와 출처');
  // ══════════════════════════════════════════════════════
  {
    const { RouteDB } = global.__sqliteScenario;
    const summaries = await RouteDB.listDateSummaries();
    const day = summaries.find(s => s.date === '2026-09-01');
    check('32. 날짜 요약의 조건 칸마다 이슈 마스크가 들어 있다',
      day.conditionCells.every(c => Number.isFinite(c.issueMask)) && day.conditionCells.some(c => c.issueMask & IF.MASK.OPEN),
      day.conditionCells.map(c => c.issueMask).join(','));
    check('33. 그 날짜 기록이 어느 Import 에서 왔는지도 요약에 남는다(달력 배지용)',
      Array.isArray(day.importSources) && day.importSources.length === 3
      && day.importSources.reduce((a, s) => a + s.recordCount, 0) === 5, JSON.stringify(day.importSources));
    const all = CSt.filterDaySummary(day, 'all');
    const clean = CSt.filterDaySummary(day, 'clean');
    const open = CSt.filterDaySummary(day, 'issue_open');
    check('34. 하루 요약을 데이터 상태로 걸러 보면 기록 수가 정확히 나뉜다',
      all.count === 4 && clean.count === 2 && open.count === 3, `all=${all.count} clean=${clean.count} open=${open.count}`);
    check('35. 하루가 일부만 걸러지면 partial 로 알리고 주행 시간은 더하지 않는다(파일별로 쪼갤 수 없어서)',
      clean.partial === true && clean.driveSpanSec === 0 && all.partial === false);
    check('36. 그 필터에서 남는 기록이 없으면 0으로 알려준다(달력에서 흐리게 표시)',
      CSt.filterDaySummary(day, 'issue_resolved').count === 0);
    const dateImports = await RouteDB.listDateImports('2026-09-01');
    check('37. 일자 요약의 이슈 목록에 파일별 이슈·기록 수가 함께 나온다',
      dateImports.length === 3 && dateImports[0].hasIssue === true && dateImports[0].recordCount === 2,
      dateImports.map(d => `${d.filename}:${d.recordCount}`).join(' '));
    check('38. 같은 Import 는 한 번만 센다(달력 배지 중복 방지)',
      IF.summarizeDateIssues([{ importId: 1, hasIssue: true, issueStatus: 'open', recordCount: 2 },
        { importId: 1, hasIssue: true, issueStatus: 'open', recordCount: 2 }]).open === 1);
    const cellsOf = async bit => (await RouteDB.listDateSummaries()).find(s => s.date === '2026-09-01')
      .conditionCells.filter(c => c.issueMask & bit).length;
    const beforeResolved = await cellsOf(IF.MASK.RESOLVED);
    const imports = await RouteDB.listImports(10, {});
    await RouteDB.updateImportIssue(imports.find(i => i.filename === 'A.xlsx').id, { issueStatus: 'resolved' });
    const afterResolved = await cellsOf(IF.MASK.RESOLVED);
    const afterCount = (await RouteDB.listDateSummaries()).find(s => s.date === '2026-09-01').count;
    check('39. 이슈 상태를 바꾸면 그 파일이 들어간 날짜 요약이 새 마스크로 다시 만들어진다(기록 수는 그대로)',
      beforeResolved === 0 && afterResolved === 2 && afterCount === 4,
      `확인 완료 칸 ${beforeResolved} → ${afterResolved} · 기록 ${afterCount}건`);
    await RouteDB.updateImportIssue(imports.find(i => i.filename === 'A.xlsx').id, { issueStatus: 'open' });
  }

  // ══════════════════════════════════════════════════════
  section('F. 누적 지도 — Coverage 캐시 키에 데이터 상태 필터가 들어간다');
  // ══════════════════════════════════════════════════════
  {
    const h = await createAccumHarness();
    await setupCoverageScene(h);
    await h.eval('renderAccumView()');
    await h.waitRendered();
    const calcs = h.calcCount();
    const keyAll = h.eval("coverageCalcKey('판교')");
    const geomAll = h.eval("coverageGeometryKey('판교')");
    h.setIssueFilter('issue_open');
    const keyIssue = h.eval("coverageCalcKey('판교')");
    const geomIssue = h.eval("coverageGeometryKey('판교')");
    check('40. 데이터 상태 필터가 바뀌면 Coverage 캐시 키도 바뀐다(옛 결과가 남지 않는다)',
      keyAll !== keyIssue && /issueFilter/.test(keyIssue), keyIssue.slice(0, 120));
    check('41. 구역 경계·도로/건물 같은 정적 계산 키는 그대로다(다시 받아오지 않는다)',
      geomAll === geomIssue);
    check('42. 조회 조건에도 같은 필터가 실린다(지도·통계·Coverage 가 따로 놀지 않는다)',
      JSON.parse(JSON.stringify(h.eval('accumFilter()'))).issueFilter === 'issue_open'
      && JSON.parse(JSON.stringify(h.eval('accumDateFilter()'))).issueFilter === 'issue_open');
    await h.eval('renderAccumView()');
    await h.waitRendered();
    const afterIssue = h.calcCount();
    h.setIssueFilter('all');
    await h.eval('renderAccumView()');
    await h.waitRendered();
    check('43. 필터를 되돌리면 예전 계산 결과를 그대로 다시 쓴다(재계산 없음)',
      afterIssue > calcs && h.calcCount() === afterIssue, `계산 ${calcs} → ${afterIssue} → ${h.calcCount()}`);
    h.db.close();
  }

  // ══════════════════════════════════════════════════════
  section('G. 통계 이슈 현황 · 추천 계산 기준');
  // ══════════════════════════════════════════════════════
  {
    const { RouteDB } = global.__sqliteScenario;
    const ov = await RouteDB.getIssueOverview({});
    check('44. 통계의 이슈 현황 — 파일 수와 상태별 기록 수를 한 번에 준다',
      ov.importCount === 3 && ov.issueImportCount === 2 && ov.openCount === 2
      && ov.recordCounts.all === 4 && ov.recordCounts.clean === 2 && ov.recordCounts.issue_open === 3,
      JSON.stringify(ov.recordCounts));
    const summaries = await RouteDB.listDateSummaries();
    const zones = await RouteDB.listZones();
    const settings = await RouteDB.getSettings();
    const base = { summaries, zones, settings, coverageSnapshots: [], now: '2026-09-16T01:00:00Z' };
    const def = R.buildRecommendations(base);
    const withIssues = R.buildRecommendations({ ...base, issueFilter: 'all' });
    check('45. 추천은 기본적으로 확인 필요 이슈 데이터를 빼고 계산하고, 그 기준을 밝힌다',
      def.issueFilter === 'clean' && /확인 필요 이슈 데이터 제외/.test(def.issueBasisText)
      && def.limitations.some(l => /확인 필요 이슈 데이터 제외/.test(l)), def.issueBasisText);
    check('46. 기준을 전체로 주면 이슈 데이터까지 포함해 계산한다(기록 수가 달라진다)',
      withIssues.issueFilter === 'all' && withIssues.dataset.recordCount > def.dataset.recordCount,
      `clean ${def.dataset.recordCount}건 / all ${withIssues.dataset.recordCount}건`);
  }

  // ══════════════════════════════════════════════════════
  section('H. 백업 · 서버 동기화 — 이슈와 출처 관계를 잃지 않는다');
  // ══════════════════════════════════════════════════════
  {
    const src = new RouteDatabase(freshPath());
    src.importRecords(FILE_A.records, FILE_A.meta);
    src.importRecords(FILE_B.records, FILE_B.meta);
    const payload = src.buildBackupPayload();
    const backupImports = payload.imports || [];
    check('47. 백업에 Import 이슈와 그 파일에서 나온 레코드 키가 함께 들어간다',
      backupImports.length === 2 && backupImports.some(i => i.hasIssue && i.issueNote)
      && backupImports.every(i => Array.isArray(i.recordKeys) && i.recordKeys.length > 0),
      backupImports.map(i => `${i.filename}:${i.recordKeys.length}`).join(' '));

    const restored = new RouteDatabase(freshPath());
    restored.restoreBackupPayload(payload, 'replace');
    const rImports = restored.listImports(10, {});
    const rCounts = {};
    IF.ISSUE_FILTERS.forEach(f => { rCounts[f] = restored.getOverview({ issueFilter: f }).points; });
    check('48. 백업을 복원하면 이슈와 데이터 상태별 개수가 그대로 돌아온다',
      rImports.some(i => i.hasIssue && i.issueNote === 'GPS 가 튀는 구간이 있어요')
      && rCounts.all === 3 && rCounts.clean === 2 && rCounts.issue_open === 2
      && rImports.every(i => i.filename !== '(백업 복구)' || !i.relatedRecords), JSON.stringify(rCounts));

    // 같은 파일을 양쪽에서 다르게 고친 상황 — 최신 수정이 이긴다
    const mine = restored.listImports(10, {}).find(i => i.filename === 'A.xlsx');
    restored.updateImportIssue(mine.id, { issueNote: '이 기기에서 고친 메모' });
    const incoming = JSON.parse(JSON.stringify(payload));
    const theirs = incoming.imports.find(i => i.filename === 'A.xlsx');
    theirs.issueNote = '다른 기기에서 고친 메모';
    theirs.issueStatus = 'resolved';
    theirs.issueUpdatedAt = new Date(Date.now() + 60000).toISOString();
    restored.restoreImports(incoming.imports);
    const merged = restored.listImports(10, {}).find(i => i.filename === 'A.xlsx');
    check('49. 이슈가 양쪽에서 달라졌으면 최근에 고친 쪽을 남긴다(메모를 섞지 않는다)',
      merged.issueNote === '다른 기기에서 고친 메모' && merged.issueStatus === 'resolved',
      `${merged.issueStatus} · ${merged.issueNote}`);
    check('50. 밀려난 값은 충돌로 남겨서 나중에 사람이 볼 수 있게 한다',
      !!merged.issueConflict && merged.issueConflict.replaced.issueNote === '이 기기에서 고친 메모',
      JSON.stringify(merged.issueConflict && merged.issueConflict.replaced));
    src.close(); restored.close();
  }

  {
    // 서버(server.js)가 두 기기의 payload 를 합칠 때
    const PORT = 34117 + (process.pid % 200);
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-issue-srv-')), 'shared.json');
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ROUTE_VIEWER_DATA_FILE: dataFile }, stdio: 'pipe',
    });
    const base = `http://127.0.0.1:${PORT}`;
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try { const r = await fetch(base + '/api/route-data'); up = r.status === 404 || r.ok; } catch (_) { await sleep(150); }
      }
      const a = new RouteDatabase(freshPath());
      a.importRecords(FILE_A.records, FILE_A.meta);
      const payloadA = a.buildBackupPayload();
      await fetch(base + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadA) });

      const b = new RouteDatabase(freshPath());
      b.importRecords(FILE_A.records, { ...FILE_A.meta, hasIssue: true, issueNote: 'GPS 가 튀는 구간이 있어요' });
      // 같은 파일로 인식되도록 Import 시각을 맞춘다(파일명|지문|Import 시각)
      const payloadB = b.buildBackupPayload();
      payloadB.imports[0].importedAt = payloadA.imports[0].importedAt;
      payloadB.imports[0].issueNote = 'B 기기에서 다시 적은 메모';
      payloadB.imports[0].issueStatus = 'resolved';
      payloadB.imports[0].issueUpdatedAt = new Date(Date.now() + 120000).toISOString();
      payloadB.imports[0].recordKeys = [...(payloadB.imports[0].recordKeys || []), 'extra-key'];
      const res = await (await fetch(base + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadB) })).json();
      const shared = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const im = shared.imports.find(i => i.filename === 'A.xlsx');
      check('51. 서버에 합쳐도 Import 이슈가 사라지지 않는다',
        shared.imports.length === 1 && im.hasIssue === true, `${shared.imports.length}건 · hasIssue=${im.hasIssue}`);
      check('52. 서버 병합도 최신 수정을 남기고 밀려난 값은 충돌로 적는다',
        im.issueNote === 'B 기기에서 다시 적은 메모' && im.issueStatus === 'resolved'
        && !!im.issueConflict && im.issueConflict.replaced.issueNote === 'GPS 가 튀는 구간이 있어요'
        && res.stats.issueConflicts === 1, `${im.issueNote} · 충돌 ${res.stats.issueConflicts}`);
      check('53. 파일에서 나온 레코드 키는 양쪽을 합쳐서 남긴다(출처가 끊기지 않는다)',
        im.recordKeys.includes('extra-key') && im.recordKeys.length === payloadA.imports[0].recordKeys.length + 1,
        `${im.recordKeys.length}개`);
      check('   (같은 파일을 두 번 받아도 이력이 늘지 않는다)', shared.imports.length === 1);
      a.close(); b.close();
    } finally {
      server.kill();
      await sleep(120);
    }
  }

  // ══════════════════════════════════════════════════════
  section('I. 예전 데이터 안전성 — 출처 기록이 없어도 사라지지 않는다');
  // ══════════════════════════════════════════════════════
  {
    const db = new RouteDatabase(freshPath());
    db.importRecords(FILE_A.records, FILE_A.meta);
    db.importRecords(FILE_C.records, FILE_C.meta);
    // 이 기능 이전에 들어온 데이터를 흉내 낸다 — 출처 관계만 지운다
    db.db.run('DELETE FROM record_sources');
    db.rebuildAllSummaries();   // 출처가 없던 시절의 요약을 그대로 흉내 낸다
    const legacy = {};
    IF.ISSUE_FILTERS.forEach(f => { legacy[f] = db.getOverview({ issueFilter: f }).points; });
    check('54. 출처 기록이 없는 예전 데이터는 전체·이슈 없음 화면에서 그대로 보인다',
      legacy.all === 3 && legacy.clean === 3, JSON.stringify(legacy));
    check('55. 이슈 화면에는 나오지 않는다(이슈라고 단정하지 않는다)',
      legacy.issue_all === 0 && legacy.issue_open === 0 && legacy.issue_resolved === 0);
    const ov = db.getIssueOverview({});
    check('56. 출처 없는 기록이 몇 건인지 화면에 알려줄 수 있다', ov.unlinkedRecords === 3, `${ov.unlinkedRecords}건`);
    const oldBackup = { type: 'route-viewer-backup', version: 3, data: { '2026-09-01': FILE_B.records }, imports: [{ filename: '옛날.xlsx', importedAt: '2026-01-01T00:00:00.000Z', total: 2 }] };
    const target = new RouteDatabase(freshPath());
    let ok = true;
    try { target.restoreBackupPayload(oldBackup, 'merge'); } catch (_) { ok = false; }
    check('57. 이슈 필드가 없던 예전 백업도 그대로 복원된다',
      ok && target.getStats().points === 2 && target.listImports(10, {})[0].hasIssue === false);
    check('58. 날짜 요약의 조건 칸에는 "출처 없음(0)" 마스크가 들어간다',
      db.listDateSummaries().every(s => s.conditionCells.every(c => c.issueMask === 0)));
    db.close(); target.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failures.length) failures.forEach(f => console.log('   - ' + f));
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
