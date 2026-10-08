// ══════════════════════════════════════════════════════════
//  auto-import-test — 주행기록 자동 가져오기(동기화 폴더 감시)
//
//  임시 폴더 + 임시 테스트 DB 로만 돈다(실제 주행 DB·Drive 폴더는 건드리지 않는다).
//
//   A. 폴더 설정 — Drive 웹 주소 거부 · 최초 연결 대상 파일 수 · 결정 전에는 가져오지 않음
//   B. 새 파일 추가 → 반영 · 처리 이력 · 날짜 요약 · "검토 전"(정상 확인 완료 아님)
//   C. 같은 파일 재추가 / 이름 변경 / 하위 폴더 이동 → 재처리 안 함(내용 해시)
//   D. 내용 수정 → 다시 병합(기존 기록 유지)
//   E. 수동 불러오기로 이미 넣은 파일 → 이미 처리
//   F. 동기화 중 파일(크기·시각 변동 · 방금 쓰임 · 빈 파일) → 대기 후 다음 확인 때 반영
//   G. 잘못된 엑셀 → 실패 · 다른 파일은 계속 · 재시도 · 읽기 실패 자동 재시도
//   H. 임시 파일(~$) 제외 · 원본 파일 그대로 · 삭제된 파일은 DB 유지
//   I. 폴더 연결 끊김 → 기존 DB 유지 + 상태 표시 · 다시 연결되면 이어서
//   J. 동시 실행 방지 · 배치 끝에만 날짜 요약 갱신
//   K. 앱 재실행(DB 다시 열기) → 설정·이력 유지, 재처리 없음 · 미뤄 둔 요약 복구
//   L. "새 파일만" 최초 연결 → 과거 파일 건너뜀, 이후 새 파일만 · 나중에 과거 파일 가져오기
//   M. 검토 완료 → needs_review 해제
//
//  실행: node tests/auto-import-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const { RouteDatabase } = require('../electron/database.js');
const { AutoImporter, isRouteFileName, looksLikeUrl } = require('../electron/auto-import.js');
const RouteParser = require('../src/js/parser.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n\x1b[36m${t}\x1b[0m`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-autoimport-'));
const DB_PATH = path.join(TMP, 'db', 'route-viewer.db');
const DRIVE = path.join(TMP, 'drive', '주행기록');
fs.mkdirSync(DRIVE, { recursive: true });

