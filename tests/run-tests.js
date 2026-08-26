// ══════════════════════════════════════════════════════════
//  run-tests.js — 요구사항 14번 테스트 시나리오를 실제 파일로 검증한다.
//
//    Test 1  날짜 누적 (import 할수록 날짜가 쌓이는지)
//    Test 2  같은 파일 재import (포인트가 2배가 되지 않는지)
//    Test 3  같은 날짜 다른 주행 (오전/오후가 모두 남는지)
//    Test 4  앱 재실행 (DB를 닫았다 다시 열어도 그대로인지)
//    Test 6  기존 기능 회귀 (달력/누적지도/통계/필터 쿼리)
//
//  실행:  npm test
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { RouteDatabase } = require('../electron/database.js');
const RouteParser = require('../src/js/parser.js');

const ROOT = path.join(__dirname, '..');
const XLSX_DIR = path.join(ROOT, '주행기록');

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  [32mPASS[0m  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  [31mFAIL[0m  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n[36m${title}[0m`);
}

function importFile(db, filePath) {
  const buf = fs.readFileSync(filePath);
  const records = RouteParser.parseBuffer(buf);
  return db.importRecords(records, {
    filename: path.basename(filePath),
    fileHash: RouteDatabase.hashFile(buf),
  });
}

function freshDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-test-'));
  return path.join(dir, 'route-viewer.db');
}

function main() {
  const files = fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort();
  console.log(`테스트용 주행기록 파일 ${files.length}개\n`);

  const byDate = {};
  for (const f of files) {
    const recs = RouteParser.parseBuffer(fs.readFileSync(path.join(XLSX_DIR, f)));
    const dates = [...new Set(recs.map(r => r.date))];
    byDate[f] = { count: recs.length, dates };
    console.log(`  ${f}  →  ${recs.length}건  ${dates.join(',')}`);
  }

  // ── 파서 기본 검증 ──────────────────────────────────
  section('Test 0 — 파서');
  const sample = RouteParser.parseBuffer(fs.readFileSync(path.join(XLSX_DIR, '주행기록_2026-08-12.xlsx')));
  check('GPS 좌표를 읽는다', sample.length === 16, `${sample.length}건`);
  check('날짜가 YYYY-MM-DD', sample[0].date === '2026-08-12', sample[0].date);
  check('시각이 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(sample[0].time), sample[0].time);
  check('차량은 상단 정보행에서 채운다', sample[0].vehicle === '토레스 1호차', sample[0].vehicle);
  check('구역은 장소에서 추론한다', sample[0].zone === '시흥', sample[0].zone);
  check('교통밀도 열을 읽는다', sample[0].traffic !== undefined, JSON.stringify(sample[0].traffic));
  check('날씨/도로/시간대', sample[0].weather === '흐림' && sample[0].road === '도심' && sample[0].timeOfDay === '주간');

  // ══════════════════════════════════════════════════
  //  Test 1 — 날짜 누적
  // ══════════════════════════════════════════════════
  section('Test 1 — 날짜 누적 (import 는 교체가 아니라 추가)');
  const dbPath = freshDbPath();
  let db = new RouteDatabase(dbPath);

  const f12 = path.join(XLSX_DIR, '주행기록_2026-08-12.xlsx');
  const f24 = path.join(XLSX_DIR, '주행기록_2026-08-24 4.xlsx');
  const f25 = path.join(XLSX_DIR, 'TalkFile_주행기록_2026-08-25 2.xlsx.xlsx');

  const r1 = importFile(db, f12);
  let dates = db.listDateSummaries().map(d => d.date);
  check('08-12 import 후 08-12 존재', dates.join(',') === '2026-08-12', dates.join(','));
  check('전부 새로 추가됨', r1.inserted === r1.total && r1.duplicates === 0, `${r1.inserted}/${r1.total}`);

  importFile(db, f24);
  dates = db.listDateSummaries().map(d => d.date);
  check('08-24 추가 후 08-12 + 08-24 존재', dates.join(',') === '2026-08-12,2026-08-24', dates.join(','));

  importFile(db, f25);
  dates = db.listDateSummaries().map(d => d.date);
  check('08-25 추가 후 세 날짜 모두 존재',
    dates.join(',') === '2026-08-12,2026-08-24,2026-08-25', dates.join(','));

  const afterThree = db.getStats();
  check('이전 날짜 기록이 사라지지 않음', afterThree.days === 3, `${afterThree.days}일 / ${afterThree.points}포인트`);

  // ══════════════════════════════════════════════════
  //  Test 2 — 같은 파일 재import
  // ══════════════════════════════════════════════════
  section('Test 2 — 같은 파일 다시 넣어도 2배가 되지 않는다');
  const before = db.getStats().points;
  const dup = importFile(db, f12);
  const after = db.getStats().points;
  check('포인트 수가 늘지 않음', before === after, `${before} → ${after}`);
  check('새로 추가 0건', dup.inserted === 0, `inserted=${dup.inserted}`);
  check('중복 제외로 집계됨', dup.duplicates === dup.total, `duplicates=${dup.duplicates}/${dup.total}`);
  check('import 이력에는 남음', db.listImports().length === 4, `${db.listImports().length}건`);

  // ══════════════════════════════════════════════════
  //  Test 3 — 같은 날짜 다른 주행
  // ══════════════════════════════════════════════════
  section('Test 3 — 같은 날짜 오전/오후 주행이 모두 합쳐진다');
  const db3 = new RouteDatabase(freshDbPath());
  const morning = path.join(XLSX_DIR, 'TalkFile_주행기록_2026-08-25 2.xlsx.xlsx');   // 09:01~
  const afternoon = path.join(XLSX_DIR, 'TalkFile_주행기록_2026-08-25 5.xlsx.xlsx'); // 14:08~

  const m = importFile(db3, morning);
  const mPts = db3.getStats().points;
  const a = importFile(db3, afternoon);
  const aPts = db3.getStats().points;

  check('오후 파일이 무시되지 않음', a.inserted > 0, `${a.inserted}건 추가`);
  check('두 주행이 합산됨', aPts > mPts, `${mPts} → ${aPts}`);
  check('날짜는 하나로 묶임', db3.listDateSummaries().length === 1, `${db3.listDateSummaries().length}일`);

  const day = db3.getRecordsByDate('2026-08-25');
  check('timestamp 기준 정렬됨',
    day.every((p, i) => i === 0 || day[i - 1].time <= p.time),
    `${day[0].time} … ${day[day.length - 1].time}`);
  const times = day.map(p => p.time);
  check('오전 기록 포함', times.some(t => t.startsWith('09:')), times[0]);
  check('오후 기록 포함', times.some(t => t.startsWith('14:')), times[times.length - 1]);

  // 겹치는 두 파일(6호는 7호의 부분집합)
  section('Test 3b — 겹치는 파일 두 개 (부분집합)');
  const db3b = new RouteDatabase(freshDbPath());
  const small = importFile(db3b, path.join(XLSX_DIR, '주행기록_2026-08-24 6.xlsx'));
  const big = importFile(db3b, path.join(XLSX_DIR, '주행기록_2026-08-24 7.xlsx'));
  check('작은 파일 먼저 들어감', small.inserted > 0, `${small.inserted}건`);
  check('큰 파일의 겹치는 부분은 중복 처리', big.duplicates > 0, `중복 ${big.duplicates}건`);
  check('큰 파일의 새 구간은 추가됨', big.inserted > 0, `추가 ${big.inserted}건`);
  check('합계가 큰 파일 고유행 수와 맞음',
    db3b.getStats().points === small.inserted + big.inserted,
    `${db3b.getStats().points}`);
  db3b.close();

  // ══════════════════════════════════════════════════
  //  Test 4 — 앱 재실행 (DB 닫고 다시 열기)
  // ══════════════════════════════════════════════════
  section('Test 4 — 앱을 껐다 켜도 데이터가 남아있다');
  const statsBefore = db.getStats();
  db.close();
  db = new RouteDatabase(dbPath);
  const statsAfter = db.getStats();
  check('날짜 수 유지', statsBefore.days === statsAfter.days, `${statsAfter.days}일`);
  check('포인트 수 유지', statsBefore.points === statsAfter.points, `${statsAfter.points}개`);
  check('DB 파일이 디스크에 존재', fs.existsSync(dbPath),
    `${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB`);

  // ══════════════════════════════════════════════════
  //  Test 6 — 기존 기능 회귀
  // ══════════════════════════════════════════════════
  section('Test 6 — 기존 기능 회귀 (달력/누적지도/통계/필터)');

  const summaries = db.listDateSummaries();
  check('달력: 날짜별 요약이 나온다', summaries.length === 3, `${summaries.length}일`);
  const s12 = summaries.find(s => s.date === '2026-08-12');
  check('달력: 구역 칩', s12.zones.length > 0 && s12.zones[0][0] === '시흥', JSON.stringify(s12.zones));
  check('달력: 차량 칩', s12.vehicles.length > 0, JSON.stringify(s12.vehicles));
  check('달력: 운행 시간 범위', !!s12.startTime && !!s12.endTime, `${s12.startTime} → ${s12.endTime}`);
  check('달력: 품질 검사 결과 포함', s12.quality && typeof s12.quality.total === 'number',
    JSON.stringify(s12.quality));

  const ov = db.getOverview();
  check('누적지도: 전체 요약', ov.days === 3 && ov.points > 0, `${ov.days}일 ${ov.points}개`);
  const ovZone = db.getOverview({ zone: '강남' });
  check('누적지도: 구역 필터', ovZone.points > 0 && ovZone.points < ov.points,
    `강남 ${ovZone.points}개`);

  const cells = db.getDensityCells({}, 0.0007);
  check('누적지도: 밀도 격자 생성', cells.length > 0, `${cells.length}칸`);
  check('누적지도: 격자에 좌표/개수', cells[0].lat > 30 && cells[0].n > 0,
    `${cells[0].lat.toFixed(5)}, n=${cells[0].n}`);
  check('누적지도: 격자별 지나간 날짜 수', cells.some(c => c.dateCount >= 1));
  check('누적지도: 격자별 구역/차량 집계', cells.some(c => Object.keys(c.zones).length > 0));

  const bounds = db.getBounds({ zone: '강남' });
  check('누적지도: 화면 맞춤용 bounds', bounds && bounds.minLat < bounds.maxLat,
    bounds ? `${bounds.minLat.toFixed(4)}~${bounds.maxLat.toFixed(4)}` : 'null');

  const visited = db.getVisitedCellKeys({
    latDeg: 50 / 111320, lngDeg: 50 / (111320 * Math.cos(37.5 * Math.PI / 180)),
    minLat: 37.3, maxLat: 37.6, minLng: 126.6, maxLng: 127.2,
  });
  check('커버리지 갭: 지나간 칸 목록', visited.length > 0, `${visited.length}칸`);
  check('커버리지 갭: 칸 키 형식', /^-?\d+_-?\d+$/.test(visited[0]), visited[0]);

  check('통계: 구역 분포', db.getDistribution('zone').length > 0,
    JSON.stringify(db.getDistribution('zone')));
  check('통계: 차량 분포', db.getDistribution('vehicle').length > 0,
    JSON.stringify(db.getDistribution('vehicle')));
  check('통계: 도로종류 분포', db.getDistribution('road').length > 0);
  check('통계: 날씨 분포', db.getDistribution('weather').length > 0);
  check('통계: 장소 분포', db.getDistribution('place').length > 0);
  check('통계: 시간대 분포', db.getDistribution('timeOfDay').length > 0);
  check('통계: 시각→4시간 버킷 폴백', db.getTimeBucketDistribution().length > 0,
    JSON.stringify(db.getTimeBucketDistribution()));
  const vehFiltered = db.getDistribution('zone', { vehicleLike: '토레스 1호' });
  check('통계: 차량 필터', vehFiltered.length > 0, JSON.stringify(vehFiltered));

  const replay = db.getRecordsByDate('2026-08-12');
  check('리플레이: 하루치 원본 조회', replay.length === 16, `${replay.length}개`);
  check('리플레이: 필드 보존',
    replay[0].lat && replay[0].lng && replay[0].place && replay[0].speed !== undefined,
    JSON.stringify(replay[0]));

  db.saveZonePolygons({ 강남: [[37.49, 127.02], [37.51, 127.02], [37.51, 127.05]] });
  check('구역 경계 저장/조회', Object.keys(db.getZonePolygons()).length === 1);
  db.close();
  db = new RouteDatabase(dbPath);
  check('구역 경계가 재실행 후에도 유지', !!db.getZonePolygons()['강남']);

  // ── 백업 ────────────────────────────────────────────
  section('Test 6b — 백업 저장/복구');
  const payload = db.buildBackupPayload();
  check('백업에 주행기록 포함', Object.keys(payload.data).length === 3);
  check('백업에 구역 경계 포함', !!payload.zonePolygons['강남']);
  check('백업에 import 정보 포함', Array.isArray(payload.imports) && payload.imports.length > 0,
    `${payload.imports.length}건`);
  check('백업에 차량 정보 포함',
    Object.values(payload.data)[0][0].vehicle !== undefined);
  check('백업에 차량 설정(vehicles) 포함(요구사항 23)',
    Array.isArray(payload.vehicles) && payload.vehicles.some(v => v.name === '토레스 1호'));
  check('백업에 지역 설정(zones) 포함(요구사항 23)',
    Array.isArray(payload.zones) && payload.zones.some(z => z.name === '강남'));
  check('백업에 설정(settings) 포함(요구사항 23)',
    payload.settings && Array.isArray(payload.settings.coverageDepthTiers));

  // v2 백업(오늘날의 vehicles/zones/settings 필드가 없는 옛 백업) 을 복구해도
  // 깨지지 않아야 한다 — 있는 필드만 쓰고 없는 필드는 그냥 건너뛴다.
  const v2Payload = {
    type: 'route-viewer-backup', version: 2,
    exportedAt: new Date().toISOString(),
    data: { '2026-08-13': [{ date: '2026-08-13', time: '09:00:00', vehicle: '토레스 9호', lat: 37.4, lng: 127.1 }] },
    zonePolygons: {}, backupHistory: [],
  };
  const dbV2 = new RouteDatabase(freshDbPath());
  const v2Res = dbV2.restoreBackupPayload(v2Payload, 'merge');
  check('v2 백업(vehicles/zones/settings 없음)도 정상 복구됨',
    v2Res.inserted === 1 && dbV2.getStats().points === 1, JSON.stringify(v2Res));
  check('v2 백업 복구 후에도 기본 차량/지역 설정은 그대로 seed돼 있다',
    dbV2.listVehicles().length === 4 && dbV2.listZones().length === 3);
  dbV2.close();

  // 병합 복구 — 기존 데이터에 더해도 늘어나지 않아야 함(전부 중복)
  const ptsBeforeRestore = db.getStats().points;
  const mergeRes = db.restoreBackupPayload(payload, 'merge');
  check('병합 복구: 중복이라 늘지 않음', db.getStats().points === ptsBeforeRestore,
    `${ptsBeforeRestore} → ${db.getStats().points} (중복 ${mergeRes.duplicates})`);

  // 전체 교체 복구
  const dbR = new RouteDatabase(freshDbPath());
  importFile(dbR, f12);
  const replaceRes = dbR.restoreBackupPayload(payload, 'replace');
  check('전체 교체 복구: 백업 내용으로 대체', dbR.getStats().days === 3,
    `${dbR.getStats().days}일, ${replaceRes.inserted}건`);
  dbR.close();

  // 빈 DB에 병합 복구
  const dbM = new RouteDatabase(freshDbPath());
  dbM.restoreBackupPayload(payload, 'merge');
  check('빈 DB에 병합 복구', dbM.getStats().points === ptsBeforeRestore,
    `${dbM.getStats().points}개`);
  dbM.close();

  // ══════════════════════════════════════════════════
  //  Test E — 값 충돌 (동일 key, 다른 field)
  // ══════════════════════════════════════════════════
  section('Test E — 값 충돌 검사');
  const dbE = new RouteDatabase(freshDbPath());
  const base = { date: '2026-08-24', time: '14:32:00', vehicle: '토레스 2호', lat: 37.12345, lng: 127.12345, speed: '0.0' };
  const conflictRec = { ...base, speed: '0.5' };
  const rE = dbE.importRecords([base, conflictRec], { filename: 'conflict-test.xlsx' });
  check('같은 key 2건 중 1건만 새로 추가', rE.inserted === 1, `inserted=${rE.inserted}`);
  check('나머지 1건은 중복으로 집계', rE.duplicates === 1, `duplicates=${rE.duplicates}`);
  check('그 중복은 충돌로 표시(값이 다름)', rE.conflicts === 1 && rE.exactDuplicates === 0,
    `conflicts=${rE.conflicts} exact=${rE.exactDuplicates}`);
  check('충돌 상세에 어떤 필드가 달랐는지 기록됨',
    rE.conflictDetails[0].diffs.some(d => d.field === 'speed' && d.from === '0.0' && d.to === '0.5'),
    JSON.stringify(rE.conflictDetails[0].diffs));
  const importRowE = dbE.listImports()[0];
  check('Import History에도 충돌 건수가 남는다', importRowE.conflicts === 1);
  const conflictsFromHistory = dbE.getImportConflicts(importRowE.id);
  check('Import History에서 충돌 상세를 다시 조회할 수 있다', conflictsFromHistory.length === 1);

  // 완전 동일 중복은 충돌로 안 잡혀야 함
  const rE2 = dbE.importRecords([base], { filename: 'exact-dup.xlsx' });
  check('완전 동일 재전송은 충돌 0, 중복 1', rE2.conflicts === 0 && rE2.duplicates === 1 && rE2.exactDuplicates === 1,
    JSON.stringify(rE2));
  dbE.close();

  // ══════════════════════════════════════════════════
  //  Test F/G — Coverage % · Coverage Depth
  // ══════════════════════════════════════════════════
  section('Test F/G — Coverage % · Coverage Depth (연속 방문은 1회로 묶임)');
  const dbF = new RouteDatabase(freshDbPath());
  dbF.saveZone({ name: '강남', polygon: [[37.49, 127.02], [37.51, 127.02], [37.51, 127.05], [37.49, 127.05]] });

  // 폴리곤 안의 셀 하나에 GPS 20개를 연속으로 찍는다 — 방문 1회여야 한다(요구사항 12)
  const sessionPts = [];
  for (let i = 0; i < 20; i++) {
    sessionPts.push({
      date: '2026-08-20', time: `09:00:${String(i).padStart(2, '0')}`, vehicle: '토레스 1호',
      lat: 37.500, lng: 127.030, zone: '강남',
    });
  }
  dbF.importRecords(sessionPts, { filename: 'coverage-session.xlsx' });
  const box = { minLat: 37.49, maxLat: 37.51, minLng: 127.02, maxLng: 127.05, refLat: 37.5 };
  const visits = dbF.getCellVisitCounts(box, 50);
  const hitCell = visits.find(v => v.visits > 0);
  check('20개 연속 GPS가 찍힌 셀의 방문 횟수는 1', hitCell && hitCell.visits === 1,
    JSON.stringify(visits.filter(v => v.visits > 0)));

  // 같은 셀을 벗어났다가 다시 들어오면 방문이 늘어나야 한다
  const returnPts = [
    { date: '2026-08-20', time: '09:05:00', vehicle: '토레스 1호', lat: 37.505, lng: 127.040, zone: '강남' }, // 다른 셀
    { date: '2026-08-20', time: '09:06:00', vehicle: '토레스 1호', lat: 37.500, lng: 127.030, zone: '강남' }, // 원래 셀로 복귀
  ];
  dbF.importRecords(returnPts, { filename: 'coverage-return.xlsx' });
  const visits2 = dbF.getCellVisitCounts(box, 50);
  const hitCell2 = visits2.find(v => v.gy === hitCell.gy && v.gx === hitCell.gx);
  check('셀을 벗어났다가 복귀하면 방문이 2회로 늘어난다', hitCell2 && hitCell2.visits === 2,
    JSON.stringify(hitCell2));

  const settingsF = dbF.getSettings();
  check('Coverage Depth 기본 등급 4단계(미수집/부족/보통/충분)',
    settingsF.coverageDepthTiers.length === 4 &&
    settingsF.coverageDepthTiers.map(t => t.label).join(',') === '미수집,부족,보통,충분',
    JSON.stringify(settingsF.coverageDepthTiers));
  dbF.close();

  // ══════════════════════════════════════════════════
  //  Test H/I — 차량/지역 설정을 코드 수정 없이 추가
  // ══════════════════════════════════════════════════
  section('Test H/I — 차량/지역 추가 (설정 데이터화, 요구사항 13~16)');
  const dbH = new RouteDatabase(freshDbPath());
  const seededVehicles = dbH.listVehicles().map(v => v.name);
  check('기존 토레스 1~4호가 그대로 유지(migration)',
    seededVehicles.join(',') === '토레스 1호,토레스 2호,토레스 3호,토레스 4호', seededVehicles.join(','));

  const newVehicle = dbH.saveVehicle({ name: '토레스 5호', color: '#123456' });
  check('새 차량이 코드 수정 없이 추가됨', newVehicle.name === '토레스 5호' && newVehicle.active === true);
  check('추가 즉시 listVehicles()에 반영', dbH.listVehicles().some(v => v.name === '토레스 5호'));

  // 비활성화해도 과거 데이터는 안 지워진다
  dbH.importRecords([{ date: '2026-08-21', time: '10:00:00', vehicle: '토레스 5호', lat: 37.5, lng: 127.0 }],
    { filename: 'v5-drive.xlsx' });
  dbH.setVehicleActive('토레스 5호', false);
  check('차량 비활성화 후에도 필터 목록에서 이름은 조회 가능(active=false)',
    dbH.listVehicles().find(v => v.name === '토레스 5호').active === false);
  check('차량을 비활성화해도 과거 주행 기록은 삭제되지 않는다',
    dbH.getRecordsByDate('2026-08-21').length === 1);

  const seededZones = dbH.listZones().map(z => z.name);
  check('기존 강남/판교/시흥이 그대로 유지(migration)', seededZones.join(',') === '강남,판교,시흥');

  const newZone = dbH.saveZone({ name: '성남', color: '#abcdef', centerLat: 37.42, centerLng: 127.13 });
  check('새 지역이 코드 수정 없이 추가됨', newZone.name === '성남');
  check('추가 즉시 지역 경계를 그릴 수 있는 상태(zones 테이블에 존재)',
    dbH.listZones().some(z => z.name === '성남'));
  dbH.saveZone({ name: '성남', polygon: [[37.40, 127.10], [37.44, 127.10], [37.44, 127.16], [37.40, 127.16]] });
  const polysAfter = dbH.getZonePolygons();
  check('성남 경계를 그리면 getZonePolygons()(누적지도가 읽는 API)에 바로 나타난다',
    Array.isArray(polysAfter['성남']) && polysAfter['성남'].length === 4);
  dbH.setZoneActive('성남', false);
  check('지역 비활성화 가능(과거 기록엔 영향 없음)',
    dbH.listZones().find(z => z.name === '성남').active === false);
  dbH.close();

  // ── 삭제는 명시적으로만 ─────────────────────────────
  section('Test 11 — 삭제는 명시적인 기능으로만');
  const daysBeforeDelete = db.getStats().days;
  const del = db.deleteDate('2026-08-12');
  check('날짜 하나만 삭제', db.getStats().days === daysBeforeDelete - 1,
    `${del.removed}개 삭제, ${db.getStats().days}일 남음`);
  check('삭제한 날짜가 달력에서도 빠짐',
    !db.listDateSummaries().some(s => s.date === '2026-08-12'));
  check('다른 날짜는 그대로', db.getStats().days === 2);
  db.deleteAll();
  check('전체 삭제', db.getStats().points === 0 && db.getStats().days === 0);
  db.close();

  // ── 결과 ────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed) {
    console.log('\n  실패 항목:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
}

main();
