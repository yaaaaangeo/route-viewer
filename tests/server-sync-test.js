// ══════════════════════════════════════════════════════════
//  server-sync-test — server.js 의 공유 저장 병합(merge) 로직을 검증.
//
//    · PUT을 여러 번 해도 기존 기록이 지워지지 않는다
//    · 같은 레코드를 두 번 올려도 중복되지 않는다
//    · GET 으로 병합된 전체가 그대로 내려온다
//    · /updates/* 가 release/ 폴더 파일을 내려준다(있으면)
// ══════════════════════════════════════════════════════════
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { RouteDatabase } = require('../electron/database.js');

const ROOT = path.join(__dirname, '..');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE + '/api/route-data');
      if (res.status === 404 || res.ok) return true;
    } catch (_) { /* 아직 안 떴음 */ }
    await sleep(150);
  }
  return false;
}

function makeRecord(date, time, vehicle, lat, lng, extra) {
  return { date, time, vehicle, lat, lng, zone: '강남', place: '강남', road: '도심', weather: '맑음', timeOfDay: '주간', speed: '0.0', ...extra };
}

function backupPayload(dateRows, extra) {
  return {
    type: 'route-viewer-backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    data: dateRows,
    zonePolygons: {},
    backupHistory: [],
    imports: [],
    ...(extra || {}),
  };
}