// nav-app "오늘 기록 다운로드" 모양의 xlsx — 1행 차량 정보, 3행 헤더
function routeXlsx(vehicle, date, startMin, count, latBase) {
  const rows = [['차량', vehicle, '이름', '테스트', '입장시각', '09:00:00'], [],
    ['번호', '날짜', '시각', 'GPS위치', '도로종류', '날씨', '시간대', '장소', '교통밀도', '차량속도(km/h)']];
  for (let i = 0; i < count; i++) {
    const m = startMin + i;
    const t = `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    rows.push([i + 1, date, t, `${(latBase + i * 0.0003).toFixed(6)}, ${(127.03 + i * 0.0003).toFixed(6)}`, '일반', '맑음', '주간', '강남구 역삼동', '보통', 30]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// 과거 시각으로 mtime 을 맞춘다 — "방금 쓰인 파일" 대기를 피하려고
function writeOld(file, buf, agoMs = 60000) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  const t = new Date(Date.now() - agoMs);
  fs.utimesSync(file, t, t);
}

let db = new RouteDatabase(DB_PATH);
const batches = [];
function makeImporter(database, extra) {
  return new AutoImporter({
    db: database, parseBuffer: RouteParser.parseBuffer,
    settleMs: 0, minAgeMs: 5000, caseInsensitive: true,
    onBatch: r => batches.push(r), ...(extra || {}),
  });
}
let ai = makeImporter(db);

function fileRow(name) { return ai.status().files.find(f => f.name === name); }
function countRecords() { return db.getStats().points; }
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

async function main() {
  // ── A ───────────────────────────────────────────────
  section('A. 폴더 설정 · 최초 연결');
  check('Drive 웹 주소는 URL 로 판별', looksLikeUrl('https://drive.google.com/drive/u/0/folders/0AHHJCwdKbiJCUk9PVA'));
  check('로컬 경로는 URL 이 아님', !looksLikeUrl('G:\\공유 드라이브\\주행기록'));
  let urlErr = null;
  try { await ai.setFolder('https://drive.google.com/drive/u/0/folders/0AHHJCwdKbiJCUk9PVA'); } catch (e) { urlErr = e; }
  check('Drive URL 을 폴더로 설정하면 거부', urlErr && /웹 주소/.test(urlErr.message), urlErr && urlErr.message);
  check('거부 후 설정에 폴더가 저장되지 않음', !ai.config().folder);
  let relErr = null;
  try { await ai.setFolder('relative\\folder'); } catch (e) { relErr = e; }
  check('상대 경로 거부', !!relErr);

  check('임시 파일 ~$ 제외', !isRouteFileName('~$day1.xlsx'));
  check('xlsx/xls/csv 허용(대소문자 무시)', isRouteFileName('a.XLSX') && isRouteFileName('b.xls') && isRouteFileName('c.csv'));
  check('다른 확장자 제외', !isRouteFileName('memo.txt') && !isRouteFileName('photo.jpg'));

  const day1 = routeXlsx('토레스 1호차', '2026-10-01', 0, 20, 37.50);
  const day2 = routeXlsx('토레스 2호차', '2026-10-02', 0, 15, 37.51);
  writeOld(path.join(DRIVE, 'day1.xlsx'), day1);
  writeOld(path.join(DRIVE, '10월', 'day2.xlsx'), day2);               // 하위 폴더
  writeOld(path.join(DRIVE, '~$day1.xlsx'), Buffer.from('lock'));      // Excel 임시 파일
  writeOld(path.join(DRIVE, 'readme.txt'), Buffer.from('x'));

  const preview = await ai.setFolder(DRIVE);
  check('최초 연결 대상 파일 수 = 2 (하위 폴더 포함 · 임시/기타 제외)', preview.fileCount === 2, JSON.stringify(preview));
  check('결정 전 상태 needsDecision', ai.status().needsDecision === true);
  const pre = await ai.runOnce('timer');
  check('결정 전에는 가져오지 않음', pre.needsDecision === true && countRecords() === 0);

  // ── B ───────────────────────────────────────────────
  section('B. 전체 가져오기 · 새 파일 반영');
  const r1 = await ai.confirmInitial('all');
  check('새 파일 2개 반영', r1.newImported === 2, JSON.stringify({ n: r1.newImported, f: r1.failed, p: r1.pending }));
  check('레코드 35개 저장', countRecords() === 35, String(countRecords()));
  check('반영 날짜 2개', r1.dates.join(',') === '2026-10-01,2026-10-02', r1.dates.join(','));
  check('반영 차량', r1.vehicles.join(',') === '토레스 1호차,토레스 2호차', r1.vehicles.join(','));
  check('onBatch 한 번 호출(화면 갱신 1회)', batches.length === 1);
  const sums = db.listDateSummaries();
  check('날짜 요약 생성(달력 반영)', sums.length === 2 && sums.every(s => s.count > 0));
  const f1 = fileRow('day1.xlsx');
  check('처리 이력: 이름·날짜·차량·추가·중복', f1 && f1.status === 'imported' && f1.dates[0] === '2026-10-01'
    && f1.vehicles[0] === '토레스 1호차' && f1.inserted === 20 && f1.duplicates === 0 && !!f1.processedAt, JSON.stringify(f1));
  const im1 = db.getImport(f1.importId);
  check('Import 이력: 자동 가져오기 · 검토 전', im1.importSource === 'auto' && im1.needsReview === true && im1.importedBy === '자동 가져오기');
  check('사람이 안 본 파일은 이슈 확인 완료로 표시하지 않음', im1.hasIssue === false && im1.issueStatus === null);
  check('파일 지문 = 원본 SHA-1(수동 불러오기와 같은 값)', im1.fileHash === sha1(day1));
  check('기록 출처 관계 저장(이슈 필터 대상)', im1.relatedRecords === 20);
  check('하위 폴더 상대 경로 기록', fileRow('day2.xlsx').relPath === path.join('10월', 'day2.xlsx'));
  check('설정에 마지막 확인 시각 저장', !!ai.config().lastCheckAt);
  const lt = ai.status().latest;
  check('Drive 에서 가져온 마지막 주행 날짜', lt.latestDate === '2026-10-02' && lt.latestDateFile === 'day2.xlsx', JSON.stringify(lt));
  check('마지막 새 파일 반영 시각', !!lt.lastNewFileAt && /day[12]\.xlsx/.test(lt.lastNewFileName));
  check('차량별 마지막 주행 날짜', JSON.stringify(lt.byVehicle) === JSON.stringify([
    { vehicle: '토레스 1호차', latestDate: '2026-10-01' }, { vehicle: '토레스 2호차', latestDate: '2026-10-02' }]), JSON.stringify(lt.byVehicle));

  // ── C ───────────────────────────────────────────────
  section('C. 재추가 · 이름 변경 · 이동');
  const r2 = await ai.runOnce('timer');
  check('변화 없으면 새로 반영 0 · 이미 처리 2', r2.newImported === 0 && r2.alreadyProcessed === 2, JSON.stringify({ n: r2.newImported, a: r2.alreadyProcessed }));
  check('변화 없으면 onBatch 없음', batches.length === 1);
  writeOld(path.join(DRIVE, 'day1 (1).xlsx'), day1);                   // 같은 파일 재업로드(다른 이름)
  fs.renameSync(path.join(DRIVE, '10월', 'day2.xlsx'), path.join(DRIVE, '10월', '2호차_1002.xlsx'));  // 이름 변경
  const importsBefore = db.getStats().imports;
  const r3 = await ai.runOnce('timer');
  check('같은 내용 재추가·이름 변경은 재처리 안 함', r3.newImported === 0 && db.getStats().imports === importsBefore,
    JSON.stringify({ n: r3.newImported, imports: db.getStats().imports }));
  const dup = fileRow('day1 (1).xlsx');
  check('재추가 파일은 "이미 처리" + 원본 파일 이름', dup && dup.status === 'already' && dup.duplicateOf === 'day1.xlsx', JSON.stringify(dup));
  check('이름 바뀐 파일도 "이미 처리"', fileRow('2호차_1002.xlsx').status === 'already');
  check('예전 이름은 폴더에 없음 표시(기록 유지)', fileRow('day2.xlsx').missing === true && countRecords() === 35);
  check('폴더에 있는 3개 모두 이미 처리 / 반영 0', r3.alreadyProcessed === 3, String(r3.alreadyProcessed));

  // ── D ───────────────────────────────────────────────
  section('D. 내용 수정 → 다시 병합');
  const day1b = routeXlsx('토레스 1호차', '2026-10-01', 0, 30, 37.50); // 앞 20개는 같고 10개 추가
  writeOld(path.join(DRIVE, 'day1.xlsx'), day1b, 30000);
  const r4 = await ai.runOnce('timer');
  const f1b = fileRow('day1.xlsx');
  check('수정된 파일 감지 · 다시 반영', r4.newImported === 1 && f1b.status === 'imported', JSON.stringify({ n: r4.newImported, s: f1b.status }));
  check('새 레코드만 추가(+10) · 기존 20개는 중복', f1b.inserted === 10 && f1b.duplicates === 20, JSON.stringify(f1b));
  check('기존 기록 삭제 없음(35 → 45)', countRecords() === 45, String(countRecords()));
  check('변경된 날짜만 갱신', r4.dates.join(',') === '2026-10-01');
  check('날짜 요약 개수 갱신', db.listDateSummaries().find(s => s.date === '2026-10-01').count === 30);
  // 내용이 줄어든 수정도 기존 기록은 지우지 않는다
  writeOld(path.join(DRIVE, 'day1.xlsx'), routeXlsx('토레스 1호차', '2026-10-01', 0, 5, 37.50), 20000);
  await ai.runOnce('timer');
  check('줄어든 파일로 수정돼도 기존 기록 유지', countRecords() === 45 && db.listDateSummaries().find(s => s.date === '2026-10-01').count === 30);

  // ── E ───────────────────────────────────────────────
  section('E. 수동 불러오기 이력 활용');
  const manual = routeXlsx('토레스 3호차', '2026-10-03', 0, 12, 37.52);
  db.importRecords(RouteParser.parseBuffer(manual), { filename: '수동.xlsx', fileHash: sha1(manual), importedBy: '홍길동' });
  const pointsAfterManual = countRecords();
  writeOld(path.join(DRIVE, 'from-kakao.xlsx'), manual);
  const r5 = await ai.runOnce('timer');
  const fm = fileRow('from-kakao.xlsx');
  check('수동으로 넣은 파일은 이미 처리', r5.newImported === 0 && fm.status === 'already' && fm.duplicateOf === '수동.xlsx', JSON.stringify(fm));
  check('수동 Import 는 자동 표시가 붙지 않음', db.getImport(fm.importId).needsReview === false);
  check('기록 수 변화 없음', countRecords() === pointsAfterManual);

  // ── F ───────────────────────────────────────────────
  section('F. 동기화 중 파일');
  const day4 = routeXlsx('토레스 1호차', '2026-10-04', 0, 8, 37.53);
  fs.writeFileSync(path.join(DRIVE, 'syncing.xlsx'), day4);           // mtime = 지금 → 방금 쓰인 파일
  const r6 = await ai.runOnce('timer');
  check('방금 쓰인 파일은 대기', r6.newImported === 0 && fileRow('syncing.xlsx').status === 'pending', fileRow('syncing.xlsx').reason);
  // 크기·시각이 기다리는 동안 바뀌는 경우 — settle 대기 중에 파일을 덧쓴다
  const growing = path.join(DRIVE, 'growing.xlsx');
  writeOld(growing, day4.subarray(0, 100));
  const aiGrow = makeImporter(db, { settleMs: 5, sleep: async () => { fs.appendFileSync(growing, Buffer.from('more')); } });
  await aiGrow.runOnce('timer');
  check('크기·수정 시각이 바뀌는 중이면 대기', fileRow('growing.xlsx').status === 'pending', fileRow('growing.xlsx').reason);
  // 빈 자리표시자 파일 — 처음엔 대기, 계속 비어 있으면 실패
  writeOld(path.join(DRIVE, 'placeholder.xlsx'), Buffer.alloc(0));
  await ai.runOnce('timer');
  check('빈 파일은 우선 대기', fileRow('placeholder.xlsx').status === 'pending');
  // 동기화 완료
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(DRIVE, 'syncing.xlsx'), old, old);
  writeOld(growing, routeXlsx('토레스 2호차', '2026-10-05', 0, 6, 37.54));
  const r7 = await ai.runOnce('timer');
  check('동기화 끝난 파일은 다음 확인 때 반영', fileRow('syncing.xlsx').status === 'imported' && fileRow('growing.xlsx').status === 'imported', JSON.stringify({ n: r7.newImported }));
  check('계속 비어 있는 파일은 실패(빈 파일)', fileRow('placeholder.xlsx').status === 'failed' && /빈 파일/.test(fileRow('placeholder.xlsx').reason));

  // ── G ───────────────────────────────────────────────
  section('G. 잘못된 엑셀 · 실패 격리 · 재시도');
  writeOld(path.join(DRIVE, 'broken.xlsx'), Buffer.from('PK\u0003\u0004 this is not really a zip'));
  writeOld(path.join(DRIVE, 'nogps.csv'), Buffer.from('a,b,c\n1,2,3\n'));
  const day6 = routeXlsx('토레스 4호차', '2026-10-06', 0, 7, 37.55);
  writeOld(path.join(DRIVE, 'zz-good.xlsx'), day6);
  const r8 = await ai.runOnce('timer');
  const fb = fileRow('broken.xlsx'), fn = fileRow('nogps.csv');
  check('잘못된 엑셀은 실패 + 사유', fb.status === 'failed' && fb.reason.length > 0, fb.reason);
  check('좌표 없는 파일은 실패 + 사유', fn.status === 'failed' && /GPS/.test(fn.reason), fn.reason);
  check('실패가 다른 파일 처리를 막지 않음', fileRow('zz-good.xlsx').status === 'imported' && r8.newImported === 1);
  check('실패 건수 표시', r8.failed === 3, String(r8.failed));   // broken · nogps · placeholder
  const attemptsBefore = fileRow('broken.xlsx').attempts;
  await ai.runOnce('timer');
  check('내용 오류는 매 확인마다 다시 읽지 않음', fileRow('broken.xlsx').attempts === attemptsBefore);
  // 고쳐진 파일을 같은 이름으로 다시 올리면 자동으로 다시 본다
  const fixed = routeXlsx('토레스 4호차', '2026-10-07', 0, 4, 37.56);
  writeOld(path.join(DRIVE, 'broken.xlsx'), fixed, 10000);
  await ai.runOnce('timer');
  check('파일이 바뀌면 실패 파일도 다시 처리', fileRow('broken.xlsx').status === 'imported');
  // 실패 재시도 버튼 — 파서가 일시적으로 실패했던 경우
  let parseFail = true;
  const aiFlaky = makeImporter(db, { parseBuffer: buf => { if (parseFail) throw new Error('일시 오류'); return RouteParser.parseBuffer(buf); } });
  writeOld(path.join(DRIVE, 'flaky.xlsx'), routeXlsx('토레스 1호차', '2026-10-08', 0, 3, 37.57));
  await aiFlaky.runOnce('timer');
  check('파싱 실패 기록', fileRow('flaky.xlsx').status === 'failed');
  parseFail = false;
  await aiFlaky.runOnce('timer');
  check('재시도 전에는 그대로 실패', fileRow('flaky.xlsx').status === 'failed');
  await aiFlaky.retryFailed([fileRow('flaky.xlsx').pathKey]);
  check('재시도하면 반영', fileRow('flaky.xlsx').status === 'imported');
  // 읽기 실패(EBUSY)는 다음 확인 때 자동 재시도
  let busy = true;
  const busyFs = { ...fs.promises, readFile: async p => { if (busy && p.endsWith('locked.xlsx')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return fs.promises.readFile(p); } };
  const aiBusy = makeImporter(db, { fs: busyFs });
  writeOld(path.join(DRIVE, 'locked.xlsx'), routeXlsx('토레스 2호차', '2026-10-09', 0, 3, 37.58));
  await aiBusy.runOnce('timer');
  const fl = fileRow('locked.xlsx');
  check('읽기 실패는 실패 + 자동 재시도 대상', fl.status === 'failed' && fl.retryable && /다른 프로그램/.test(fl.reason), fl.reason);
  busy = false;
  await aiBusy.runOnce('timer');
  check('다음 확인 때 자동으로 다시 읽어 반영', fileRow('locked.xlsx').status === 'imported');

  // ── H ───────────────────────────────────────────────
  section('H. 원본 파일 보존 · 삭제된 파일');
  const beforeBytes = fs.readFileSync(path.join(DRIVE, '10월', '2호차_1002.xlsx'));
  check('원본 파일 내용·위치 그대로', sha1(beforeBytes) === sha1(day2));
  check('임시 파일(~$)은 이력에 없음', !ai.status().files.some(f => f.name.startsWith('~$')));
  const pts = countRecords();
  fs.unlinkSync(path.join(DRIVE, 'zz-good.xlsx'));
  await ai.runOnce('timer');
  check('공유 폴더에서 삭제돼도 DB 기록 유지', countRecords() === pts && db.listDateSummaries().some(s => s.date === '2026-10-06'));
  check('삭제된 파일은 "폴더에 없음" 표시', fileRow('zz-good.xlsx').missing === true);
  check('폴더에서 사라진 파일의 날짜도 "몇 일까지"에 포함', ai.status().latest.latestDate === '2026-10-09', ai.status().latest.latestDate);
  const byV = Object.fromEntries(ai.status().latest.byVehicle.map(v => [v.vehicle, v.latestDate]));
  check('차량별: 이미 처리(수동으로 넣은 파일)도 포함 · 차량마다 따로', byV['토레스 3호차'] === '2026-10-03' && byV['토레스 2호차'] === '2026-10-09' && byV['토레스 4호차'] === '2026-10-07', JSON.stringify(byV));

  // ── I ───────────────────────────────────────────────
  section('I. 폴더 연결 끊김');
  const OFF = DRIVE + '-offline';
  fs.renameSync(DRIVE, OFF);
  const r9 = await ai.runOnce('timer');
  check('접근 불가 상태 표시', r9.ok === false && /접근할 수 없어요/.test(r9.folderError), r9.folderError);
  check('기존 DB 유지', countRecords() === pts && db.listDateSummaries().length >= 6);
  check('마지막 결과에 오류 저장', ai.config().lastResult && !!ai.config().lastResult.folderError);
  fs.renameSync(OFF, DRIVE);
  writeOld(path.join(DRIVE, 'after-reconnect.xlsx'), routeXlsx('토레스 3호차', '2026-10-10', 0, 5, 37.59));
  const r10 = await ai.runOnce('timer');
  check('다시 연결되면 이어서 처리', r10.ok && r10.newImported === 1);

  // ── J ───────────────────────────────────────────────
  section('J. 동시 실행 방지 · 배치 요약 갱신');
  let summaryCalls = 0;
  const realRebuild = db._rebuildDateSummary.bind(db);
  db._rebuildDateSummary = (d, c) => { summaryCalls++; return realRebuild(d, c); };
  writeOld(path.join(DRIVE, 'batch', 'b1.xlsx'), routeXlsx('토레스 1호차', '2026-10-11', 0, 4, 37.60));
  writeOld(path.join(DRIVE, 'batch', 'b2.xlsx'), routeXlsx('토레스 2호차', '2026-10-11', 30, 4, 37.61));
  writeOld(path.join(DRIVE, 'batch', 'b3.xlsx'), routeXlsx('토레스 3호차', '2026-10-11', 60, 4, 37.62));
  const pA = ai.runOnce('timer'), pB = ai.runOnce('manual');
  check('동시에 부르면 같은 실행을 공유', pA === pB);
  const r11 = await pA;
  check('3개 반영', r11.newImported === 3, String(r11.newImported));
  check('같은 날짜 3파일 → 요약은 배치 끝에 1번만', summaryCalls === 1, String(summaryCalls));
  db._rebuildDateSummary = realRebuild;
  check('수동 실행과 겹쳐도 중복 Import 없음', db.listImports(1000).filter(i => /^b[123]\.xlsx$/.test(i.filename)).length === 3);

  // ── K ───────────────────────────────────────────────
  section('K. 앱 재실행');
  const importsK = db.getStats().imports, pointsK = countRecords();
  db.close();
  db = new RouteDatabase(DB_PATH);
  ai = makeImporter(db);
  const cfg = ai.config();
  check('폴더 경로·활성화·최초 결정 유지', cfg.folder === path.resolve(DRIVE) && cfg.enabled === true && cfg.initialMode === 'all');
  check('처리 이력 유지', fileRow('day1.xlsx').status === 'imported');
  const r12 = await ai.runOnce('timer');
  check('재실행 후 재처리 없음', r12.newImported === 0 && db.getStats().imports === importsK && countRecords() === pointsK);
  // 배치 도중 꺼져서 요약이 미뤄진 경우 — 다음 시작 때 채운다
  db.db.run("DELETE FROM date_summaries WHERE date = '2026-10-11'");
  db.setMeta('auto_import_pending_summary_dates', JSON.stringify(['2026-10-11']));
  ai.initialDelayMs = 60000; ai.start(); ai.stop();
  check('미뤄 둔 날짜 요약 복구', db.listDateSummaries().some(s => s.date === '2026-10-11'));
  ai.setIntervalSec(300);
  check('확인 간격 저장(5분)', makeImporter(db).config().intervalSec === 300);
  ai.setIntervalSec(1); check('너무 짧은 간격은 15초로', ai.config().intervalSec === 15);
  ai.setIntervalSec(99999); check('너무 긴 간격은 1시간으로', ai.config().intervalSec === 3600);
  let badInterval = null; try { ai.setIntervalSec('abc'); } catch (e) { badInterval = e; }
  check('숫자가 아닌 간격 거부', !!badInterval);
  ai.setIntervalSec(60);
  ai.setEnabled(false);
  check('OFF 저장', makeImporter(db).config().enabled === false);
  ai.setEnabled(true);

  // ── L ───────────────────────────────────────────────
  section('L. "새 파일만"으로 최초 연결');
  const DRIVE2 = path.join(TMP, 'drive2');
  writeOld(path.join(DRIVE2, 'old1.xlsx'), routeXlsx('토레스 1호차', '2026-09-01', 0, 3, 37.70));
  writeOld(path.join(DRIVE2, 'old2.xlsx'), routeXlsx('토레스 1호차', '2026-09-02', 0, 3, 37.71));
  const p2 = await ai.setFolder(DRIVE2);
  check('폴더를 바꾸면 최초 결정을 다시 받음', p2.fileCount === 2 && ai.status().needsDecision);
  const r13 = await ai.confirmInitial('new');
  check('과거 파일은 건너뜀', r13.newImported === 0 && r13.baseline === 2 && !db.listDateSummaries().some(s => s.date === '2026-09-01'));
  writeOld(path.join(DRIVE2, 'new1.xlsx'), routeXlsx('토레스 1호차', '2026-09-03', 0, 3, 37.72));
  const r14 = await ai.runOnce('timer');
  check('이후 새 파일은 자동 반영', r14.newImported === 1 && fileRow('new1.xlsx').status === 'imported');
  writeOld(path.join(DRIVE2, 'old1.xlsx'), routeXlsx('토레스 1호차', '2026-09-01', 0, 4, 37.70), 5000 + 10000);
  await ai.runOnce('timer');
  check('건너뛴 과거 파일도 내용이 바뀌면 반영', fileRow('old1.xlsx').status === 'imported');
  await ai.importBaseline();
  check('나중에 과거 파일 가져오기', fileRow('old2.xlsx').status === 'imported');

  // ── M ───────────────────────────────────────────────
  section('M. 검토 완료');
  const imM = db.getImport(fileRow('old2.xlsx').importId);
  check('자동 Import 는 검토 전', imM.needsReview === true);
  db.updateImportIssue(imM.id, { reviewed: true });
  const imM2 = db.getImport(imM.id);
  check('검토 완료 → 검토 전 해제 · 이슈 없음 유지', imM2.needsReview === false && imM2.hasIssue === false);
  db.updateImportIssue(fileRow('new1.xlsx').importId, { hasIssue: true, issueNote: '좌표 튐' });
  const imM3 = db.getImport(fileRow('new1.xlsx').importId);
  check('이슈 등록도 검토로 처리', imM3.needsReview === false && imM3.hasIssue && imM3.issueStatus === 'open');
  const pendingBefore = db.countPendingReview();
  check('검토 전 개수', pendingBefore > 0 && ai.status().reviewPending === pendingBefore, String(pendingBefore));
  check('이슈 관리 요약에도 검토 전 개수', db.getIssueOverview({}).needsReviewCount === pendingBefore);
  const backup = db.buildBackupPayload();
  check('백업에 자동/검토 표시 포함', backup.imports.some(i => i.importSource === 'auto' && i.needsReview === true));
  const issueBefore = db.getImport(fileRow('new1.xlsx').importId);
  const res = db.reviewAllPendingImports();
  check('모두 검토 완료 → 검토 전 0', res.updated === pendingBefore && db.countPendingReview() === 0, JSON.stringify(res));
  const issueAfter = db.getImport(fileRow('new1.xlsx').importId);
  check('이슈 등록한 파일은 그대로', issueAfter.hasIssue && issueAfter.issueNote === issueBefore.issueNote && issueAfter.issueStatus === 'open');

  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 임시 폴더 */ }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('실패:', failures.join(' | ')); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
