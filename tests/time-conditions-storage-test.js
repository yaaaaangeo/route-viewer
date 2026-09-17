// ══════════════════════════════════════════════════════════
//  time-conditions-storage-test — 교통 시간대·조도 분류의 저장·호환·재분류·동기화·화면
//
//   1. 구버전 DB 로드(SQLite · IndexedDB) — 초기화 없이 열리고 요약이 새 형식으로 채워진다
//   2. 구버전 Excel Import — '시간대' 열 원본 보존 / '시간대'·'날씨' 열 없는 파일도 분류
//   3. 구버전 백업 복원 — 분류 설정 없는 백업 · 잘못된 분류값/설정이 든 백업
//   4. 중복 판정 불변 — 설정을 바꾸고 다시 넣어도 새 레코드 0 · 충돌 집계 동일
//   5. 설정 저장 검증(SQLite · IndexedDB) — 정상 저장 · 겹침/공백/범위 거부 · 기본값 복원
//   6. 재분류 — 진행률 · 중복 실행 방지 · 실패 시 기존 데이터 보존 · 앱 재시작 후 이어서
//   7. SQLite ↔ IndexedDB 결과 일치(실제 주행기록 전체, 설정 변경 전후)
//   8. 서버 동기화 후 분류 유지(실제 server.js)
//   9. 화면(settings.js · statistics.js · calendar.js 실제 파일) — 저장 거부 이유 표시, 저장 후
//      재분류·통계 갱신, 기본값 복원, 중복 실행 방지, 일자 요약의 두 축 분포
//
//  실행: node tests/time-conditions-storage-test.js   (npm test 에 포함)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

const TC = require('../src/js/time-conditions.js');
const CSt = require('../src/js/condition-stats.js');
const RouteParser = require('../src/js/parser.js');
const { RouteDatabase } = require('../electron/database.js');
const { createDesktopApi, createStorageContext, baseContext, load, readSource } = require('./helpers/route-context');
const { createFakeIndexedDB } = require('./helpers/fake-indexeddb');