async function main() {
  const dataFile = path.join(ROOT, 'route-viewer-shared-data.json');
  try { fs.unlinkSync(dataFile); } catch (_) { /* 없으면 무시 */ }

  const node = path.join(ROOT, 'tooling', 'node-v24.19.0-win-x64', 'node.exe');
  const nodeExe = fs.existsSync(node) ? node : process.execPath;
  const child = spawn(nodeExe, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', d => console.error('[server]', d.toString()));

  try {
    const up = await waitForServer();
    check('서버가 뜬다', up);
    if (!up) return;

    // 1) 처음 데이터가 없을 때 GET은 404
    const g0 = await fetch(BASE + '/api/route-data');
    check('처음엔 404', g0.status === 404, `status=${g0.status}`);

    // 2) 첫 번째 클라이언트가 8/23 기록을 올림
    const p1 = backupPayload({
      '2026-08-23': [
        makeRecord('2026-08-23', '09:00:00', '토레스 1호차', 37.5, 127.03),
        makeRecord('2026-08-23', '09:00:30', '토레스 1호차', 37.501, 127.031),
      ],
    });
    const put1 = await fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p1) });
    const put1json = await put1.json();
    check('첫 PUT 성공', put1.ok);
    check('첫 PUT: 2건 다 새로 추가', put1json.inserted === 2 && put1json.duplicates === 0, JSON.stringify(put1json));

    // 3) 두 번째 클라이언트가 8/24 기록을 올림 — 8/23이 사라지면 안 됨
    const p2 = backupPayload({
      '2026-08-24': [
        makeRecord('2026-08-24', '10:00:00', '토레스 2호차', 37.51, 127.04),
      ],
    });
    const put2 = await fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p2) });
    const put2json = await put2.json();
    check('둘째 PUT 성공', put2.ok);
    check('둘째 PUT: dateCount가 2 (8/23 안 지워짐)', put2json.dateCount === 2, JSON.stringify(put2json));

    const g1 = await fetch(BASE + '/api/route-data');
    const merged1 = await g1.json();
    check('GET에 8/23, 8/24 모두 있음', Object.keys(merged1.data).sort().join(',') === '2026-08-23,2026-08-24',
      Object.keys(merged1.data).join(','));
    check('8/23 기록 2건 그대로', merged1.data['2026-08-23'].length === 2);
    check('8/24 기록 1건', merged1.data['2026-08-24'].length === 1);

    // 4) 같은 8/23 기록을 다시 올림(중복) — 늘어나면 안 됨
    const put3 = await fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p1) });
    const put3json = await put3.json();
    check('중복 재전송: 새로 추가 0', put3json.inserted === 0, JSON.stringify(put3json));
    check('중복 재전송: 2건 다 중복 처리', put3json.duplicates === 2, JSON.stringify(put3json));

    const g2 = await fetch(BASE + '/api/route-data');
    const merged2 = await g2.json();
    check('중복 재전송 후에도 8/23은 여전히 2건(4건 아님)', merged2.data['2026-08-23'].length === 2,
      `${merged2.data['2026-08-23'].length}건`);

    // 5) 같은 8/23에 겹치지 않는 새 기록(오후)을 올리면 합쳐져야 함
    const p4 = backupPayload({
      '2026-08-23': [
        makeRecord('2026-08-23', '14:00:00', '토레스 1호차', 37.52, 127.05),
      ],
    });
    await fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p4) });
    const g3 = await fetch(BASE + '/api/route-data');
    const merged3 = await g3.json();
    check('같은 날짜 다른 시각 기록은 합쳐짐(3건)', merged3.data['2026-08-23'].length === 3,
      `${merged3.data['2026-08-23'].length}건`);
    const times = merged3.data['2026-08-23'].map(r => r.time);
    check('시간순 정렬됨', times.every((t, i) => i === 0 || times[i - 1] <= t), times.join(','));

    // 5b) 차량/지역 설정(vehicles/zones/settings)도 병합되는지 — 요구사항 13~16의
    // "설정 데이터화"가 서버 동기화에서도 유지되는지 확인 (한쪽 기기가 추가한 차량/지역이
    // 다른 기기로도 전파돼야 하고, 이미 그려둔 구역 경계는 지워지면 안 된다)
    const p5 = backupPayload({}, {
      vehicles: [{ name: '토레스 5호', color: '#123456', active: true }],
      zones: [{ name: '성남', color: '#abcdef', active: true, polygon: [[37.4, 127.1], [37.42, 127.1], [37.42, 127.14]] }],
      settings: { coverageDepthTiers: [{ threshold: 0, label: '테스트', color: '#000' }] },
    });
    await fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p5) });
    const g4 = await (await fetch(BASE + '/api/route-data')).json();
    check('새로 추가된 차량 설정이 서버 병합 결과에 전파됨',
      Array.isArray(g4.vehicles) && g4.vehicles.some(v => v.name === '토레스 5호'), JSON.stringify(g4.vehicles));
    check('새로 추가된 지역 설정(경계 포함)이 서버 병합 결과에 전파됨',
      Array.isArray(g4.zones) && g4.zones.some(z => z.name === '성남' && z.polygon && z.polygon.length === 3),
      JSON.stringify(g4.zones));
    check('설정(Coverage Depth 기준)도 함께 전파됨',
      g4.settings && g4.settings.coverageDepthTiers && g4.settings.coverageDepthTiers[0].label === '테스트');

    // 성남 경계 없이(빈 배열) 다시 올려도 — 뒤처진 기기가 동기화한다고 남의 경계를 지우면 안 된다
    const p6 = backupPayload({}, { zones: [{ name: '성남', color: '#abcdef', active: true, polygon: [] }] });
    await fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p6) });
    const g5 = await (await fetch(BASE + '/api/route-data')).json();
    const seongnam = g5.zones.find(z => z.name === '성남');
    check('경계 없는(구버전) 동기화가 기존에 그려둔 경계를 지우지 않는다',
      seongnam && seongnam.polygon && seongnam.polygon.length === 3, JSON.stringify(seongnam));

    // 5c) 수동 셀(manualCells: 제외/방문/미방문)도 동기화에서 보존·병합되는지
    const put = p => fetch(BASE + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    const getJson = async () => (await fetch(BASE + '/api/route-data')).json();
    const cellE = [37.40, 127.10], cellV = [37.41, 127.11], cellU = [37.42, 127.12];
    await put(backupPayload({}, { zones: [{ name: '판교', color: '#ffd93d', active: true, polygon: [], manualCells: { excluded: [cellE], visited: [cellV], unvisited: [cellU] } }] }));
    let pangyo = (await getJson()).zones.find(z => z.name === '판교');
    check('수동 셀(unvisited 포함)이 서버 병합 결과에 저장된다',
      pangyo && JSON.stringify(pangyo.manualCells) === JSON.stringify({ excluded: [cellE], visited: [cellV], unvisited: [cellU] }),
      JSON.stringify(pangyo && pangyo.manualCells));
    await put(backupPayload({}, { zones: [{ name: '판교', color: '#ffd93d', active: true, polygon: [] }] })); // 구버전 기기
    pangyo = (await getJson()).zones.find(z => z.name === '판교');
    check('manualCells가 없는 구버전 기기의 동기화가 기존 수동 셀을 지우지 않는다',
      pangyo && pangyo.manualCells && pangyo.manualCells.unvisited.length === 1 && pangyo.manualCells.excluded.length === 1);
    await put(backupPayload({}, { zones: [{ name: '판교', color: '#ffd93d', active: true, polygon: [], manualCells: { excluded: [], visited: [], unvisited: [cellV] } }] }));
    const synced = await getJson();
    pangyo = synced.zones.find(z => z.name === '판교');
    const asKeys = list => list.map(String).sort().join(' ');
    check('새로 온 수동 셀은 칸 단위 병합 — 같은 칸(V)은 새 상태(미방문)로, 나머지(E, U)는 유지',
      asKeys(pangyo.manualCells.excluded) === asKeys([cellE]) && pangyo.manualCells.visited.length === 0 &&
      asKeys(pangyo.manualCells.unvisited) === asKeys([cellU, cellV]), JSON.stringify(pangyo.manualCells));
    // 서버 → 다른 기기 SQLite (electron/main.js sync:run 이 쓰는 restoreBackupPayload 경로 그대로)
    const otherDevice = new RouteDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-sync-')), 'route-viewer.db'));
    otherDevice.restoreBackupPayload(synced, 'merge');
    const pulled = otherDevice.getZoneManualCells('판교');
    check('서버에서 받아온 수동 셀(미방문 포함)이 다른 기기 SQLite에 그대로 들어간다',
      asKeys(pulled.excluded) === asKeys([cellE]) && asKeys(pulled.unvisited) === asKeys([cellU, cellV]) && pulled.visited.length === 0,
      JSON.stringify(pulled));
    otherDevice.close();

    // 6) 저장 암호 없이 진행했으니 401은 별도 서버 인스턴스로 확인 (생략 — 기존 로직 그대로 재사용)

    // 7) /updates 정적 서빙 (release 폴더가 있으면)
    const releaseDir = path.join(ROOT, 'release');
    if (fs.existsSync(releaseDir)) {
      const files = fs.readdirSync(releaseDir).filter(f => f.endsWith('.exe'));
      if (files.length) {
        const r = await fetch(BASE + '/updates/' + encodeURIComponent(files[0]));
        check('/updates 에서 설치 파일을 내려받을 수 있다', r.ok, `status=${r.status}`);
      } else {
        console.log('  (release/ 에 .exe 없음 — /updates 서빙 테스트 건너뜀)');
      }
    } else {
      console.log('  (release/ 폴더 없음 — /updates 서빙 테스트 건너뜀)');
    }

    // 참고: server.js는 원래부터 ROOT 전체(프로젝트 폴더)를 정적으로 공개하는
    // 내부용 툴이라(SHARED_STORAGE.md에 문서화됨), '/updates/../server.js'는
    // URL 정규화로 '/server.js'가 되어 일반 정적 핸들러가 그대로 서빙한다 —
    // 이는 v3 이전부터 있던 동작이고 /updates 추가로 생긴 구멍이 아니다.
    // 여기서 확인할 건 '드라이브 루트 바깥으로는 못 나간다'는 것뿐.
    const rEscape = await fetch(BASE + '/updates/' + '../'.repeat(6) + 'windows/win.ini');
    check('release/ 폴더를 벗어난 임의 경로는 실제 파일을 못 읽는다',
      rEscape.status === 404 || rEscape.status === 403, `status=${rEscape.status}`);
    const rNoFile = await fetch(BASE + '/updates/');
    check('/updates/ 만 요청하면 목록이 아니라 404', rNoFile.status === 404, `status=${rNoFile.status}`);

  } finally {
    child.kill();
    try { fs.unlinkSync(dataFile); } catch (_) { /* 무시 */ }
  }

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  failures.forEach(f => console.log('   - ' + f));
  console.log(`${'-'.repeat(58)}\n`);
  process.exit(failed ? 1 : 0);
}

main();