const ROOT = path.join(__dirname, '..');
const XLSX_DIR = path.join(ROOT, '주행기록');
const FILES = fs.readdirSync(XLSX_DIR).filter(f => /\.xlsx?$/i.test(f)).sort();
// 날짜가 서로 다른 파일 6개(같은 날짜 파일이 여러 개라 앞에서 6개를 자르면 2일치뿐이다)
const SUBSET = (() => {
  const seen = new Set(), out = [];
  for (const f of FILES) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]); out.push(f);
    if (out.length === 6) break;
  }
  return out;
})();

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  [32mPASS[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  [31mFAIL[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(t) { console.log(`\n[36m${t}[0m`); }
const freshPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-tc-')), 'route-viewer.db');
const DEFAULT_SIG = TC.classificationSignature(TC.classificationConfig({}));

function parsedFile(f) {
  const buf = fs.readFileSync(path.join(XLSX_DIR, f));
  return { records: RouteParser.parseBuffer(buf), meta: { filename: f, fileHash: RouteDatabase.hashFile(buf) } };
}
const PARSED = new Map();
const parsed = f => { if (!PARSED.has(f)) PARSED.set(f, parsedFile(f)); return PARSED.get(f); };

// 퇴근 피크를 18:00부터로 · 일몰 전후 45분 — 실제 기록(17시대 있음)에서 분포가 달라지는 설정
function shiftedPeriods() {
  const p = TC.defaultTrafficPeriods();
  p.find(x => x.id === 'afternoon_offpeak').end = '18:00';
  p.find(x => x.id === 'evening_peak').start = '18:00';
  return p;
}
const SHIFTED = { trafficPeriods: shiftedPeriods(), sunsetWindowMinutes: 45 };
const SHIFTED_SIG = TC.classificationSignature(TC.classificationConfig(SHIFTED));

function fakeDocument() {
  const els = new Map();
  const make = id => {
    const classes = new Set();
    return {
      id, textContent: '', innerHTML: '', value: '', disabled: false, style: {}, dataset: {}, className: '', children: [],
      appendChild(c) { this.children.push(c); }, addEventListener() {}, focus() {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; } },
    };
  };
  return { els, getElementById: id => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); }, createElement: () => make(''), querySelectorAll: () => [], querySelector: () => null };
}

async function sqliteRouteDB(db) {
  const api = createDesktopApi(db);
  const ctx = createStorageContext({ api });
  await ctx.RouteDB.init();
  return { RouteDB: ctx.RouteDB, api, ctx };
}

// 브라우저 모드 — 날짜 요약은 실제 core.js buildDaySummaryFromPoints 로 만든다
async function idbRouteDB(fake) {
  const ctx = baseContext({ indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange, document: fakeDocument(), setInterval: () => 0 });
  ['src/js/quality.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js', 'src/js/condition-stats.js', 'src/js/recommendation.js', 'src/js/core.js', 'src/js/coverage-grid.js', 'src/js/storage.js']
    .forEach(f => load(ctx, f));
  await ctx.RouteDB.init();
  return { RouteDB: ctx.RouteDB, ctx };
}

const condPart = s => JSON.stringify({ sig: s.classificationSignature, cells: s.conditionCells });
const summaryMap = list => new Map(list.map(s => [s.date, s]));

async function raw(fake) {
  return new Promise((resolve, reject) => { const r = fake.indexedDB.open('route-viewer', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
const reqp = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const txDone = t => new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });

async function main() {
  // ── 1 ──────────────────────────────────────────────────
  section('1. 구버전 DB 로드 — 별도 초기화 없이');
  {
    const p = freshPath();
    let db = new RouteDatabase(p);
    SUBSET.forEach(f => db.importRecords(parsed(f).records, parsed(f).meta));
    const hashes = db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join();
    const tod = JSON.stringify(db.getDistribution('timeOfDay'));
    const points = db.getStats().points;
    // 구버전 흉내: 요약 형식 v3(조건 칸·서명 없음) + 분류 설정이 없는 app_settings
    for (const row of db.db.all('SELECT date, summary_json FROM date_summaries')) {
      const s = JSON.parse(row.summary_json);
      delete s.conditionCells; delete s.classificationSignature;
      db.db.run('UPDATE date_summaries SET summary_json=? WHERE date=?', [JSON.stringify(s), row.date]);
    }
    db.setMeta('summary_version', '3');
    db.setMeta('app_settings', JSON.stringify({ coverageDepthTiers: [{ threshold: 0, label: '미수집', color: '#000' }, { threshold: 3, label: '됨', color: '#fff' }] }));
    const legacyHasCells = db.listDateSummaries().some(s => s.conditionCells);
    db.close();

    db = new RouteDatabase(p);
    const sums = db.listDateSummaries();
    const st = db.getClassificationStatus();
    check('[SQLite] 구버전 요약(조건 칸 없음)이 앱을 열 때 새 형식으로 다시 만들어진다',
      !legacyHasCells && sums.length > 0 && sums.every(s => Array.isArray(s.conditionCells) && s.classificationSignature === DEFAULT_SIG) && st.staleDates === 0,
      `날짜 ${sums.length}일 · 재분류 필요 ${st.staleDates}일`);
    check('[SQLite] 원본 기록(해시·건수)과 파일 원본 시간대(timeOfDay) 분포는 그대로',
      db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join() === hashes
      && JSON.stringify(db.getDistribution('timeOfDay')) === tod && db.getStats().points === points, `${points}건 · timeOfDay ${tod}`);
    const s = db.getSettings();
    check('[SQLite] 분류 설정이 없던 예전 설정 → 기본 교통 시간대·±30분 · 기존 설정값(Depth 기준) 유지',
      JSON.stringify(s.trafficPeriods) === JSON.stringify(TC.defaultTrafficPeriods()) && s.sunriseWindowMinutes === 30 && s.coverageDepthTiers[1].threshold === 3);
    db.close();
  }
  {
    const fake = createFakeIndexedDB();
    let { RouteDB } = await idbRouteDB(fake);
    for (const f of SUBSET.slice(0, 3)) await RouteDB.importRecords(parsed(f).records, parsed(f).meta);
    const statsBefore = await RouteDB.stats();
    const rdb = await raw(fake);
    const allSums = await (async () => { const t = rdb.transaction(['summaries'], 'readonly'); const r = reqp(t.objectStore('summaries').getAll()); await txDone(t); return r; })();
    {
      const t = rdb.transaction(['summaries', 'meta'], 'readwrite');
      allSums.forEach(s => { const c = { ...s }; delete c.conditionCells; delete c.classificationSignature; t.objectStore('summaries').put(c); });
      t.objectStore('meta').put({ key: 'summary_version', value: 3 });
      t.objectStore('meta').put({ key: 'app_settings', value: { coverageDepthTiers: [{ threshold: 0, label: '미수집', color: '#000' }] } });
      await txDone(t);
    }
    ({ RouteDB } = await idbRouteDB(fake)); // 앱을 다시 연다
    const sums = await RouteDB.listDateSummaries();
    const st = await RouteDB.getClassificationStatus();
    const statsAfter = await RouteDB.stats();
    check('[IndexedDB] 구버전 요약이 열 때 새 형식으로 · 기록 수 그대로',
      sums.every(s => Array.isArray(s.conditionCells) && s.classificationSignature === DEFAULT_SIG) && st.staleDates === 0 && statsAfter.points === statsBefore.points,
      `날짜 ${sums.length}일 · ${statsAfter.points}건`);
  }

  // ── 2 ──────────────────────────────────────────────────
  section('2. 구버전 Excel Import');
  {
    const db = new RouteDatabase(freshPath());
    const f = FILES.find(x => parsed(x).records.some(r => r.timeOfDay === '일몰'));
    db.importRecords(parsed(f).records, parsed(f).meta);
    const date = parsed(f).records.find(r => r.timeOfDay === '일몰').date;
    const recs = db.getRecordsByDate(date);
    const sunsetLabel = recs.find(r => r.timeOfDay === '일몰');
    check("파일의 '시간대' 열 원본(timeOfDay '주간'/'일몰')은 그대로 보존되고, 새 분류가 따로 붙는다",
      recs.every(r => ['주간', '일몰'].includes(r.timeOfDay) && r.trafficPeriod && r.lightCondition && r.weekdayType),
      `${f} · ${recs.length}건`);
    check("  원본 '일몰'(17시대)과 계산된 조도는 별개 — 실제 일몰보다 이르면 조도는 주간, 교통은 퇴근 피크",
      !!sunsetLabel && sunsetLabel.lightCondition === 'daylight' && sunsetLabel.trafficPeriod === 'evening_peak',
      sunsetLabel && `${sunsetLabel.date} ${sunsetLabel.time} 원본 '${sunsetLabel.timeOfDay}' → 교통 ${sunsetLabel.trafficPeriod} · 조도 ${sunsetLabel.lightCondition} (일몰 ${TC.formatClock(TC.sunTimes(sunsetLabel.date, sunsetLabel.lat, sunsetLabel.lng).sunsetMinutes)})`);

    const aoa = [
      ['차량', '토레스 9호차', '이름', '테스트'], [],
      ['번호', '날짜', '시각', 'GPS위치', '도로종류', '장소', '차량속도(km/h)'],
      ...Array.from({ length: 5 }, (_, i) => [i + 1, '2026-09-15', `18:${String(30 + i).padStart(2, '0')}:00`, `${(37.4979 + i * 0.0003).toFixed(6)}, 127.027600`, '도심', '서울 강남구 테헤란로', '20.0']),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const recs2 = RouteParser.parseBuffer(buf);
    const res = db.importRecords(recs2, { filename: 'old-no-timeofday.xlsx', fileHash: RouteDatabase.hashFile(buf) });
    const got = db.getRecordsByDate('2026-09-15').filter(r => r.vehicle === '토레스 9호차');
    check("'시간대'·'날씨' 열이 없는 옛 파일도 Import 되고 Timestamp·GPS로 분류된다",
      res.inserted === 5 && got.length === 5 && got.every(r => r.timeOfDay === '' && r.weather === '' && r.trafficPeriod === 'evening_peak' && r.lightCondition === 'sunset' && r.weekdayType === 'weekday'),
      `inserted ${res.inserted} · ${got[0] && JSON.stringify({ timeOfDay: got[0].timeOfDay, trafficPeriod: got[0].trafficPeriod, lightCondition: got[0].lightCondition })}`);
    db.close();
  }

  // ── 3 ──────────────────────────────────────────────────
  section('3. 구버전 백업 복원');
  const legacyBackup = () => ({
    type: 'route-viewer-backup', version: 3, exportedAt: '2026-09-01T00:00:00.000Z', zonePolygons: {}, backupHistory: [],
    data: {
      '2026-09-15': [
        { date: '2026-09-15', time: '18:30:00', vehicle: '토레스 1호차', zone: '강남', place: '강남', road: '도심', weather: '비', timeOfDay: '일몰', traffic: '', speed: '10', lat: 37.4979, lng: 127.0276, trafficPeriod: 'late_night', lightCondition: 'night' },
        { date: '2026-09-15', time: '18:30:30', vehicle: '토레스 1호차', zone: '강남', place: '강남', road: '도심', weather: '비', timeOfDay: '일몰', traffic: '', speed: '10', lat: 37.4981, lng: 127.0276 },
      ],
    },
  });
  for (const kind of ['SQLite', 'IndexedDB']) {
    const { RouteDB } = kind === 'SQLite' ? await sqliteRouteDB(new RouteDatabase(freshPath())) : await idbRouteDB(createFakeIndexedDB());
    const r1 = await RouteDB.restoreBackupPayload(legacyBackup(), 'merge');
    const recs = await RouteDB.getRecordsByDate('2026-09-15');
    check(`[${kind}] 분류 필드·설정이 없는 v3 백업 복원 → 기록에 분류가 붙고 timeOfDay 원본 유지`,
      r1.inserted === 2 && recs.every(r => r.timeOfDay === '일몰' && r.trafficPeriod === 'evening_peak' && r.lightCondition === 'sunset'), `inserted ${r1.inserted}`);
    check(`[${kind}]   백업 안의 잘못된 분류값(trafficPeriod:'late_night')은 믿지 않고 다시 계산`, recs[0].trafficPeriod === 'evening_peak' && recs[0].lightCondition === 'sunset');
    const bad = TC.defaultTrafficPeriods(); bad[3].start = '09:00';
    const r2 = await RouteDB.restoreBackupPayload({ ...legacyBackup(), settings: { trafficPeriods: bad, sunsetWindowMinutes: 45 } }, 'merge');
    const s2 = await RouteDB.getSettings();
    const st2 = await RouteDB.getClassificationStatus();
    check(`[${kind}]   백업 설정의 잘못된 교통 시간대는 무시(지금 설정 유지) · 올바른 일몰 범위(45분)는 반영 · 요약 재분류`,
      r2.inserted === 0 && JSON.stringify(s2.trafficPeriods) === JSON.stringify(TC.defaultTrafficPeriods()) && s2.sunsetWindowMinutes === 45 && st2.staleDates === 0
      && (await RouteDB.listDateSummaries()).every(s => s.classificationSignature === st2.signature),
      `재분류 ${r2.reclassifiedDates}일`);
  }

  // ── 4 ──────────────────────────────────────────────────
  section('4. 중복 판정 키 불변');
  {
    const a = new RouteDatabase(freshPath());
    SUBSET.forEach(f => a.importRecords(parsed(f).records, parsed(f).meta));
    const secondA = SUBSET.map(f => a.importRecords(parsed(f).records, parsed(f).meta));
    const b = new RouteDatabase(freshPath());
    SUBSET.forEach(f => b.importRecords(parsed(f).records, parsed(f).meta));
    const pointsB = b.getStats().points;
    b.setSettings(SHIFTED);
    await b.reclassifySummaries();
    const secondB = SUBSET.map(f => b.importRecords(parsed(f).records, parsed(f).meta));
    const sum = (arr, k) => arr.reduce((acc, r) => acc + r[k], 0);
    check('설정을 바꾸고 같은 파일을 다시 넣어도 새 레코드 0 · 기록 수 그대로',
      sum(secondB, 'inserted') === 0 && b.getStats().points === pointsB, `${pointsB}건`);
    check('  중복·충돌 집계가 설정을 바꾸지 않은 DB와 똑같다',
      sum(secondA, 'duplicates') === sum(secondB, 'duplicates') && sum(secondA, 'conflicts') === sum(secondB, 'conflicts'),
      `중복 ${sum(secondB, 'duplicates')} · 충돌 ${sum(secondB, 'conflicts')}`);
    const rec = parsed(SUBSET[0]).records[0];
    const n = RouteDatabase.normalize(rec);
    check('  record_hash 는 분류 필드를 넣어도 같다(date|time|vehicle|lat|lng)',
      RouteDatabase.hashOf(n) === RouteDatabase.hashOf(RouteDatabase.normalize({ ...rec, trafficPeriod: 'night', lightCondition: 'sunset', weekdayType: 'weekend' })));
    const conflictRes = b.importRecords([{ ...rec, trafficPeriod: 'night', lightCondition: 'night' }], { filename: 'same-key.xlsx' });
    check('  같은 키 · 분류 필드만 다른 행 → 충돌이 아니라 완전 동일 중복(분류는 비교 필드가 아님)',
      conflictRes.inserted === 0 && conflictRes.conflicts === 0 && conflictRes.exactDuplicates === 1);
    const payload = b.buildBackupPayload();
    const c = new RouteDatabase(freshPath());
    const r1 = c.restoreBackupPayload(payload, 'merge');
    const r2 = c.restoreBackupPayload(payload, 'merge');
    check('  분류 필드가 실린 백업을 두 번 복원해도 기록이 늘지 않는다', c.getStats().points === pointsB && r1.inserted === pointsB && r2.inserted === 0,
      `복원 ${r1.inserted} → 재복원 ${r2.inserted}`);
    check('  백업의 분류 설정도 함께 복원된다', TC.classificationSignature(TC.classificationConfig(c.getSettings())) === SHIFTED_SIG);
    const { RouteDB: idb } = await idbRouteDB(createFakeIndexedDB());
    for (const f of SUBSET.slice(0, 2)) await idb.importRecords(parsed(f).records, parsed(f).meta);
    const idbPoints = (await idb.stats()).points;
    await idb.setSettings(SHIFTED);
    await idb.reclassifySummaries();
    let again = 0;
    for (const f of SUBSET.slice(0, 2)) again += (await idb.importRecords(parsed(f).records, parsed(f).meta)).inserted;
    check('[IndexedDB] 설정 변경 후 다시 넣어도 새 레코드 0', again === 0 && (await idb.stats()).points === idbPoints);
    [a, b, c].forEach(d => d.close());
  }

  // ── 5 ──────────────────────────────────────────────────
  section('5. 설정 저장 검증');
  for (const kind of ['SQLite', 'IndexedDB']) {
    const { RouteDB } = kind === 'SQLite' ? await sqliteRouteDB(new RouteDatabase(freshPath())) : await idbRouteDB(createFakeIndexedDB());
    const saved = await RouteDB.setSettings({ trafficPeriods: [...shiftedPeriods()].reverse() });
    check(`[${kind}] 정상적인 시간대 설정 저장(시작 시각 순으로 정규화)`,
      saved.trafficPeriods.find(p => p.id === 'evening_peak').start === '18:00' && saved.trafficPeriods[0].id === 'late_night');
    const before = JSON.stringify((await RouteDB.getSettings()).trafficPeriods);
    const overlap = shiftedPeriods(); overlap.find(p => p.id === 'lunch_peak').start = '11:00';
    let e1 = null; try { await RouteDB.setSettings({ trafficPeriods: overlap }); } catch (e) { e1 = e; }
    check(`[${kind}] 겹치는 시간대 저장 거부 · 이유 · 기존 설정 그대로`,
      !!e1 && /겹쳐요/.test(e1.message) && JSON.stringify((await RouteDB.getSettings()).trafficPeriods) === before, e1 && e1.message);
    const gap = shiftedPeriods(); gap.find(p => p.id === 'lunch_peak').end = '13:00';
    let e2 = null; try { await RouteDB.setSettings({ trafficPeriods: gap }); } catch (e) { e2 = e; }
    check(`[${kind}] 비어 있는 시간 구간 저장 거부`, !!e2 && /공백/.test(e2.message) && JSON.stringify((await RouteDB.getSettings()).trafficPeriods) === before, e2 && e2.message);
    let e3 = null; try { await RouteDB.setSettings({ sunriseWindowMinutes: 500, coverageDepthTiers: [] }); } catch (e) { e3 = e; }
    check(`[${kind}] 잘못된 일출 전후 범위 → 같이 보낸 다른 설정도 저장하지 않음`, !!e3 && (await RouteDB.getSettings()).sunriseWindowMinutes === 30);
    await RouteDB.setSettings({ trafficPeriods: TC.defaultTrafficPeriods() });
    check(`[${kind}] 기본값 복원`, JSON.stringify((await RouteDB.getSettings()).trafficPeriods) === JSON.stringify(TC.defaultTrafficPeriods()));
    await RouteDB.setSettings({ coverageDepthTiers: [{ threshold: 0, label: 'a', color: '#000' }, { threshold: 9, label: 'b', color: '#fff' }] });
    check(`[${kind}] 분류와 무관한 설정 저장은 그대로 동작`, (await RouteDB.getSettings()).coverageDepthTiers[1].threshold === 9);
  }

  // ── 6 ──────────────────────────────────────────────────
  section('6. 설정 변경 후 재분류');
  {
    const p = freshPath();
    let db = new RouteDatabase(p);
    SUBSET.forEach(f => db.importRecords(parsed(f).records, parsed(f).meta));
    const total = db.listDateSummaries().length;
    check('[SQLite] 재분류 시험용 데이터가 여러 날짜(실패 주입이 중간 날짜에서 일어나도록 4일 이상)', total >= 4, `${total}일`);
    const hashes = db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join();
    const aggBefore = CSt.aggregate(db.listDateSummaries(), { groupBy: ['trafficPeriod'] });
    db.setSettings(SHIFTED);
    const stale = db.getClassificationStatus();
    check('[SQLite] 설정 저장 직후: 모든 날짜가 재분류 필요로 표시(저장만으로 요약을 바꾸지 않음)', stale.staleDates === total && stale.signature === SHIFTED_SIG, `${stale.staleDates}/${total}일`);
    const run1 = db.reclassifySummaries();
    const run2 = db.reclassifySummaries();
    await new Promise(r => setImmediate(r));
    const mid = db.getClassificationStatus();
    check('[SQLite] 중복 실행 방지: 두 번 불러도 같은 작업 · 진행 중 표시(running · done/total)',
      run1 === run2 && mid.running === true && mid.progress && mid.progress.total === total && mid.progress.done >= 1, mid.progress && `${mid.progress.done}/${mid.progress.total}`);
    const res = await run1;
    const after = db.getClassificationStatus();
    check('[SQLite] 재분류 완료: 날짜마다 한 번씩 · 남은 날짜 0 · 원본 기록 그대로',
      res.rebuilt === total && after.staleDates === 0 && !after.running
      && db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join() === hashes, `rebuilt ${res.rebuilt}`);
    const config = TC.classificationConfig(db.getSettings());
    const expectedOk = db.listDateSummaries().every(s => condPart(s) === condPart({ ...CSt.buildConditionSummary(db.getRecordsByDate(s.date), config) }));
    check('[SQLite] 재분류된 요약 = 원본 기록을 새 기준으로 직접 분류한 결과', expectedOk);
    const aggAfter = CSt.aggregate(db.listDateSummaries(), { groupBy: ['trafficPeriod'], signature: SHIFTED_SIG });
    const m = (agg, id) => (agg.rows.find(r => r.trafficPeriod === id) || { collectionSec: 0 }).collectionSec;
    const moved = m(aggBefore, 'evening_peak') - m(aggAfter, 'evening_peak');
    check('[SQLite] 재분류 후 통계 갱신: 17~18시 수집 시간이 퇴근 피크 → 오후 비피크로 이동, 전체 합은 같음',
      moved > 0 && m(aggAfter, 'afternoon_offpeak') - m(aggBefore, 'afternoon_offpeak') === moved && aggAfter.totals.collectionSec === aggBefore.totals.collectionSec && aggAfter.staleDates === 0,
      `이동 ${Math.round(moved / 60)}분 · 퇴근 피크 ${Math.round(m(aggBefore, 'evening_peak') / 60)}→${Math.round(m(aggAfter, 'evening_peak') / 60)}분`);

    // 실패 주입 — 세 번째 날짜에서 디스크 오류
    db.setSettings({ trafficPeriods: TC.defaultTrafficPeriods(), sunsetWindowMinutes: 30 });
    const orig = db._rebuildDateSummary;
    let calls = 0;
    db._rebuildDateSummary = function (d, c) { if (++calls === 3) throw new Error('디스크 오류(테스트 주입)'); return orig.call(this, d, c); };
    let err = null;
    try { await db.reclassifySummaries(); } catch (e) { err = e; }
    db._rebuildDateSummary = orig;
    const partial = db.getClassificationStatus();
    const parseable = db.db.all('SELECT summary_json FROM date_summaries').every(r => { try { return Array.isArray(JSON.parse(r.summary_json).conditionCells); } catch (_) { return false; } });
    check('[SQLite] 재분류 중 실패 → 오류 전달 · 처리한 2일만 새 기준 · 나머지 날짜 요약은 예전 그대로 온전 · 원본 기록 그대로',
      !!err && partial.staleDates === total - 2 && !partial.running && parseable
      && db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join() === hashes,
      `${err && err.message} · 남은 ${partial.staleDates}일`);
    const retry = await db.reclassifySummaries();
    check('[SQLite] 다시 실행하면 남은 날짜만 이어서 처리', retry.rebuilt === total - 2 && db.getClassificationStatus().staleDates === 0, `rebuilt ${retry.rebuilt}`);

    // 설정만 바꾸고 재분류 전에 앱 종료 → 다시 열면 이어서
    db.setSettings(SHIFTED);
    check('[SQLite] (종료 직전) 재분류 필요 날짜 있음', db.getClassificationStatus().staleDates === total);
    db.close();
    db = new RouteDatabase(p);
    const reopened = db.getClassificationStatus();
    check('[SQLite] 앱을 다시 열면 남은 재분류를 이어서 끝낸다 · 데이터 온전',
      reopened.staleDates === 0 && reopened.signature === SHIFTED_SIG && db.db.all('SELECT record_hash FROM driving_records ORDER BY record_hash').map(r => r.record_hash).join() === hashes);
    db.close();
  }
  {
    const fake = createFakeIndexedDB();
    let { RouteDB, ctx } = await idbRouteDB(fake);
    for (const f of SUBSET.slice(0, 4)) await RouteDB.importRecords(parsed(f).records, parsed(f).meta);
    const total = (await RouteDB.listDateSummaries()).length;
    await RouteDB.setSettings(SHIFTED);
    check('[IndexedDB] 설정 저장 직후 모든 날짜 재분류 필요', (await RouteDB.getClassificationStatus()).staleDates === total, `${total}일`);
    const r1 = RouteDB.backend.reclassifySummaries();
    const r2 = RouteDB.backend.reclassifySummaries();
    check('[IndexedDB] 중복 실행 방지(같은 작업)', r1 === r2);
    const res = await r1;
    check('[IndexedDB] 재분류 완료 · 남은 날짜 0', res.rebuilt === total && (await RouteDB.getClassificationStatus()).staleDates === 0);

    await RouteDB.setSettings({ trafficPeriods: TC.defaultTrafficPeriods(), sunsetWindowMinutes: 30 });
    const origBuild = ctx.buildDaySummaryFromPoints;
    let n = 0;
    ctx.buildDaySummaryFromPoints = (rows, c) => { if (++n === 2) throw new Error('쓰기 실패(테스트 주입)'); return origBuild(rows, c); };
    let err = null;
    try { await RouteDB.reclassifySummaries(); } catch (e) { err = e; }
    ctx.buildDaySummaryFromPoints = origBuild;
    const st = await RouteDB.getClassificationStatus();
    const sums = await RouteDB.listDateSummaries();
    check('[IndexedDB] 실패 시 처리 못 한 날짜는 예전 요약 그대로(개수 유지) · 기록 그대로',
      !!err && st.staleDates === total - 1 && sums.length === total && sums.every(s => Array.isArray(s.conditionCells)), `남은 ${st.staleDates}일`);
    ({ RouteDB } = await idbRouteDB(fake)); // 탭을 닫았다 다시 연다
    check('[IndexedDB] 다시 열면 남은 날짜를 이어서 재분류', (await RouteDB.getClassificationStatus()).staleDates === 0);
  }

  // ── 7 ──────────────────────────────────────────────────
  section('7. SQLite ↔ IndexedDB 결과 일치 (실제 주행기록 전체)');
  {
    const { RouteDB: sq, api } = await sqliteRouteDB(new RouteDatabase(freshPath()));
    const { RouteDB: ib } = await idbRouteDB(createFakeIndexedDB());
    for (const f of FILES) {
      await sq.importRecords(parsed(f).records, parsed(f).meta);
      await ib.importRecords(parsed(f).records, parsed(f).meta);
    }
    const compare = async label => {
      const [a, b] = [summaryMap(await sq.listDateSummaries()), summaryMap(await ib.listDateSummaries())];
      const dates = [...a.keys()];
      const diff = dates.filter(d => !b.has(d) || condPart(a.get(d)) !== condPart(b.get(d)));
      const gb = ['zone', 'vehicle', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather'];
      const aggEq = JSON.stringify(CSt.aggregate([...a.values()], { groupBy: gb })) === JSON.stringify(CSt.aggregate([...b.values()], { groupBy: gb }));
      const day = dates[Math.floor(dates.length / 2)];
      const pick = rs => JSON.stringify(rs.map(r => [r.time, r.vehicle, r.trafficPeriod, r.lightCondition, r.weekdayType]).sort());
      const recEq = pick(await sq.getRecordsByDate(day)) === pick(await ib.getRecordsByDate(day));
      const cells = [...a.values()].reduce((acc, s) => acc + s.conditionCells.length, 0);
      check(`${label}: 날짜별 조건 칸·서명 · 전체 복합 집계 · 기록별 분류가 두 저장소에서 같다`,
        dates.length === b.size && diff.length === 0 && aggEq && recEq, `${dates.length}일 · 조건 칸 ${cells}개${diff.length ? ' · 다른 날짜 ' + diff.join(',') : ''}`);
    };
    await compare('기본 설정');
    await sq.setSettings(SHIFTED); await ib.setSettings(SHIFTED);
    await sq.reclassifySummaries(); await ib.reclassifySummaries();
    await compare('설정 변경 + 재분류 후');
    check('  (IPC 경로로 재분류 호출됨)', api.calls.reclassifySummaries === 1);
  }

  // ── 8 ──────────────────────────────────────────────────
  section('8. 서버 동기화 후 분류 유지 (실제 server.js)');
  {
    const PORT = 8096;
    const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-tc-sync-')), 'shared.json');
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ROUTE_VIEWER_DATA_FILE: dataFile }, stdio: 'pipe',
    });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    const base = `http://127.0.0.1:${PORT}`;
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(base + '/api/route-data'); up = r.status === 404 || r.ok; } catch (_) { await new Promise(r => setTimeout(r, 150)); } }
      check('server.js 가 뜬다(임시 공유 파일)', up);
      // main.js sync:run 과 같은 순서: 받아서 restoreBackupPayload(merge) → 내 DB 전체를 올림
      const syncDesktop = async db => {
        const g = await fetch(base + '/api/route-data');
        if (g.ok) db.restoreBackupPayload(await g.json(), 'merge');
        const p = await fetch(base + '/api/route-data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db.buildBackupPayload()) });
        return p.ok;
      };
      const devA = new RouteDatabase(freshPath());
      SUBSET.slice(0, 3).forEach(f => devA.importRecords(parsed(f).records, parsed(f).meta));
      devA.setSettings(SHIFTED); await devA.reclassifySummaries();
      check('기기 A(바꾼 분류 설정) 동기화', await syncDesktop(devA));
      const devB = new RouteDatabase(freshPath());
      check('기기 B(새 DB) 동기화', await syncDesktop(devB));
      const a = summaryMap(devA.listDateSummaries()), b = summaryMap(devB.listDateSummaries());
      check('기기 B: 기록·분류 설정·날짜별 조건 칸이 A와 같다(서버를 거쳐도 분류 유지)',
        devB.getStats().points === devA.getStats().points && TC.classificationSignature(TC.classificationConfig(devB.getSettings())) === SHIFTED_SIG
        && a.size === b.size && [...a.keys()].every(d => condPart(a.get(d)) === condPart(b.get(d))) && devB.getClassificationStatus().staleDates === 0,
        `${devB.getStats().points}건 · ${b.size}일`);
      const { RouteDB: devC } = await idbRouteDB(createFakeIndexedDB());
      const remote = await (await fetch(base + '/api/route-data')).json();
      await devC.restoreBackupPayload(remote, 'merge');
      const c = summaryMap(await devC.listDateSummaries());
      check('브라우저(IndexedDB)가 같은 서버 데이터를 받아도 조건 칸이 같다',
        c.size === a.size && [...a.keys()].every(d => condPart(a.get(d)) === condPart(c.get(d))));
      const pointsA = devA.getStats().points;
      await syncDesktop(devA);
      check('A가 다시 동기화해도 기록이 늘지 않고 분류 그대로', devA.getStats().points === pointsA && devA.getClassificationStatus().staleDates === 0
        && [...a.keys()].every(d => condPart(a.get(d)) === condPart(summaryMap(devA.listDateSummaries()).get(d))));
      [devA, devB].forEach(d => d.close());
    } finally {
      server.kill();
    }
  }

  // ── 9 ──────────────────────────────────────────────────
  section('9. 화면 — 설정 탭 · 통계 · 달력 (실제 settings.js / statistics.js / calendar.js)');
  {
    const db = new RouteDatabase(freshPath());
    const api = createDesktopApi(db);
    const doc = fakeDocument();
    const toasts = [], errors = [];
    const intervals = [];
    const ctx = baseContext({
      document: doc, routeAPI: api,
      setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); intervals.push(t); return t; },
      clearInterval,
      showToast: m => toasts.push(m), showError: m => errors.push(m), clearError() {},
      ACTIVE_ZONE_NAMES: [], ZONE_COLORS: {}, styleZoneButtons() {}, refreshZoneCache: async () => [],
      renderConsole() {}, switchTab() {}, openModal() {}, closeModal() {},
    });
    ['src/js/quality.js', 'src/js/collection-stats.js', 'src/js/time-conditions.js', 'src/js/issue-filter.js', 'src/js/condition-stats.js', 'src/js/recommendation.js', 'src/js/core.js',
      'src/js/coverage-grid.js', 'src/js/storage.js', 'src/js/calendar.js', 'src/js/statistics.js', 'src/js/settings.js'].forEach(f => load(ctx, f));
    // 설정 캐시는 accum.js 의 refreshSettingsCache — 그 함수만 실제 소스에서 잘라 쓴다(누적 지도 전체는 Leaflet이 필요)
    const acc = readSource('src/js/accum.js').match(/const DEFAULT_DEPTH_TIERS_JS=[\s\S]*?async function refreshSettingsCache\(\)\{[\s\S]*?\r?\n\}\r?\n/);
    vm.runInContext(acc[0], ctx, { filename: 'accum.js#refreshSettingsCache' });
    const run = code => vm.runInContext(code, ctx);
    await run('RouteDB.init()');
    for (const f of SUBSET.slice(0, 4)) await run(`RouteDB.importRecords(${JSON.stringify(parsed(f).records)},${JSON.stringify(parsed(f).meta)})`);
    await run('refreshSettingsCache()');
    await run('refreshVehicleCache()');

    const minutesOf = (html, id) => { const m = new RegExp(`data-value="${id}">[\\s\\S]*?<b>([\\d,]+)분</b> · ([\\d,]+)개`).exec(html); return m ? { min: Number(m[1].replace(/,/g, '')), n: Number(m[2].replace(/,/g, '')) } : null; };
    const expectMinutes = (config, id) => {
      const rows = CSt.aggregate(db.listDateSummaries(), { groupBy: ['trafficPeriod'], signature: TC.classificationSignature(config) }).rows;
      const r = rows.find(x => x.trafficPeriod === id);
      return r ? r.collectionMinutes : null;
    };

    await run('renderStatsView()');
    const statsBefore = doc.getElementById('dist-grid').innerHTML;
    const ev0 = minutesOf(statsBefore, 'evening_peak');
    check('통계: 교통 시간대·조도 조건·평일/주말 카드가 따로 있고, 수집 분이 날짜 요약 집계와 같다',
      /교통 시간대 · 수집 시간/.test(statsBefore) && /조도 조건 · 수집 시간/.test(statsBefore) && /평일 · 주말/.test(statsBefore)
      && !!ev0 && ev0.min === expectMinutes(TC.classificationConfig({}), 'evening_peak') && /구역별 교통 시간대/.test(statsBefore) && /파일 원본 시간대/.test(statsBefore),
      ev0 && `퇴근 피크 ${ev0.min}분 · ${ev0.n}개`);

    // 이슈 현황 표는 "전체 데이터"를 보고 있을 때만 — 이슈 없음/이슈만 화면에서는 지금 보는 숫자와
    // 어긋나 보여서 아예 뺀다(계산도 하지 않는다)
    check('통계: 이슈 현황 표는 데이터 상태가 "전체"일 때만 보인다',
      /이슈 현황/.test(doc.getElementById('stats-issue-overview').innerHTML));
    for (const f of ['clean', 'issue_all']) {
      run(`setIssueFilter('${f}')`);
      await run('renderStatsView()');
      check(`   '${f}' 을 고르면 이슈 현황 표를 숨긴다`,
        doc.getElementById('stats-issue-overview').innerHTML === '',
        doc.getElementById('stats-issue-overview').innerHTML.slice(0, 40) || '(비어 있음)');
    }
    run("setIssueFilter('all')");
    await run('renderStatsView()');
    check('   다시 "전체"로 돌아오면 표가 돌아온다',
      /이슈 현황/.test(doc.getElementById('stats-issue-overview').innerHTML));

    await run('renderSettingsView()');
    const rowsHtml = doc.getElementById('settings-traffic-periods').innerHTML;
    check('설정 탭: 8개 교통 시간대의 시작·종료 시각 입력(HH:mm) 표시 · 상태 "현재 기준"',
      (rowsHtml.match(/traffic-period-row/g) || []).length === 8 && /id="tp-start-morning_peak" value="07:00"/.test(rowsHtml) && /id="tp-end-night" value="24:00"/.test(rowsHtml)
      && /모두 현재 기준/.test(doc.getElementById('classification-status').textContent), doc.getElementById('classification-status').textContent);

    const setCalls = () => api.calls.setSettings || 0;
    const before = setCalls();
    run("onTrafficPeriodInput('morning_offpeak','start','09:30')");
    const e1 = doc.getElementById('traffic-period-errors');
    const saved1 = await run('saveTrafficPeriodSettings()');
    check('겹치는 설정: 이유 표시 · 저장 버튼 비활성 · 저장 안 함',
      saved1 === false && e1.style.display === 'block' && /09:30~10:00에서 겹쳐요/.test(e1.innerHTML) && doc.getElementById('traffic-period-save-btn').disabled === true && setCalls() === before,
      e1.innerHTML.replace(/<[^>]+>/g, ' ').trim());
    run("onTrafficPeriodInput('morning_offpeak','start','10:00'); onTrafficPeriodInput('morning_offpeak','end','11:00')");
    const saved2 = await run('saveTrafficPeriodSettings()');
    check('공백 있는 설정: 이유 표시 · 저장 안 함', saved2 === false && /11:00~11:30.*공백/.test(doc.getElementById('traffic-period-errors').innerHTML) && setCalls() === before);
    run("onTrafficPeriodInput('morning_offpeak','end','11:30')");
    check('고치면 오류가 사라지고 저장 버튼 활성', doc.getElementById('traffic-period-errors').style.display === 'none' && doc.getElementById('traffic-period-save-btn').disabled === false);

    run("onTrafficPeriodInput('afternoon_offpeak','end','18:00'); onTrafficPeriodInput('evening_peak','start','18:00')");
    const reclassBefore = api.calls.reclassifySummaries || 0;
    const saved3 = await run('saveTrafficPeriodSettings()');
    const s3 = db.getSettings();
    const shiftedCfg = TC.classificationConfig(s3);
    check('정상 설정 저장 → DB 반영 · 재분류 1회 실행 · 상태 "현재 기준"',
      saved3 === true && s3.trafficPeriods.find(p => p.id === 'evening_peak').start === '18:00' && (api.calls.reclassifySummaries || 0) === reclassBefore + 1
      && db.getClassificationStatus().staleDates === 0 && /모두 현재 기준/.test(doc.getElementById('classification-status').textContent)
      && toasts.some(t => /다시 분류했어요/.test(t)), toasts[toasts.length - 1]);
    await run('renderStatsView()');
    const ev1 = minutesOf(doc.getElementById('dist-grid').innerHTML, 'evening_peak');
    const af0 = minutesOf(statsBefore, 'afternoon_offpeak'), af1 = minutesOf(doc.getElementById('dist-grid').innerHTML, 'afternoon_offpeak');
    check('재분류 후 통계 갱신: 퇴근 피크 수집 분이 줄고 오후 비피크가 늘어난다(새 기준 집계와 일치)',
      (!ev1 || ev1.min < ev0.min) && af1.min > af0.min && af1.min === expectMinutes(shiftedCfg, 'afternoon_offpeak'),
      `퇴근 피크 ${ev0.min}→${ev1 ? ev1.min : 0}분 · 오후 비피크 ${af0.min}→${af1.min}분`);

    const restored = await run('restoreDefaultTrafficPeriods()');
    await run('renderStatsView()');
    check('기본값 복원 → 저장·재분류 · 통계가 처음 값으로 돌아온다',
      restored === true && JSON.stringify(db.getSettings().trafficPeriods) === JSON.stringify(TC.defaultTrafficPeriods())
      && JSON.stringify(minutesOf(doc.getElementById('dist-grid').innerHTML, 'evening_peak')) === JSON.stringify(ev0));

    const calls0 = api.calls.reclassifySummaries || 0;
    const [ra, rb] = await run('Promise.all([runReclassification(), runReclassification()])');
    check('재분류 버튼을 연달아 눌러도 한 번만 실행(두 번째는 바로 거절)', ra === true && rb === false && (api.calls.reclassifySummaries || 0) === calls0 + 1);

    // 가짜 DOM은 innerHTML 의 value 속성을 입력칸 값으로 옮기지 않으므로, 브라우저에 보이는 값을 직접 넣는다
    run("document.getElementById('light-sunrise-window').value='30'; document.getElementById('light-sunset-window').value='200'");
    const w1 = await run('saveLightWindowSettings()');
    const w1Error = doc.getElementById('light-window-errors').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const w1Saved = db.getSettings().sunsetWindowMinutes;
    run("document.getElementById('light-sunset-window').value='45'");
    const w2 = await run('saveLightWindowSettings()');
    check('일몰 전후 범위: 200분은 거부(이유 표시 · 저장 안 함) · 45분은 저장 후 재분류 · 성공하면 오류 표시가 사라짐',
      w1 === false && /0~180/.test(w1Error) && w1Saved === 30 && w2 === true && db.getSettings().sunsetWindowMinutes === 45
      && db.getClassificationStatus().staleDates === 0 && doc.getElementById('light-window-errors').style.display === 'none',
      `거부 이유 "${w1Error}"`);

    await db.setSettings({ trafficPeriods: shiftedPeriods() }); // 재분류하지 않은 상태
    await run('refreshSettingsCache()');
    await run('renderStatsView()');
    check('재분류 전이면 통계에 "아직 다시 분류하지 않은 날짜" 경고', /아직 다시 분류하지 않은 날짜가 \d+일/.test(doc.getElementById('dist-grid').innerHTML));
    await run('renderSettingsView()');
    check('설정 탭 상태: 남은 날짜 수 + "지금 재분류" 버튼', /아직 분류하지 않은 날짜 \d+일/.test(doc.getElementById('classification-status').innerHTML) && /지금 재분류/.test(doc.getElementById('classification-status').innerHTML));
    await run('runReclassification()');

    await run('refreshDateIndex()');
    const day = db.listDateSummaries().find(s => s.conditionCells.some(c => c.trafficPeriod === 'evening_peak')) || db.listDateSummaries()[0];
    await run(`openDayDetail(${JSON.stringify(day.date)})`);
    const ds = doc.getElementById('day-summary').innerHTML;
    const dayAgg = CSt.aggregate([day], { groupBy: ['trafficPeriod'] }).rows;
    const allRows = dayAgg.every(r => { const m = minutesOf(ds, r.trafficPeriod); return m && m.min === r.collectionMinutes && m.n === r.recordCount; });
    check('달력 일자 요약: 교통 시간대와 조도 조건을 따로(분 · 기록 수), 값이 날짜 요약과 같다',
      /교통 시간대/.test(ds) && /조도 조건/.test(ds) && allRows && dayAgg.length > 0,
      dayAgg.map(r => `${TC.TRAFFIC_PERIOD_LABELS[r.trafficPeriod]} ${r.collectionMinutes}분`).join(' · '));
    const lightMinutes = CSt.aggregate([day], { groupBy: ['lightCondition'] }).rows.reduce((a, r) => a + r.collectionSec, 0);
    check('  두 축의 수집 시간 합이 각각 그날 수집 시간과 같다(긴 GPS 공백 제외 규칙 재사용)',
      dayAgg.reduce((a, r) => a + r.collectionSec, 0) === day.collectionSec && lightMinutes === day.collectionSec, `${Math.round(day.collectionSec / 60)}분`);
    check("  조건 조합은 축별 배지로 ('교통' · '조도' · '요일' · '날씨'가 각각 따로)",
      /<span class="cond-axis">교통<\/span>/.test(ds) && /<span class="cond-axis">조도<\/span>/.test(ds) && /<span class="cond-axis">요일<\/span>/.test(ds) && /<span class="cond-axis">날씨<\/span>/.test(ds));
    check('화면 오류 없음', errors.length === 0, errors.join(' | '));
    intervals.forEach(t => clearInterval(t));
    db.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failures.length) failures.forEach(f => console.log('   - ' + f));
  console.log('─'.repeat(60));
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
