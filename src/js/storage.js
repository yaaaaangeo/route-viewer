// ══════════════════════════════════════════════════════════
//  storage — 화면이 쓰는 단 하나의 저장소 인터페이스 (RouteDB)
//
//  백엔드는 두 가지고, 화면 코드는 어느 쪽인지 신경 쓰지 않는다.
//
//    1) 데스크톱 앱(Electron)  → SQLite  (window.routeAPI 를 통해 메인 프로세스)
//    2) 브라우저로 열었을 때    → IndexedDB
//
//  ⚠ localStorage 에 전체 GPS 데이터를 JSON 한 덩어리로 넣던 예전 방식은
//    더 이상 주 저장소가 아니다. 용량 한계(보통 5MB)에 금방 걸리고,
//    수십만 포인트를 감당할 수 없기 때문이다.
//    localStorage 는 이제 "예전 버전 데이터 1회 이관"에만 쓴다.
//
//  공통 규칙
//    · import 는 언제나 추가(APPEND/MERGE). 절대 기존 데이터를 지우지 않는다.
//    · 중복 판정 키 = date | time | vehicle | lat(6자리) | lng(6자리)
// ══════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const DEDUPE_KEY_FIELDS = ['date', 'time', 'vehicle', 'lat', 'lng'];
  // 이 필드가 unique key 밖에서 다르면 "완전 동일"이 아니라 "충돌"로 집계한다
  // (electron/database.js 의 COMPARABLE_FIELDS 와 반드시 같아야 한다 — 백엔드가
  //  달라도(SQLite/IndexedDB) 같은 파일을 넣으면 같은 리포트가 나와야 하기 때문)
  const COMPARABLE_FIELDS = ['place', 'road', 'weather', 'timeOfDay', 'traffic', 'speed'];
  const DEFAULT_DEPTH_TIERS = [
    { threshold: 0, label: '미수집', color: '#ff6b6b' },
    { threshold: 1, label: '부족', color: '#f5a623' },
    { threshold: 2, label: '보통', color: '#f5d90a' },
    { threshold: 5, label: '충분', color: '#5fd88a' },
  ];

  function recordKey(rec) {
    return [
      rec.date,
      rec.time,
      rec.vehicle,
      Number(rec.lat).toFixed(6),
      Number(rec.lng).toFixed(6),
    ].join('|');
  }

  function diffComparableFields(a, b) {
    const diffs = [];
    for (const f of COMPARABLE_FIELDS) {
      const av = a && a[f] != null ? String(a[f]) : '';
      const bv = b && b[f] != null ? String(b[f]) : '';
      if (av !== bv) diffs.push({ field: f, from: av, to: bv });
    }
    return diffs;
  }

  function fileDistanceKm(list) {
    const sorted = [...list].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    let distM = 0;
    for (let i = 1; i < sorted.length; i++) {
      distM += haversine(sorted[i - 1].lat, sorted[i - 1].lng, sorted[i].lat, sorted[i].lng);
    }
    return Math.round(distM / 10) / 100;
  }

  function mostFrequent(values) {
    const counts = {};
    for (const v of values) counts[v] = (counts[v] || 0) + 1;
    let best = '', bestN = 0;
    for (const [v, n] of Object.entries(counts)) if (n > bestN) { best = v; bestN = n; }
    return best;
  }

  function normalizeRecord(raw) {
    const s = v => (v === undefined || v === null ? '' : String(v).trim());
    const lat = Number(raw.lat !== undefined ? raw.lat : raw.latitude);
    const lng = Number(raw.lng !== undefined ? raw.lng : raw.longitude);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    const date = s(raw.date) || '날짜미상';
    const time = s(raw.time);
    return {
      date, time,
      timestamp: `${date}T${time || '00:00:00'}`,
      vehicle: s(raw.vehicle),
      zone: s(raw.zone),
      place: s(raw.place),
      road: s(raw.road),
      weather: s(raw.weather),
      timeOfDay: s(raw.timeOfDay !== undefined ? raw.timeOfDay : raw.time_of_day),
      traffic: s(raw.traffic),
      speed: s(raw.speed),
      lat, lng,
    };
  }

  // ══════════════════════════════════════════════════════
  //  백엔드 1 — 데스크톱 앱(SQLite). 그냥 routeAPI 로 넘긴다.
  // ══════════════════════════════════════════════════════
  function makeDesktopBackend(api) {
    return {
      kind: 'sqlite',
      label: 'SQLite',
      async init() { await api.stats(); },
      stats: () => api.stats(),
      importRecords: (recs, meta) => api.importRecords(recs, meta),
      listDateSummaries: () => api.listDateSummaries(),
      getRecordsByDate: d => api.getRecordsByDate(d),
      getOverview: f => api.getOverview(f || {}),
      getDensityCells: (f, c) => api.getDensityCells(f || {}, c),
      getStatsBundle: (f, o) => api.getStatsBundle(f || {}, o || {}),
      listSubZones: o => api.listSubZones(o || {}),
      getSubZone: id => api.getSubZone(id),
      saveSubZone: z => api.saveSubZone(z),
      setSubZoneActive: (id, active) => api.setSubZoneActive(id, active),
      deleteSubZone: id => api.deleteSubZone(id),
      getSubZoneStats: (list, o) => api.getSubZoneStats(list || [], o || {}),
      getAccumBundle: (f, c) => api.getAccumBundle(f || {}, c),
      getBounds: f => api.getBounds(f || {}),
      getVisitedCellKeys: b => api.getVisitedCellKeys(b),
      getDistribution: (col, f) => api.getDistribution(col, f || {}),
      getTimeBucketDistribution: f => api.getTimeBucketDistribution(f || {}),
      deleteDate: d => api.deleteDate(d),
      deleteAll: () => api.deleteAll(),
      getZonePolygons: () => api.getZonePolygons(),
      saveZonePolygons: p => api.saveZonePolygons(p),
      listImports: (n, o) => api.listImports(n, o || {}),
      findImportByFileHash: h => api.findImportByFileHash(h),
      getImportConflicts: id => api.getImportConflicts(id),
      listVehicles: () => api.listVehicles(),
      saveVehicle: v => api.saveVehicle(v),
      setVehicleActive: (name, active) => api.setVehicleActive(name, active),
      listZones: () => api.listZones(),
      saveZone: z => api.saveZone(z),
      setZoneActive: (name, active) => api.setZoneActive(name, active),
      getZoneManualCells: name => api.getZoneManualCells(name),
      saveZoneManualCells: (name, data) => api.saveZoneManualCells(name, data),
      getSettings: () => api.getSettings(),
      setSettings: partial => api.setSettings(partial),
      getClassificationStatus: () => api.getClassificationStatus(),
      reclassifySummaries: () => api.reclassifySummaries(),
      saveCoverageSnapshot: (zone, snap) => api.saveCoverageSnapshot(zone, snap),
      listCoverageSnapshots: () => api.listCoverageSnapshots(),
      listRecommendationStates: () => api.listRecommendationStates(),
      setRecommendationState: (id, state) => api.setRecommendationState(id, state),
      getImport: id => api.getImport(id),
      updateImportIssue: (id, patch) => api.updateImportIssue(id, patch),
      listDateImports: date => api.listDateImports(date),
      getIssueOverview: filter => api.getIssueOverview(filter || {}),
      restoreImports: imports => api.restoreImports(imports),
      getCellVisitCounts: (box, cellSizeM) => api.getCellVisitCounts(box, cellSizeM),
      getBackupHistory: () => api.getBackupHistory(),
      setBackupHistory: h => api.setBackupHistory(h),
      buildBackupPayload: () => api.buildBackupPayload(),
      restoreBackupPayload: (p, m) => api.restoreBackupPayload(p, m),
    };
  }

  // ══════════════════════════════════════════════════════
  //  백엔드 2 — 브라우저(IndexedDB)
  //  집계는 커서를 돌면서 그때그때 더한다. 전체 레코드를 배열로
  //  들고 있지 않으므로 데이터가 커져도 메모리가 터지지 않는다.
  // ══════════════════════════════════════════════════════
  const IDB_NAME = 'route-viewer';
  // v2: vehicles/zones 설정 저장소 추가 · v3: recordSources(GPS 레코드 ↔ Import 파일 출처) 추가
  // v4: subZones(세부 수집 구역) 추가
  const IDB_VERSION = 4;

  function makeIdbBackend() {
    let dbp = null;   // open() 진행중 promise
    let rawDb = null; // 열린 IDBDatabase — 트랜잭션은 반드시 이걸로 "동기적으로" 만든다

    // IndexedDB 트랜잭션은 이벤트 루프가 한 바퀴 돌면 비활성화된다.
    // 그래서 트랜잭션을 만든 뒤에는 await 없이 요청을 전부 걸어놓고,
    // 그 다음에 한 번만 await 한다. (아래 모든 함수가 이 규칙을 지킨다)
    function ready() {
      if (rawDb) return Promise.resolve(rawDb);
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('records')) {
            const st = db.createObjectStore('records', { keyPath: 'key' });
            st.createIndex('date', 'date');
            st.createIndex('zone', 'zone');
            st.createIndex('vehicle', 'vehicle');
          }
          if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'date' });
          if (!db.objectStoreNames.contains('imports')) db.createObjectStore('imports', { keyPath: 'id', autoIncrement: true });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('vehicles')) db.createObjectStore('vehicles', { keyPath: 'name' });
          if (!db.objectStoreNames.contains('zones')) db.createObjectStore('zones', { keyPath: 'name' });
          // 레코드 ↔ Import 출처. id = '<레코드 키><importId>' 라서 같은 쌍은 한 번만 저장된다
          // (SQLite record_sources 의 PRIMARY KEY 와 같은 뜻). 예전 DB 를 열면 이 저장소만 새로 생긴다.
          // 세부 수집 구역(2단계) — 상위 구역 안의 생활권·장소 유형
          if (!db.objectStoreNames.contains('subZones')) db.createObjectStore('subZones', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('recordSources')) {
            const st = db.createObjectStore('recordSources', { keyPath: 'id' });
            st.createIndex('key', 'key');
            st.createIndex('importId', 'importId');
          }
        };
        req.onsuccess = () => { rawDb = req.result; resolve(rawDb); };
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }

    function done(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }

    function reqp(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    // ── 이슈 출처 색인 ────────────────────────────────
    // 레코드 키 → 출처 마스크(issue-filter.js). 이슈가 걸린 레코드만 담는다 —
    // 마스크 0(출처 기록 없음)과 1(정상 파일에서만 옴)은 모든 필터에서 똑같이 취급되므로 담을 필요가 없다.
    // Import·이슈 수정·삭제·복원 때만 비운다(탭 이동으로는 다시 만들지 않는다).
    let issueIndexCache = null;
    function invalidateIssueIndex() { issueIndexCache = null; }

    async function issueIndex() {
      if (issueIndexCache) return issueIndexCache;
      const db = await ready();
      const t = db.transaction(['imports', 'recordSources'], 'readonly');
      const impReq = reqp(t.objectStore('imports').getAll());
      const srcReq = reqp(t.objectStore('recordSources').getAll());
      const [imports, sources] = await Promise.all([impReq, srcReq]);
      const byId = new Map(imports.map(i => [i.id, i]));
      const all = new Map();
      const sourcesByKey = new Map();
      sources.forEach(s => {
        const bit = global.IssueFilter.maskBitOf(byId.get(s.importId));
        all.set(s.key, (all.get(s.key) || 0) | bit);
        if (!sourcesByKey.has(s.key)) sourcesByKey.set(s.key, []);
        sourcesByKey.get(s.key).push(s.importId);
      });
      // 이슈 없는 출처(NON_ISSUE=1)도 그대로 둔다 — 0("출처 기록이 아예 없는 예전 데이터")과
      // 1("이슈 없는 파일에서 왔다")은 뜻이 다르고, 날짜 요약의 조건 칸에 그대로 저장되기 때문에
      // SQLite 의 ISSUE_MASK_SQL 과 값이 같아야 한다.
      issueIndexCache = { byId, byKey: all, sourcesByKey };
      return issueIndexCache;
    }

    const maskOf = (index, key) => (index && index.byKey.get(key)) || 0;

    // 시각 → 4시간 묶음('08-12시'). 시각을 못 읽으면 null(어느 묶음에도 넣지 않는다)
    const TIME_BUCKET_ORDER = ['00-04시', '04-08시', '08-12시', '12-16시', '16-20시', '20-24시'];
    function timeBucketOf(time) {
      const h = parseInt(String(time || '').split(':')[0], 10);
      if (isNaN(h) || h < 0 || h > 23) return null;
      const start = Math.floor(h / 4) * 4;
      const p = n => String(n).padStart(2, '0');
      return `${p(start)}-${p(start + 4)}시`;
    }
    const orderedBuckets = counts => TIME_BUCKET_ORDER.filter(k => counts[k]).map(k => [k, counts[k]]);

    // records 를 커서로 훑으면서 콜백에 하나씩 넘긴다(배열로 모으지 않음)
    async function scan(filter, onRecord) {
      const db = await ready();
      const needsIssue = !!(filter && filter.issueFilter && filter.issueFilter !== 'all');
      const index = needsIssue ? await issueIndex() : null;
      return new Promise((resolve, reject) => {
        const t = db.transaction(['records'], 'readonly');
        const store = t.objectStore('records');
        let source = store;
        let range = null;
        if (filter && filter.date) { source = store.index('date'); range = IDBKeyRange.only(filter.date); }
        else if (filter && filter.zone && filter.zone !== 'all') { source = store.index('zone'); range = IDBKeyRange.only(filter.zone); }
        const req = source.openCursor(range);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { resolve(); return; }
          const v = cur.value;
          if (matches(v, filter, index)) onRecord(v);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }

    // database.js _filterSql 과 같은 조건 — 예전엔 fromDate/toDate 를 빠뜨려서 브라우저 모드에서는
    // 누적 지도 날짜 필터가 통계/밀도/Coverage 어디에도 적용되지 않았다.
    function matches(v, filter, issueIdx) {
      if (!filter) return true;
      // 이슈 필터 — SQLite 의 EXISTS 절과 같은 규칙(issue-filter.js)
      if (filter.issueFilter && filter.issueFilter !== 'all'
        && !global.IssueFilter.maskMatches(maskOf(issueIdx, v.key), filter.issueFilter)) return false;
      if (filter.date && v.date !== filter.date) return false;
      // 날짜 범위는 'YYYY-MM-DD' 날짜에만 — '날짜미상'이 "시작일만" 필터에 끼지 않게(database.js DATE_ONLY_SQL)
      if ((filter.fromDate || filter.toDate) && !/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) return false;
      if (filter.fromDate && !(v.date >= filter.fromDate)) return false;
      if (filter.toDate && !(v.date <= filter.toDate)) return false;
      if (filter.zone && filter.zone !== 'all' && v.zone !== filter.zone) return false;
      if (filter.vehicleLike && String(v.vehicle || '').indexOf(filter.vehicleLike) < 0) return false;
      return true;
    }

    async function metaGet(key, fallback) {
      const db = await ready();
      const t = db.transaction(['meta'], 'readonly');
      const row = await reqp(t.objectStore('meta').get(key));
      return row ? row.value : fallback;
    }

    async function metaSet(key, value) {
      const db = await ready();
      const t = db.transaction(['meta'], 'readwrite');
      t.objectStore('meta').put({ key, value });
      await done(t);
    }

    // 날짜 요약 한 건을 put 한 번으로 통째로 바꾼다 — 중간에 실패해도 그 날짜는 예전 요약이거나
    // 새 요약이거나 둘 중 하나다(원본 records 는 건드리지 않는다). database.js _rebuildDateSummary 와 같은 규칙.
    async function rebuildDateSummary(date, classification) {
      const config = classification || await classificationConfig();
      const rows = [];
      await scan({ date }, r => rows.push(r));
      // 읽기(이슈 마스크·출처)는 요약을 쓰는 트랜잭션을 열기 "전에" 모두 끝낸다 —
      // IndexedDB 트랜잭션은 그 사이에 await 하면 비활성화돼서 put 이 영영 끝나지 않는다.
      let payload = null;
      if (rows.length) {
        rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        // 조건 칸에 이슈 마스크를 넣는다(SQLite 의 ISSUE_MASK_SQL 과 같은 값)
        const index = await issueIndex();
        const withIssue = rows.map(r => ({ ...r, issueMask: maskOf(index, r.key) }));
        const sources = new Map();
        rows.forEach(r => (index.sourcesByKey.get(r.key) || []).forEach(importId => {
          sources.set(importId, (sources.get(importId) || 0) + 1);
        }));
        payload = {
          date, count: rows.length, ...global.buildDaySummaryFromPoints(withIssue, config),
          importSources: [...sources.entries()].sort((a, b) => a[0] - b[0]).map(([importId, recordCount]) => ({ importId, recordCount })),
        };
      }
      const db = await ready();
      const t = db.transaction(['summaries'], 'readwrite');
      if (payload) t.objectStore('summaries').put(payload);
      else t.objectStore('summaries').delete(date);
      await done(t);
    }

    async function allSources() {
      const db = await ready();
      const t = db.transaction(['recordSources'], 'readonly');
      return reqp(t.objectStore('recordSources').getAll());
    }

    // 그 레코드들이 어느 Import 에서 왔는지(달력 배지·일자 요약이 쓰는 importSources 계산용)
    async function sourcesForKeys(keys) {
      const all = await allSources();
      const want = new Set(keys);
      return all.filter(s => want.has(s.key));
    }

    async function keysForImport(importId) {
      return (await allSources()).filter(s => s.importId === importId).map(s => s.key);
    }

    async function sourceCountsByImport() {
      const counts = new Map();
      // 색인(issueIndex)이 이미 "레코드 → 출처 Import" 를 들고 있다 — 저장소를 다시 읽지 않는다
      const index = await issueIndex();
      index.sourcesByKey.forEach(ids => ids.forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
      return counts;
    }

    // Import 한 행 → 화면·백업이 쓰는 형태(electron/database.js normalizeImportRow 와 같은 모양)
    function normalizeImportRecord(row, relatedRecords) {
      return {
        ...row,
        hasIssue: !!row.hasIssue,
        issueNote: row.issueNote || '',
        issueStatus: row.hasIssue ? (row.issueStatus || 'open') : null,
        issueCreatedAt: row.issueCreatedAt || null,
        issueUpdatedAt: row.issueUpdatedAt || null,
        issueConflict: row.issueConflict || null,
        relatedRecords,
      };
    }

    // ── 설정 · 조건 분류 ──
    // coverageCellSizeM 은 고정값(CoverageGrid.DEFAULT_CELL_SIZE_M) · 분류 설정은 없거나 깨졌으면 기본값
    // (database.js getSettings 와 같은 규칙)
    async function readSettings() {
      const cellSize = global.CoverageGrid.DEFAULT_CELL_SIZE_M;
      const defaults = { coverageDepthTiers: DEFAULT_DEPTH_TIERS, coverageCellSizeM: cellSize };
      const saved = (await metaGet('app_settings', {})) || {};
      const classification = global.TimeConditions.classificationConfig(saved);
      return {
        ...defaults, ...saved,
        coverageCellSizeM: cellSize,
        coverageDepthTiers: (Array.isArray(saved.coverageDepthTiers) && saved.coverageDepthTiers.length)
          ? saved.coverageDepthTiers : defaults.coverageDepthTiers,
        trafficPeriods: classification.trafficPeriods,
        sunriseWindowMinutes: classification.sunriseWindowMinutes,
        sunsetWindowMinutes: classification.sunsetWindowMinutes,
        recommendationSettings: global.Recommendation.effectiveRecommendationSettings(saved.recommendationSettings),
      };
    }

    async function writeSettings(partial) {
      // 잘못된 분류 설정·추천 설정(가중치 합계 등)이면 여기서 던진다 — database.js setSettings 와 같은 규칙
      const patch = global.Recommendation.normalizeRecommendationPatch(global.TimeConditions.normalizeClassificationPatch(partial));
      const { coverageCellSizeM, ...merged } = { ...(await readSettings()), ...patch };
      await metaSet('app_settings', merged);
      return readSettings();
    }

    async function classificationConfig() {
      return global.TimeConditions.classificationConfig(await readSettings());
    }

    // 분류 서명이 지금과 다른(또는 조건 칸이 없는) 날짜 요약
    async function staleSummaryDates(signature) {
      const db = await ready();
      const t = db.transaction(['summaries'], 'readonly');
      const rows = await reqp(t.objectStore('summaries').getAll());
      return rows.filter(r => global.ConditionStats.isStale(r, signature)).map(r => r.date).sort();
    }

    let reclassifyRun = null;
    let reclassifyProgress = null;

    async function reclassifyStale() {
      let rebuilt = 0;
      // 도는 중에 설정이 또 바뀌면 서명이 달라지므로, 남은 날짜가 없을 때까지 반복한다
      for (let pass = 0; pass < 5; pass++) {
        const config = await classificationConfig();
        const signature = global.TimeConditions.classificationSignature(config);
        const dates = await staleSummaryDates(signature);
        if (!dates.length) return { rebuilt, signature };
        reclassifyProgress = { done: 0, total: dates.length };
        for (const d of dates) {
          await rebuildDateSummary(d, config);
          rebuilt++;
          reclassifyProgress.done++;
        }
      }
      return { rebuilt, signature: global.TimeConditions.classificationSignature(await classificationConfig()) };
    }

    // 차량/지역 하드코딩 목록을 설정 스토어로 최초 1회 migration.
    // 예전에 그려둔 구역 경계(meta.zonePolygons)가 있으면 그대로 옮겨온다.
    // ⚠ 예전 코드는 여기서 `await open()`을 호출했는데 `open`은 정의된 적 없는
    //    이름이라 브라우저 전역 window.open() 이 대신 불려서(빈 탭이 뜸) 실행됐다.
    //    데스크톱 앱은 이 백엔드를 안 써서 그동안 드러나지 않았다.
    async function seedDefaultsIfNeeded() {
      const db = await ready();
      if (!(await metaGet('vehicles_seeded', false))) {
        const defaults = [
          { name: '토레스 1호', color: '#9ca3af' },
          { name: '토레스 2호', color: '#f97316' },
          { name: '토레스 3호', color: '#8b5cf6' },
          { name: '토레스 4호', color: '#a3e635' },
        ];
        const t = db.transaction(['vehicles'], 'readwrite');
        const store = t.objectStore('vehicles');
        defaults.forEach((v, i) => store.put({
          name: v.name, displayName: v.name, color: v.color,
          active: true, sortOrder: i, createdAt: new Date().toISOString(),
        }));
        await done(t);
        await metaSet('vehicles_seeded', true);
      }
      if (!(await metaGet('zones_seeded', false))) {
        const defaults = [
          { name: '강남', color: '#ff7ab6', centerLat: 37.498, centerLng: 127.032 },
          { name: '판교', color: '#ffd93d', centerLat: 37.385, centerLng: 127.115 },
          { name: '시흥', color: '#5ec8f2', centerLat: 37.345, centerLng: 126.730 },
        ];
        const legacyPolys = await metaGet('zonePolygons', {});
        const t = db.transaction(['zones'], 'readwrite');
        const store = t.objectStore('zones');
        defaults.forEach((z, i) => {
          const legacy = legacyPolys && legacyPolys[z.name];
          const polygon = (Array.isArray(legacy) && legacy.length >= 3) ? legacy : [];
          store.put({
            name: z.name, color: z.color, centerLat: z.centerLat, centerLng: z.centerLng,
            polygon, active: true, sortOrder: i, createdAt: new Date().toISOString(),
          });
        });
        await done(t);
        await metaSet('zones_seeded', true);
      }

      // 예전 빌드에서 서초를 별도 기본 구역으로 자동 추가했었다. 실제 운영
      // 구역은 "강남" 경계 안에 서초 쪽 도로까지 함께 포함하는 형태라 필요
      //없다. 처음엔 비활성화만 했었는데(seocho_default_merged_into_gangnam),
      // 그래도 "지역 관리"에 죽은 항목으로 계속 보여서 아예 지운다. 사용자가
      // 직접 경계를 그려 쓰던 서초 구역(색/좌표가 다르거나 경계·수동 셀이
      // 있는 경우)은 건드리지 않는다.
      if (!(await metaGet('seocho_default_removed', false))) {
        const readTx = db.transaction(['zones'], 'readonly');
        const existingReq = reqp(readTx.objectStore('zones').get('서초'));
        const readDone = done(readTx);
        const existing = await existingReq;
        await readDone;
        const polygon = existing && Array.isArray(existing.polygon) ? existing.polygon : [];
        const hasManualCells = !!(existing && global.CoverageGrid.hasManualCells(existing.manualCells));
        const looksAutoSeeded = existing && existing.color === '#c084fc'
          && Math.abs((existing.centerLat || 0) - 37.4837) < 0.0001
          && Math.abs((existing.centerLng || 0) - 127.0324) < 0.0001
          && polygon.length === 0 && !hasManualCells;
        if (looksAutoSeeded) {
          const t = db.transaction(['zones'], 'readwrite');
          t.objectStore('zones').delete('서초');
          await done(t);
        }
        await metaSet('seocho_default_removed', true);
      }
    }

    // 날짜 요약 형식이 바뀌면 한 번 전체를 다시 만들고, 형식은 같아도 분류 기준이 달라진 날짜
    // (재분류 도중 탭을 닫은 경우)는 이어서 다시 만든다(database.js _migrateSummaries 와 같은 규칙)
    async function migrateSummariesIfNeeded() {
      const version = global.CollectionStats.SUMMARY_VERSION;
      if ((await metaGet('summary_version', 0)) !== version) {
        const config = await classificationConfig();
        const db = await ready();
        const t = db.transaction(['summaries'], 'readonly');
        const rows = await reqp(t.objectStore('summaries').getAll());
        for (const r of rows) await rebuildDateSummary(r.date, config);
        await metaSet('summary_version', version);
        return;
      }
      await reclassifyStale();
    }

    return {
      kind: 'indexeddb',
      label: 'IndexedDB',

      async init() { await ready(); await seedDefaultsIfNeeded(); await migrateSummariesIfNeeded(); },

      async stats() {
        const db = await ready();
        const t = db.transaction(['records', 'summaries', 'imports'], 'readonly');
        // 요청 3개를 await 없이 먼저 걸어놓고 한 번에 기다린다
        const reqPoints = t.objectStore('records').count();
        const reqDays = t.objectStore('summaries').count();
        const reqImports = t.objectStore('imports').count();
        const [points, days, imports] = await Promise.all([
          reqp(reqPoints), reqp(reqDays), reqp(reqImports),
        ]);
        let quota = null;
        try {
          if (navigator.storage && navigator.storage.estimate) {
            const est = await navigator.storage.estimate();
            quota = { usage: est.usage, quota: est.quota };
          }
        } catch (_) { /* 지원 안 하는 브라우저 */ }
        return { points, days, imports, dbPath: 'IndexedDB · ' + IDB_NAME, dbBytes: quota ? quota.usage : 0 };
      },

      // 중복 판정 key = date|time|vehicle|lat|lng. 같은 key인데 다른 필드(speed 등)가
      // 다르면 "완전 동일"이 아니라 "충돌"로 집계한다(대표 레코드는 유지, 값은 안 바꿈).
      async importRecords(records, meta) {
        meta = meta || {};
        const importedAt = meta.importedAt || new Date().toISOString();
        const importedBy = meta.importedBy || '';
        const normalized = [];
        let skipped = 0;
        for (const raw of records || []) {
          const rec = normalizeRecord(raw);
          if (!rec) { skipped++; continue; }
          normalized.push(rec);
        }

        const db = await ready();
        const allKeys = normalized.map(recordKey);

        // 1단계 — 이번 배치에 나오는 key들이 이미 DB에 있는지 미리 조회
        const existingRows = await (async () => {
          const t = db.transaction(['records'], 'readonly');
          const store = t.objectStore('records');
          const uniqueKeys = [...new Set(allKeys)];
          const rows = await Promise.all(uniqueKeys.map(k => reqp(store.get(k))));
          const map = new Map();
          uniqueKeys.forEach((k, i) => { if (rows[i]) map.set(k, rows[i]); });
          return map;
        })();

        // 2단계 — 새 레코드만 넣는다. 파일 안 중복이든 DB 기존 중복이든 같은 방식으로
        // "대표값"과 비교해서 완전 동일/충돌을 가른다.
        const dates = new Set();
        let inserted = 0;
        const conflicts = [];
        const representative = new Map();
        const toPut = [];
        for (let i = 0; i < normalized.length; i++) {
          const rec = normalized[i];
          const key = allKeys[i];
          dates.add(rec.date);
          const comparable = {
            place: rec.place, road: rec.road, weather: rec.weather,
            timeOfDay: rec.timeOfDay, traffic: rec.traffic, speed: rec.speed,
          };
          let existing = representative.get(key);
          if (existing === undefined) existing = existingRows.get(key) || null;
          if (!existing) {
            toPut.push({ key, ...rec, sourceFile: meta.filename || '', importedAt });
            inserted++;
            representative.set(key, comparable);
          } else {
            representative.set(key, existing);
            const diffs = diffComparableFields(existing, comparable);
            if (diffs.length) {
              conflicts.push({ date: rec.date, time: rec.time, vehicle: rec.vehicle, lat: rec.lat, lng: rec.lng, diffs });
            }
          }
        }

        // 이슈 입력(파일 하나에 하나) — 체크했는데 메모가 없으면 여기서 던진다(기록도 넣지 않는다)
        const issue = global.IssueFilter.normalizeIssueForStorage({ hasIssue: meta.hasIssue, issueNote: meta.issueNote, issueStatus: meta.issueStatus });

        {
          const t = db.transaction(['records'], 'readwrite');
          const store = t.objectStore('records');
          toPut.forEach(row => store.put(row));
          await done(t);
        }

        const duplicates = normalized.length - inserted;
        const distanceKm = fileDistanceKm(normalized);
        const vehicle = mostFrequent(normalized.map(r => r.vehicle).filter(Boolean));
        const issueAt = issue.hasIssue ? (meta.issueCreatedAt || importedAt) : null;

        // Import 이력을 먼저 저장해 id 를 받고, 그 id 로 출처 관계를 남긴다(중복이라 새로 안 넣은 레코드도 포함)
        const importId = await (async () => {
          const t = db.transaction(['imports'], 'readwrite');
          const req = t.objectStore('imports').put({
            filename: meta.filename || '', fileHash: meta.fileHash || '', importedAt, importedBy,
            dates: [...dates].sort().join(','), vehicle, distanceKm,
            total: normalized.length, inserted, duplicates, conflicts: conflicts.length,
            conflictDetails: conflicts.slice(0, 500),
            hasIssue: issue.hasIssue, issueNote: issue.issueNote,
            issueStatus: issue.hasIssue ? issue.issueStatus : null,
            issueCreatedAt: issueAt, issueUpdatedAt: issue.hasIssue ? (meta.issueUpdatedAt || issueAt) : null,
            issueConflict: null,
          });
          const id = await reqp(req);
          await done(t);
          return id;
        })();

        if (meta.trackSources !== false) {
          const t = db.transaction(['recordSources'], 'readwrite');
          const store = t.objectStore('recordSources');
          [...new Set(allKeys)].forEach(key => store.put({ id: `${key}${importId}`, key, importId }));
          await done(t);
        }
        invalidateIssueIndex();

        const classification = await classificationConfig();
        for (const d of dates) await rebuildDateSummary(d, classification);

        return {
          filename: meta.filename || '',
          importId,
          dates: [...dates].sort(),
          total: normalized.length,
          inserted,
          duplicates,
          exactDuplicates: duplicates - conflicts.length,
          conflicts: conflicts.length,
          conflictDetails: conflicts,
          skipped,
        };
      },

      async listDateSummaries() {
        const db = await ready();
        const t = db.transaction(['summaries'], 'readonly');
        const rows = await reqp(t.objectStore('summaries').getAll());
        return rows.sort((a, b) => a.date.localeCompare(b.date));
      },

      // 교통 시간대·조도·요일은 저장값이 아니라 지금 설정으로 계산해 붙인다(database.js 와 같은 규칙)
      async getRecordsByDate(date) {
        const rows = [];
        await scan({ date }, r => rows.push(r));
        rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        const config = await classificationConfig();
        const index = await issueIndex();
        return rows.map(r => {
          const mask = maskOf(index, r.key);
          const rec = stripInternal(r);
          return { ...rec, ...global.TimeConditions.classifyRecord(rec, config), issueMask: mask };
        });
      },

      async getClassificationStatus() {
        const signature = global.TimeConditions.classificationSignature(await classificationConfig());
        const db = await ready();
        const t = db.transaction(['summaries'], 'readonly');
        const totalDates = await reqp(t.objectStore('summaries').count());
        return {
          signature,
          totalDates,
          staleDates: (await staleSummaryDates(signature)).length,
          running: !!reclassifyRun,
          progress: reclassifyRun && reclassifyProgress ? { ...reclassifyProgress } : null,
        };
      },

      // ── 추천 주행: Coverage 스냅샷 · 추천 상태 (database.js 와 같은 형식·같은 지문) ──
      async saveCoverageSnapshot(zoneName, snapshot) {
        const name = String(zoneName || '').trim();
        if (!name) throw new Error('구역 이름이 없어요.');
        const n = v => (Number.isInteger(v) && v >= 0 ? v : null);
        const total = n(snapshot && snapshot.total), visited = n(snapshot && snapshot.visited);
        if (total == null || visited == null || visited > total) throw new Error('Coverage 스냅샷 값이 올바르지 않아요.');
        const all = { ...((await metaGet('coverage_snapshots', {})) || {}) };
        const summaries = await this.listDateSummaries();
        const zone = (await this.listZones()).find(z => z.name === name);
        all[name] = {
          zone: name, total, visited, unvisited: total - visited,
          coveragePct: total ? (visited / total) * 100 : 0,
          provisional: !!(snapshot && snapshot.provisional),
          cellSizeM: snapshot && Number.isFinite(snapshot.cellSizeM) ? snapshot.cellSizeM : null,
          computedAt: (snapshot && snapshot.computedAt) || new Date().toISOString(),
          fingerprint: global.Recommendation.coverageFingerprint(summaries.map(s => ({ date: s.date, count: s.count })), zone),
        };
        await metaSet('coverage_snapshots', all);
        return (await this.listCoverageSnapshots()).find(s => s.zone === name);
      },

      async listCoverageSnapshots() {
        const all = (await metaGet('coverage_snapshots', {})) || {};
        const summaries = (await this.listDateSummaries()).map(s => ({ date: s.date, count: s.count }));
        const zones = await this.listZones();
        const R = global.Recommendation;
        return Object.values(all).sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0)).map(s => ({
          ...s, ...R.coverageSnapshotFreshness(s, R.coverageFingerprint(summaries, zones.find(z => z.name === s.zone))),
        }));
      },

      async listRecommendationStates() {
        return { ...((await metaGet('recommendation_states', {})) || {}) };
      },

      async setRecommendationState(id, state) {
        const key = String(id || '');
        if (!key) throw new Error('추천 id 가 없어요.');
        const all = await this.listRecommendationStates();
        if (state == null) delete all[key];
        else all[key] = normalizeRecommendationState(state);
        await metaSet('recommendation_states', all);
        return all;
      },

      // 이미 돌고 있으면 같은 작업을 돌려준다(중복 실행 방지)
      reclassifySummaries() {
        if (reclassifyRun) return reclassifyRun;
        reclassifyRun = reclassifyStale().finally(() => { reclassifyRun = null; reclassifyProgress = null; });
        return reclassifyRun;
      },

      async getOverview(filter) {
        const dates = new Set(), zones = {}, vehicles = {};
        let points = 0;
        await scan(filter, r => {
          points++;
          if (r.date) dates.add(r.date);
          if (r.zone) zones[r.zone] = (zones[r.zone] || 0) + 1;
          if (r.vehicle) vehicles[r.vehicle] = (vehicles[r.vehicle] || 0) + 1;
        });
        const desc = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
        return { points, days: dates.size, zones: desc(zones), vehicles: desc(vehicles) };
      },

      // ── 화면 한 번에 필요한 집계를 "한 번의 스캔"으로 ────────────────────
      // IndexedDB 에는 SQL 이 없어서 집계마다 전체 레코드를 커서로 훑는다. 통계 탭이 분포를
      // 6번 따로 물어보면 8만 건을 6번 훑는다(실측 한 번에 약 0.4초 → 탭 하나에 몇 초).
      // 그래서 화면이 필요한 값을 한 번에 모아 주는 묶음 API 를 둔다. SQLite 백엔드도 같은
      // 모양으로 답하지만, 그쪽은 색인이 있어서 쿼리를 나눠 던져도 빠르다.
      //
      // getStatsBundle: 통계 탭 — 요약 + 장소/도로/날씨/시간대 분포 + (원하면) 그중 이슈 몫
      // 통계 탭 — 날짜 요약의 분포 칸(distCells)만 더한다. 원본 기록은 한 건도 읽지 않는다.
      // 분포 칸이 없는 예전 요약이 섞여 있으면(요약 재생성 전) 그 날짜만 원본으로 세서 채운다.
      async getStatsBundle(filter, options) {
        const o = options || {};
        const summaries = await this.listDateSummaries();
        const agg = global.ConditionStats.aggregateDistributions(summaries, {
          filter, withIssueShare: !!o.withIssueShare, withIssueOverview: !!o.withIssueOverview,
        });
        if (!agg.missingDates) {
          const shape = src => ({
            points: src.points, zones: src.zones, vehicles: src.vehicles, place: src.place,
            road: src.road, weather: src.weather, timeOfDay: src.timeOfDay, timeBuckets: [],
          });
          const out = { ...shape(agg), days: agg.days, issue: agg.issue ? shape(agg.issue) : null, issueOverview: null };
          if (!out.timeOfDay.length) out.timeBuckets = await this.getTimeBucketDistribution(filter);
          if (o.withIssueOverview && agg.issueCounts) {
            const index = await issueIndex();
            let openRecordCount = 0;
            index.byKey.forEach(mask => { if (mask & global.IssueFilter.MASK.OPEN) openRecordCount++; });
            out.issueOverview = {
              ...global.IssueFilter.summarizeImports(await this.listImports(100000, {})),
              recordCounts: agg.issueCounts.counts, openRecordCount,
              unlinkedRecords: agg.issueCounts.unlinked, issueRecordKeys: index.byKey.size,
            };
          }
          return out;
        }
        return this.statsBundleFromRecords(filter, o);
      },

      // 요약이 아직 새 형식이 아닐 때만 쓰는 예전 경로(전체 기록을 한 번 훑는다)
      async statsBundleFromRecords(filter, options) {
        const o = options || {};
        const wantIssue = !!o.withIssueShare;
        const wantOverview = !!o.withIssueOverview;
        const index = (wantIssue || wantOverview) ? await issueIndex() : null;
        const counts = { all: 0, clean: 0, issue_all: 0 };
        let unlinked = 0;
        const issueBits = global.IssueFilter.MASK.OPEN | global.IssueFilter.MASK.RESOLVED;
        const dates = new Set();
        const mk = () => ({ zone: {}, vehicle: {}, place: {}, road: {}, weather: {}, timeOfDay: {}, bucket: {} });
        const all = mk();
        const issue = wantIssue ? mk() : null;
        let points = 0, issuePoints = 0;
        const bump = (acc, r) => {
          if (r.zone) acc.zone[r.zone] = (acc.zone[r.zone] || 0) + 1;
          if (r.vehicle) acc.vehicle[r.vehicle] = (acc.vehicle[r.vehicle] || 0) + 1;
          if (r.place) acc.place[r.place] = (acc.place[r.place] || 0) + 1;
          if (r.road) acc.road[r.road] = (acc.road[r.road] || 0) + 1;
          if (r.weather) acc.weather[r.weather] = (acc.weather[r.weather] || 0) + 1;
          if (r.timeOfDay) acc.timeOfDay[r.timeOfDay] = (acc.timeOfDay[r.timeOfDay] || 0) + 1;
          const k = timeBucketOf(r.time);
          if (k) acc.bucket[k] = (acc.bucket[k] || 0) + 1;
        };
        await scan(filter, r => {
          points++;
          if (r.date) dates.add(r.date);
          bump(all, r);
          if (!index) return;
          const mask = maskOf(index, r.key);
          if (wantIssue && (mask & issueBits)) { issuePoints++; bump(issue, r); }
          if (wantOverview) {
            counts.all++;
            if (global.IssueFilter.maskMatches(mask, 'clean')) counts.clean++;
            if (global.IssueFilter.maskMatches(mask, 'issue_all')) counts.issue_all++;
            if (!mask) unlinked++;
          }
        });
        const desc = o2 => Object.entries(o2).sort((a, b) => b[1] - a[1]);
        const shape = (acc, n) => ({
          points: n, zones: desc(acc.zone), vehicles: desc(acc.vehicle),
          place: desc(acc.place), road: desc(acc.road), weather: desc(acc.weather),
          timeOfDay: desc(acc.timeOfDay), timeBuckets: orderedBuckets(acc.bucket),
        });
        return {
          ...shape(all, points), days: dates.size,
          issue: wantIssue ? shape(issue, issuePoints) : null,
          // 이슈 현황(통계 탭 위쪽 표)까지 같은 스캔에서 만든다 — 따로 물어보면 8만 건을 한 번 더 훑는다
          issueOverview: wantOverview ? await this.issueOverviewFrom(counts, unlinked, index) : null,
        };
      },

      // 스캔에서 센 값 + Import 이력으로 이슈 현황을 만든다(getIssueOverview 와 같은 모양)
      async issueOverviewFrom(counts, unlinked, index) {
        const imports = await this.listImports(100000, {});
        let openRecordCount = 0;
        index.byKey.forEach(mask => { if (mask & global.IssueFilter.MASK.OPEN) openRecordCount++; });
        return {
          ...global.IssueFilter.summarizeImports(imports),
          recordCounts: { ...counts }, openRecordCount,
          unlinkedRecords: unlinked, issueRecordKeys: index.byKey.size,
        };
      },

      // getAccumBundle: 누적 지도 — 요약 + 밀도 칸 + 지도 범위(예전엔 조회 세 번)
      async getAccumBundle(filter, cell) {
        cell = cell || 0.0007;
        const grid = new Map();
        const index = await issueIndex();
        const issueBits = global.IssueFilter.MASK.OPEN | global.IssueFilter.MASK.RESOLVED;
        const dates = new Set(), zones = {}, vehicles = {};
        let points = 0, minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        await scan(filter, r => {
          points++;
          if (r.date) dates.add(r.date);
          if (r.zone) zones[r.zone] = (zones[r.zone] || 0) + 1;
          if (r.vehicle) vehicles[r.vehicle] = (vehicles[r.vehicle] || 0) + 1;
          if (r.lat < minLat) minLat = r.lat;
          if (r.lat > maxLat) maxLat = r.lat;
          if (r.lng < minLng) minLng = r.lng;
          if (r.lng > maxLng) maxLng = r.lng;
          const key = Math.round(r.lat / cell) + '_' + Math.round(r.lng / cell);
          let g = grid.get(key);
          if (!g) { g = { latSum: 0, lngSum: 0, n: 0, issueN: 0, dates: new Set(), zones: {}, vehicles: {} }; grid.set(key, g); }
          g.latSum += r.lat; g.lngSum += r.lng; g.n++;
          if (maskOf(index, r.key) & issueBits) g.issueN++;
          if (r.date) g.dates.add(r.date);
          if (r.zone) g.zones[r.zone] = (g.zones[r.zone] || 0) + 1;
          if (r.vehicle) g.vehicles[r.vehicle] = (g.vehicles[r.vehicle] || 0) + 1;
        });
        const desc = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
        return {
          overview: { points, days: dates.size, zones: desc(zones), vehicles: desc(vehicles) },
          cells: [...grid.values()].map(g => ({
            lat: g.latSum / g.n, lng: g.lngSum / g.n, n: g.n, issueN: g.issueN,
            dateCount: g.dates.size, zones: g.zones, vehicles: g.vehicles,
          })),
          bounds: points ? { minLat, maxLat, minLng, maxLng, count: points } : null,
        };
      },

      async getDensityCells(filter, cell) {
        cell = cell || 0.0007;
        const grid = new Map();
        // 칸마다 "이슈 파일에서 온 기록 수"도 센다 — 누적 지도가 그 칸을 회색으로 그린다(database.js 와 같은 값)
        const index = await issueIndex();
        const issueBits = global.IssueFilter.MASK.OPEN | global.IssueFilter.MASK.RESOLVED;
        await scan(filter, r => {
          const key = Math.round(r.lat / cell) + '_' + Math.round(r.lng / cell);
          let g = grid.get(key);
          if (!g) { g = { latSum: 0, lngSum: 0, n: 0, issueN: 0, dates: new Set(), zones: {}, vehicles: {} }; grid.set(key, g); }
          g.latSum += r.lat; g.lngSum += r.lng; g.n++;
          if (maskOf(index, r.key) & issueBits) g.issueN++;
          if (r.date) g.dates.add(r.date);
          if (r.zone) g.zones[r.zone] = (g.zones[r.zone] || 0) + 1;
          if (r.vehicle) g.vehicles[r.vehicle] = (g.vehicles[r.vehicle] || 0) + 1;
        });
        return [...grid.values()].map(g => ({
          lat: g.latSum / g.n, lng: g.lngSum / g.n, n: g.n, issueN: g.issueN,
          dateCount: g.dates.size, zones: g.zones, vehicles: g.vehicles,
        }));
      },

      async getBounds(filter) {
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity, count = 0;
        await scan(filter, r => {
          count++;
          if (r.lat < minLat) minLat = r.lat;
          if (r.lat > maxLat) maxLat = r.lat;
          if (r.lng < minLng) minLng = r.lng;
          if (r.lng > maxLng) maxLng = r.lng;
        });
        return count ? { minLat, maxLat, minLng, maxLng, count } : null;
      },

      async getVisitedCellKeys(box) {
        const { latDeg, lngDeg, minLat, maxLat, minLng, maxLng } = box;
        const keys = new Set();
        await scan({ issueFilter: box && box.issueFilter }, r => {
          if (r.lat < minLat || r.lat > maxLat || r.lng < minLng || r.lng > maxLng) return;
          keys.add(Math.floor(r.lat / latDeg) + '_' + Math.floor(r.lng / lngDeg));
        });
        return [...keys];
      },

      async getDistribution(column, filter) {
        const counts = {};
        await scan(filter, r => {
          const v = r[column];
          if (v) counts[v] = (counts[v] || 0) + 1;
        });
        return Object.entries(counts).sort((a, b) => b[1] - a[1]);
      },

      async getTimeBucketDistribution(filter) {
        const counts = {};
        await scan(filter, r => {
          const k = timeBucketOf(r.time);
          if (k) counts[k] = (counts[k] || 0) + 1;
        });
        return orderedBuckets(counts);
      },

      async deleteDate(date) {
        const keys = [];
        await scan({ date }, r => keys.push(r.key));
        const db = await ready();
        const sources = await sourcesForKeys(keys);
        const t = db.transaction(['records', 'summaries', 'recordSources'], 'readwrite');
        const store = t.objectStore('records');
        keys.forEach(k => store.delete(k));
        t.objectStore('summaries').delete(date);
        // 지운 레코드의 출처 관계도 지운다(Import 이력과 이슈 메모는 남는다)
        const srcStore = t.objectStore('recordSources');
        sources.forEach(s => srcStore.delete(s.id));
        await done(t);
        invalidateIssueIndex();
        return { date, removed: keys.length };
      },

      async deleteAll() {
        const before = (await this.stats()).points;
        const db = await ready();
        const t = db.transaction(['records', 'summaries', 'imports', 'recordSources'], 'readwrite');
        t.objectStore('records').clear();
        t.objectStore('summaries').clear();
        t.objectStore('imports').clear();
        t.objectStore('recordSources').clear();
        await done(t);
        invalidateIssueIndex();
        return { removed: before };
      },

      // 기존 accum.js 계약(zone → [[lat,lng],...] 통짜 객체)을 zones 스토어 위에서 구현
      async getZonePolygons() {
        const zones = await this.listZones();
        const out = {};
        zones.forEach(z => { if (z.polygon && z.polygon.length >= 3) out[z.name] = z.polygon; });
        return out;
      },

      // "전체 교체" 의미론 — dict에 없는 구역은 경계를 비운다(clearZoneBoundary가 의존)
      async saveZonePolygons(polys) {
        const dict = polys || {};
        const zones = await this.listZones();
        const db = await ready();
        const t = db.transaction(['zones'], 'readwrite');
        const store = t.objectStore('zones');
        zones.forEach(z => {
          const pts = dict[z.name];
          store.put({ ...z, polygon: (Array.isArray(pts) && pts.length >= 3) ? pts : [] });
        });
        const known = new Set(zones.map(z => z.name));
        Object.keys(dict).forEach(name => {
          if (known.has(name)) return;
          const pts = dict[name];
          if (Array.isArray(pts) && pts.length >= 3) {
            store.put({ name, color: '', centerLat: null, centerLng: null, polygon: pts, active: true, sortOrder: 999, createdAt: new Date().toISOString() });
          }
        });
        await done(t);
        return this.getZonePolygons();
      },

      async listVehicles() {
        const db = await ready();
        const t = db.transaction(['vehicles'], 'readonly');
        const rows = await reqp(t.objectStore('vehicles').getAll());
        return rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(r => ({ ...r, active: r.active !== false }));
      },

      async saveVehicle(v) {
        const name = String((v && v.name) || '').trim();
        if (!name) throw new Error('차량 이름을 입력해주세요.');
        const displayName = String((v && (v.displayName || v.display_name)) || name).trim();
        const color = String((v && v.color) || '').trim();
        const active = !(v && v.active === false);
        const db = await ready();
        const { existing, nextOrder } = await (async () => {
          const t = db.transaction(['vehicles'], 'readonly');
          const store = t.objectStore('vehicles');
          const [ex, all] = await Promise.all([reqp(store.get(name)), reqp(store.getAll())]);
          const maxOrder = all.reduce((m, r) => Math.max(m, r.sortOrder || 0), -1);
          return { existing: ex, nextOrder: maxOrder + 1 };
        })();
        const row = existing
          ? { ...existing, displayName, color, active }
          : { name, displayName, color, active, sortOrder: nextOrder, createdAt: new Date().toISOString() };
        const t2 = db.transaction(['vehicles'], 'readwrite');
        t2.objectStore('vehicles').put(row);
        await done(t2);
        return (await this.listVehicles()).find(x => x.name === name);
      },

      async setVehicleActive(name, active) {
        const db = await ready();
        const existing = await (async () => { const t = db.transaction(['vehicles'], 'readonly'); return reqp(t.objectStore('vehicles').get(name)); })();
        if (existing) {
          const t2 = db.transaction(['vehicles'], 'readwrite');
          t2.objectStore('vehicles').put({ ...existing, active: !!active });
          await done(t2);
        }
        return this.listVehicles();
      },

      async listZones() {
        const db = await ready();
        const t = db.transaction(['zones'], 'readonly');
        const rows = await reqp(t.objectStore('zones').getAll());
        return rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
          .map(r => ({
            ...r,
            polygon: Array.isArray(r.polygon) ? r.polygon : [],
            active: r.active !== false,
            manualCells: global.CoverageGrid.normalizeManualCells(r.manualCells),
          }));
      },

      async saveZone(z) {
        const name = String((z && z.name) || '').trim();
        if (!name) throw new Error('지역 이름을 입력해주세요.');
        const color = String((z && z.color) || '').trim();
        const centerLat = z && z.centerLat != null ? Number(z.centerLat) : null;
        const centerLng = z && z.centerLng != null ? Number(z.centerLng) : null;
        const active = !(z && z.active === false);
        const db = await ready();
        const { existing, nextOrder } = await (async () => {
          const t = db.transaction(['zones'], 'readonly');
          const store = t.objectStore('zones');
          const [ex, all] = await Promise.all([reqp(store.get(name)), reqp(store.getAll())]);
          const maxOrder = all.reduce((m, r) => Math.max(m, r.sortOrder || 0), -1);
          return { existing: ex, nextOrder: maxOrder + 1 };
        })();
        const polygon = (Array.isArray(z && z.polygon) && z.polygon.length >= 3) ? z.polygon : (existing ? existing.polygon : []);
        const row = existing
          ? { ...existing, color, centerLat, centerLng, active, polygon }
          : { name, color, centerLat, centerLng, polygon, active, sortOrder: nextOrder, createdAt: new Date().toISOString() };
        const t2 = db.transaction(['zones'], 'readwrite');
        t2.objectStore('zones').put(row);
        await done(t2);
        return (await this.listZones()).find(x => x.name === name);
      },

      async setZoneActive(name, active) {
        const db = await ready();
        const existing = await (async () => { const t = db.transaction(['zones'], 'readonly'); return reqp(t.objectStore('zones').get(name)); })();
        if (existing) {
          const t2 = db.transaction(['zones'], 'readwrite');
          t2.objectStore('zones').put({ ...existing, active: !!active });
          await done(t2);
        }
        return this.listZones();
      },

      // 반환 형식은 SQLite 와 같다: {excluded, visited, unvisited} — 예전 행에 unvisited가
      // 없어도 빈 배열로 채운다.
      async getZoneManualCells(name) {
        const db = await ready();
        const t = db.transaction(['zones'], 'readonly');
        const row = await reqp(t.objectStore('zones').get(name));
        return global.CoverageGrid.normalizeManualCells(row && row.manualCells);
      },

      async saveZoneManualCells(name, data) {
        const db = await ready();
        const readTx = db.transaction(['zones'], 'readonly');
        const existingReq = reqp(readTx.objectStore('zones').get(name));
        const readDone = done(readTx);
        const existing = await existingReq;
        await readDone;
        if (existing) {
          const t = db.transaction(['zones'], 'readwrite');
          t.objectStore('zones').put({
            ...existing,
            manualCells: global.CoverageGrid.normalizeManualCells(data),
          });
          await done(t);
        }
        return this.getZoneManualCells(name);
      },

      getSettings() { return readSettings(); },

      // 분류 설정은 저장 전에 검증(겹침·공백·형식 오류면 아무것도 저장하지 않고 던짐). 재분류는 따로.
      setSettings(partial) { return writeSettings(partial); },

      // Coverage Depth — 같은 (date,vehicle) 안에서 시간순으로 셀이 바뀔 때만 새 방문으로 센다.
      // GPS가 ~10초 간격으로 찍혀도 두 점 사이 실제 이동 경로가 지나가는 모든
      // 칸을 방문으로 잡는다(CoverageGrid, coverage-grid.js — desktop(SQLite,
      // database.js)과 완전히 같은 로직을 쓴다). 이동 판정(그 사이를 이을지)은
      // 시간차·속도 조건을 만족할 때만 하고, 아니면 점 하나만 남긴다.
      async getCellVisitCounts(box, cellSizeM) {
        const size = cellSizeM || global.CoverageGrid.DEFAULT_CELL_SIZE_M;
        const latDeg = size / 111320;
        const refLat = (box && box.refLat) || 37.5;
        const lngDeg = (box && box.lngDeg) || size / (111320 * Math.cos(refLat * Math.PI / 180));

        // segment 연결을 허용하는 최대 거리만큼 쿼리 bbox를 넉넉히 넓힌다 —
        // database.js의 getCellVisitCounts와 같은 이유(주석 참고).
        const marginM = (CoverageGrid.MAX_INTERPOLATION_SPEED_KMH / 3.6) * CoverageGrid.MAX_INTERPOLATION_GAP_SEC;
        const marginLatDeg = marginM / 111320;
        const marginLngDeg = marginM / (111320 * Math.cos(refLat * Math.PI / 180));

        const groups = new Map();
        // 이슈 필터는 GPS 방문 데이터에만 건다(구역 경계·도로 Geometry 는 무관 — 화면에서 따로 캐시)
        const issueIdx = (box && box.issueFilter && box.issueFilter !== 'all') ? await issueIndex() : null;
        await scan({ issueFilter: box && box.issueFilter }, r => {
          if (box && box.minLat != null && (r.lat < box.minLat - marginLatDeg || r.lat > box.maxLat + marginLatDeg)) return;
          if (box && box.minLng != null && (r.lng < box.minLng - marginLngDeg || r.lng > box.maxLng + marginLngDeg)) return;
          if (box && !matches(r, box, issueIdx)) return; // 날짜 범위/구역/차량 — database.js getCellVisitCounts 와 같은 조건
          const key = (r.date || '') + '|' + (r.vehicle || '');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ lat: r.lat, lng: r.lng, timestamp: r.timestamp || '' });
        });
        const visits = new Map();
        groups.forEach(list => {
          list.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
          CoverageGrid.accumulatePartitionVisits(list, latDeg, lngDeg, visits);
        });
        return [...visits.entries()].map(([k, v]) => {
          const [gy, gx] = k.split('_').map(Number);
          return { gy, gx, visits: v };
        });
      },

      // options: {issueOnly, issueStatus, search, withRelatedRecords} — database.js listImports 와 같은 의미
      async listImports(limit, options) {
        const o = options || {};
        const db = await ready();
        const t = db.transaction(['imports'], 'readonly');
        const rows = await reqp(t.objectStore('imports').getAll());
        // 파일별 레코드 수는 필요할 때만 센다(목록을 그릴 때마다 출처 전체를 훑지 않게)
        const counts = o.withRelatedRecords ? await sourceCountsByImport() : null;
        return rows
          .map(r => normalizeImportRecord(r, counts ? (counts.get(r.id) || 0) : null))
          .filter(r => (!o.issueOnly || r.hasIssue)
            && (!o.issueStatus || (r.hasIssue && r.issueStatus === o.issueStatus))
            && (!o.search || `${r.filename} ${r.issueNote}`.toLowerCase().includes(String(o.search).toLowerCase())))
          .sort((a, b) => (b.id || 0) - (a.id || 0))
          .slice(0, limit || 200);
      },

      async getImport(importId) {
        const db = await ready();
        const t = db.transaction(['imports'], 'readonly');
        const row = await reqp(t.objectStore('imports').get(importId));
        if (!row) return null;
        const counts = await sourceCountsByImport();
        return normalizeImportRecord(row, counts.get(importId) || 0);
      },

      // 이슈 메모·상태 수정 — 원본 기록과 Import 이력은 그대로 두고, 그 파일이 관여한 날짜 요약만 다시 만든다
      async updateImportIssue(importId, patch) {
        const db = await ready();
        const existing = await (async () => { const t = db.transaction(['imports'], 'readonly'); return reqp(t.objectStore('imports').get(importId)); })();
        if (!existing) throw new Error('그 Import 이력을 찾지 못했어요.');
        const next = global.IssueFilter.normalizeIssueForStorage(patch || {}, {
          hasIssue: !!existing.hasIssue, issueNote: existing.issueNote || '', issueStatus: existing.issueStatus || 'open',
        });
        const now = new Date().toISOString();
        const row = {
          ...existing,
          hasIssue: next.hasIssue,
          issueNote: next.issueNote,
          issueStatus: next.hasIssue ? next.issueStatus : null,
          issueCreatedAt: next.hasIssue ? (existing.issueCreatedAt || now) : (existing.issueCreatedAt || null),
          issueUpdatedAt: now,
        };
        const t = db.transaction(['imports'], 'readwrite');
        t.objectStore('imports').put(row);
        await done(t);
        invalidateIssueIndex();
        await this.rebuildSummariesForImport(importId);
        return this.getImport(importId);
      },

      async rebuildSummariesForImport(importId) {
        const keys = await keysForImport(importId);
        const dates = [...new Set(keys.map(k => String(k).split('|')[0]))];
        const config = await classificationConfig();
        for (const d of dates) await rebuildDateSummary(d, config);
        return dates;
      },

      // 그 날짜 기록이 어느 Import 에서 왔는지(이슈 포함) — 일자 요약의 "이슈사항"
      async listDateImports(date) {
        const rows = [];
        await scan({ date }, r => rows.push(r.key));
        const sources = await sourcesForKeys(rows);
        const counts = new Map();
        sources.forEach(s => counts.set(s.importId, (counts.get(s.importId) || 0) + 1));
        const all = await this.listImports(100000, {});
        return all.filter(im => counts.has(im.id))
          .map(im => ({ ...im, importId: im.id, recordCount: counts.get(im.id) }))
          .sort((a, b) => (Number(b.hasIssue) - Number(a.hasIssue)) || String(a.issueStatus || '').localeCompare(String(b.issueStatus || '')) || (a.id - b.id));
      },

      // Import 이력·이슈·출처 관계 복원(백업/서버 동기화) — database.js restoreImports 와 같은 규칙.
      // 같은 Import 인지는 파일명|파일 지문|Import 시각으로 가리고, 이슈가 양쪽에서 수정됐으면
      // issueUpdatedAt 이 최신인 쪽을 쓰되 밀려난 값을 issueConflict 로 남긴다(메모를 합치지 않는다).
      async restoreImports(imports) {
        if (!Array.isArray(imports) || !imports.length) return { added: 0, updated: 0, conflicts: 0, sources: 0 };
        const db = await ready();
        const existingRows = await (async () => { const t = db.transaction(['imports'], 'readonly'); return reqp(t.objectStore('imports').getAll()); })();
        const identity = im => [im.filename || '', im.fileHash || '', im.importedAt || ''].join('|');
        const byIdentity = new Map(existingRows.map(r => [identity(r), r]));
        const recordKeys = new Set();
        await scan(null, r => recordKeys.add(r.key));
        let added = 0, updated = 0, conflicts = 0, sources = 0;
        const touched = [];
        for (const im of imports) {
          if (!im || typeof im !== 'object') continue;
          const incoming = {
            hasIssue: !!im.hasIssue, issueNote: String(im.issueNote || ''),
            issueStatus: im.hasIssue ? (im.issueStatus === 'resolved' ? 'resolved' : 'open') : null,
            issueCreatedAt: im.issueCreatedAt || null, issueUpdatedAt: im.issueUpdatedAt || null,
          };
          const existing = byIdentity.get(identity(im));
          let importId;
          if (!existing) {
            const { id, recordKeys: _keys, relatedRecords: _rel, ...rest } = im;
            const t = db.transaction(['imports'], 'readwrite');
            importId = await reqp(t.objectStore('imports').put({ ...rest, ...incoming, issueConflict: null }));
            await done(t);
            added++;
          } else {
            importId = existing.id;
            const mine = existing.issueUpdatedAt || '';
            const theirs = incoming.issueUpdatedAt || '';
            const differs = (!!existing.hasIssue !== incoming.hasIssue) || ((existing.issueNote || '') !== incoming.issueNote)
              || ((existing.issueStatus || '') !== (incoming.issueStatus || ''));
            if (differs && (theirs > mine || !mine)) {
              const conflict = mine ? {
                keptFrom: 'incoming', detectedAt: new Date().toISOString(),
                replaced: { hasIssue: !!existing.hasIssue, issueNote: existing.issueNote || '', issueStatus: existing.issueStatus || '', issueUpdatedAt: mine },
              } : null;
              if (conflict) conflicts++;
              const t = db.transaction(['imports'], 'readwrite');
              t.objectStore('imports').put({ ...existing, ...incoming, issueCreatedAt: incoming.issueCreatedAt || existing.issueCreatedAt || null, issueConflict: conflict || existing.issueConflict || null });
              await done(t);
              updated++;
            } else if (differs && mine && theirs && theirs < mine) {
              conflicts++;
              const t = db.transaction(['imports'], 'readwrite');
              t.objectStore('imports').put({ ...existing, issueConflict: {
                keptFrom: 'local', detectedAt: new Date().toISOString(),
                replaced: { hasIssue: incoming.hasIssue, issueNote: incoming.issueNote, issueStatus: incoming.issueStatus, issueUpdatedAt: theirs },
              } });
              await done(t);
            }
          }
          const keys = (im.recordKeys || []).filter(k => recordKeys.has(k));
          if (keys.length) {
            const t = db.transaction(['recordSources'], 'readwrite');
            const store = t.objectStore('recordSources');
            keys.forEach(key => store.put({ id: `${key}${importId}`, key, importId }));
            await done(t);
            sources += keys.length;
          }
          touched.push(importId);
        }
        invalidateIssueIndex();
        for (const id of [...new Set(touched)]) await this.rebuildSummariesForImport(id);
        return { added, updated, conflicts, sources };
      },

      // ── 세부 수집 구역(2단계) — database.js 와 같은 규칙·같은 결과 ──
      async listSubZones(options) {
        const o = options || {};
        const db = await ready();
        const t = db.transaction(['subZones'], 'readonly');
        const rows = await reqp(t.objectStore('subZones').getAll());
        return rows.filter(z => o.includeInactive || z.active !== false)
          .sort((a, b) => String(a.parentZone).localeCompare(String(b.parentZone)) || String(a.name).localeCompare(String(b.name)));
      },

      async getSubZone(id) {
        const db = await ready();
        const t = db.transaction(['subZones'], 'readonly');
        return (await reqp(t.objectStore('subZones').get(id))) || null;
      },

      async saveSubZone(input) {
        const prev = input && input.id ? await this.getSubZone(input.id) : null;
        const v = global.SubZones.normalizeSubZone(input, prev);
        if (!v.ok) {
          const err = new Error(v.errors.join('\n'));
          err.errors = v.errors;
          throw err;
        }
        const db = await ready();
        const t = db.transaction(['subZones'], 'readwrite');
        t.objectStore('subZones').put(v.value);
        await done(t);
        return v.value;
      },

      async setSubZoneActive(id, active) {
        const z = await this.getSubZone(id);
        if (!z) throw new Error('그 세부 구역을 찾지 못했어요.');
        const next = { ...z, active: !!active, updatedAt: new Date().toISOString() };
        const db = await ready();
        const t = db.transaction(['subZones'], 'readwrite');
        t.objectStore('subZones').put(next);
        await done(t);
        return next;
      },

      async deleteSubZone(id) {
        const before = await this.getSubZone(id);
        const db = await ready();
        const t = db.transaction(['subZones'], 'readwrite');
        t.objectStore('subZones').delete(id);
        await done(t);
        return { id, removed: !!before };
      },

      // 브라우저에서는 HD Map 이 <script> 로 올라온 전역(window.HDMAP_*_ROADS)에 있다
      hdmapLinesFor(parentZone) {
        const globals = { gangnam: 'HDMAP_GANGNAM_ROADS', seocho: 'HDMAP_SEOCHO_ROADS' };
        const lines = [];
        global.SubZones.hdmapKeysFor(parentZone).forEach(key => {
          const data = global[globals[key]];
          (data && data.lines ? data.lines : []).forEach(l => lines.push(l));
        });
        return lines;
      },

      async getSubZoneStats(subZones, options) {
        const o = options || {};
        const list = (subZones && subZones.length) ? subZones : await this.listSubZones();
        const classification = await classificationConfig();
        const index = await issueIndex();
        const out = [];
        for (const sz of list) {
          const bounds = global.SubZones.polygonBounds(sz.polygon);
          if (!bounds) {
            out.push({ id: sz.id, recordCount: 0, conditions: [], roads: [], match: { segments: 0, note: '경계가 없어 집계할 수 없어요.' } });
            continue;
          }
          const rows = [];
          await scan(o.filter || {}, r => {
            if (r.lat < bounds.minLat || r.lat > bounds.maxLat || r.lng < bounds.minLng || r.lng > bounds.maxLng) return;
            rows.push({ ...r, issueMask: maskOf(index, r.key) });
          });
          rows.sort((a, b) => String(a.vehicle || '').localeCompare(String(b.vehicle || '')) || String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
          const roadSegments = o.withRoads === false ? []
            : global.SubZones.roadSegmentsIn(sz.polygon, this.hdmapLinesFor(sz.parentZone), { subZoneId: sz.id });
          out.push(global.SubZones.aggregateSubZone(sz, rows, { classification, roadSegments }));
        }
        return out;
      },

      async getIssueOverview(filter) {
        const index = await issueIndex();
        // 필터마다 따로 훑지 않는다 — 한 번 훑으면서 레코드의 마스크로 셋 다 센다
        const counts = { all: 0, clean: 0, issue_all: 0 };
        let unlinked = 0;
        await scan(filter, r => {
          const mask = maskOf(index, r.key);
          counts.all++;
          if (global.IssueFilter.maskMatches(mask, 'clean')) counts.clean++;
          if (global.IssueFilter.maskMatches(mask, 'issue_all')) counts.issue_all++;
          if (!mask) unlinked++;
        });
        return this.issueOverviewFrom(counts, unlinked, index);
      },

      async findImportByFileHash(hash) {
        if (!hash) return null;
        const rows = await this.listImports(1000);
        return rows.find(r => r.fileHash === hash) || null;
      },

      async getImportConflicts(importId) {
        const db = await ready();
        const t = db.transaction(['imports'], 'readonly');
        const row = await reqp(t.objectStore('imports').get(importId));
        return (row && row.conflictDetails) || [];
      },

      getBackupHistory() { return metaGet('backupHistory', []).then(v => v || []); },
      setBackupHistory(h) { return metaSet('backupHistory', Array.isArray(h) ? h.slice(0, 10) : []); },

      async buildBackupPayload() {
        const summaries = await this.listDateSummaries();
        const data = {};
        for (const s of summaries) data[s.date] = await this.getRecordsByDate(s.date);
        return {
          type: 'route-viewer-backup',
          version: 3,
          exportedAt: new Date().toISOString(),
          dateCount: summaries.length,
          data,
          zonePolygons: await this.getZonePolygons(),
          vehicles: await this.listVehicles(),
          zones: await this.listZones(),
          settings: await this.getSettings(),
          backupHistory: await this.getBackupHistory(),
          // Import 이슈와 "그 파일에서 나온 레코드 키"를 함께 싣는다(database.js buildBackupPayload 와 같은 형식)
          imports: await (async () => {
            const imports = await this.listImports(1000, {});
            const sources = await allSources();
            const byImport = new Map();
            sources.forEach(s => { if (!byImport.has(s.importId)) byImport.set(s.importId, []); byImport.get(s.importId).push(s.key); });
            return imports.map(im => ({ ...im, recordKeys: byImport.get(im.id) || [] }));
          })(),
        };
      },

      async restoreBackupPayload(payload, mode) {
        if (!payload || payload.type !== 'route-viewer-backup' || !payload.data || typeof payload.data !== 'object') {
          throw new Error('invalid backup payload');
        }
        if (mode === 'replace') await this.deleteAll();
        const flat = [];
        for (const [date, rows] of Object.entries(payload.data)) {
          if (!Array.isArray(rows)) continue;
          for (const row of rows) flat.push({ ...row, date: row.date || date });
        }
        const result = await this.importRecords(flat, {
          filename: '(백업 복구)',
          importedAt: payload.exportedAt || new Date().toISOString(),
          // database.js 와 같은 이유 — 복원 경로를 레코드 출처로 남기지 않는다.
          // 남기면 모든 기록이 "이슈 없는 파일에서도 왔다"가 되어 이슈 분리가 무너진다.
          trackSources: false,
        });
        if (payload.zonePolygons && typeof payload.zonePolygons === 'object') {
          const merged = mode === 'replace' ? {} : await this.getZonePolygons();
          Object.entries(payload.zonePolygons).forEach(([z, pts]) => {
            if (Array.isArray(pts) && pts.length >= 3) merged[z] = pts;
          });
          await this.saveZonePolygons(merged);
        }
        // vehicles/zones/settings 는 mode 와 무관하게 항상 upsert만 한다 (설정은 지우지 않음)
        if (Array.isArray(payload.vehicles)) {
          for (const v of payload.vehicles) if (v && v.name) await this.saveVehicle(v);
        }
        if (Array.isArray(payload.zones)) {
          for (const z of payload.zones) if (z && z.name) await this.saveZone(z);
          // 수동 셀은 칸 단위 병합 — database.js restoreBackupPayload 와 같은 규칙
          for (const z of payload.zones) {
            if (!z || !z.name || !z.manualCells || !global.CoverageGrid.hasManualCells(z.manualCells)) continue;
            const merged = global.CoverageGrid.mergeManualCellsByPoint(await this.getZoneManualCells(z.name), z.manualCells);
            await this.saveZoneManualCells(z.name, merged);
          }
        }
        if (payload.settings && typeof payload.settings === 'object') {
          // 잘못된 분류·추천 설정은 그 값만 빼고 반영(database.js 와 같은 규칙)
          await this.setSettings(global.Recommendation.sanitizeRecommendationSettings(global.TimeConditions.sanitizeClassificationSettings(payload.settings)));
        }
        if (Array.isArray(payload.backupHistory)) {
          const current = mode === 'replace' ? [] : await this.getBackupHistory();
          await this.setBackupHistory(global.dedupeBackupHistory([...payload.backupHistory, ...current]));
        }
        const importResult = await this.restoreImports(payload.imports);
        // 백업의 설정이 분류 기준을 바꿨으면 기존 날짜 요약도 새 기준으로 맞춘다
        const reclassified = await reclassifyStale();
        return { ...result, mode, reclassifiedDates: reclassified.rebuilt, imports: importResult };
      },
    };
  }

  // database.js normalizeRecommendationState 와 같은 규칙
  function normalizeRecommendationState(state) {
    const status = state && state.status;
    if (status === 'snoozed') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(state.until || ''))) throw new Error('추천 제외 기간(until)이 올바르지 않아요.');
      return { status, until: state.until, markedAt: state.markedAt || new Date().toISOString() };
    }
    if (status === 'completed') {
      const snap = state.snapshot || {};
      const n = v => (Number.isFinite(v) && v >= 0 ? v : 0);
      return { status, markedAt: state.markedAt || new Date().toISOString(), snapshot: { collectionSec: n(snap.collectionSec), visitCount: n(snap.visitCount) } };
    }
    throw new Error('알 수 없는 추천 상태예요.');
  }

  function stripInternal(r) {
    const { key, sourceFile, importedAt, ...rest } = r;
    return rest;
  }

  // ══════════════════════════════════════════════════════
  //  RouteDB — 화면이 실제로 부르는 객체
  // ══════════════════════════════════════════════════════
  const RouteDB = {
    backend: null,

    async init() {
      const api = global.routeAPI;
      this.backend = (api && api.isDesktop) ? makeDesktopBackend(api) : makeIdbBackend();
      await this.backend.init();
      if (this.backend.kind === 'indexeddb') await migrateLegacyLocalStorage(this.backend);
      return this.backend.kind;
    },

    get kind() { return this.backend ? this.backend.kind : 'none'; },
    get isDesktop() { return !!(global.routeAPI && global.routeAPI.isDesktop); },

    // 데이터가 바뀌는 호출이 성공하면 알려준다 — 누적 지도(accum.js)가 이걸 듣고
    // Coverage 캐시를 무효화한다. 호출한 쪽(import/삭제/복원/설정 화면)이 일일이
    // 누적 지도를 챙기지 않아도 되게 하려는 것이다.
    onChange(fn) {
      changeListeners.push(fn);
      return () => { const i = changeListeners.indexOf(fn); if (i >= 0) changeListeners.splice(i, 1); };
    },
    // RouteDB 를 거치지 않는 변경(서버 동기화 = routeAPI.syncRun)은 호출부가 직접 알린다
    notifyChange(method, args) {
      changeListeners.slice().forEach(fn => {
        try { fn({ method, args: args || [] }); } catch (err) { console.warn('[경로뷰어] 변경 알림 처리 실패:', err); }
      });
    },
  };

  const changeListeners = [];
  const MUTATING_METHODS = new Set([
    'importRecords', 'deleteDate', 'deleteAll', 'saveZonePolygons', 'saveZone', 'setZoneActive',
    'saveZoneManualCells', 'setSettings', 'restoreBackupPayload', 'reclassifySummaries',
    'saveCoverageSnapshot', 'setRecommendationState', 'updateImportIssue', 'restoreImports',
    'saveSubZone', 'setSubZoneActive', 'deleteSubZone',
  ]);

  // 백엔드 메서드를 RouteDB 로 그대로 흘려보낸다
  [
    'stats', 'importRecords', 'listDateSummaries', 'getRecordsByDate', 'getOverview',
    'getDensityCells', 'getBounds', 'getVisitedCellKeys', 'getDistribution',
    'getTimeBucketDistribution', 'deleteDate', 'deleteAll', 'getZonePolygons',
    'saveZonePolygons', 'listImports', 'findImportByFileHash', 'getImportConflicts',
    'listVehicles', 'saveVehicle', 'setVehicleActive', 'listZones', 'saveZone',
    'setZoneActive', 'getZoneManualCells', 'saveZoneManualCells', 'getSettings', 'setSettings', 'getCellVisitCounts',
    'getBackupHistory', 'setBackupHistory', 'buildBackupPayload', 'restoreBackupPayload',
    'getClassificationStatus', 'reclassifySummaries',
    'saveCoverageSnapshot', 'listCoverageSnapshots', 'listRecommendationStates', 'setRecommendationState',
    'getImport', 'updateImportIssue', 'listDateImports', 'getIssueOverview', 'restoreImports',
    'getStatsBundle', 'getAccumBundle',
    'listSubZones', 'getSubZone', 'saveSubZone', 'setSubZoneActive', 'deleteSubZone', 'getSubZoneStats',
  ].forEach(name => {
    RouteDB[name] = function (...args) {
      if (!this.backend) throw new Error('RouteDB.init() 이 먼저 호출돼야 합니다');
      if (!MUTATING_METHODS.has(name)) return this.backend[name](...args);
      return Promise.resolve(this.backend[name](...args)).then(res => {
        RouteDB.notifyChange(name, args);
        return res;
      });
    };
  });

  // ══════════════════════════════════════════════════════
  //  예전 버전(localStorage) 데이터 1회 이관
  //  기존 사용자가 앱을 열었을 때 그동안 쌓은 기록을 잃지 않도록,
  //  localStorage 에 남아있던 데이터를 IndexedDB 로 옮겨 담는다.
  //  (원본은 지우지 않고 이관 완료 표시만 남긴다 — 되돌릴 수 있게)
  // ══════════════════════════════════════════════════════
  const LEGACY_ENTRIES_KEY = 'route_viewer_entries_by_date';
  const LEGACY_ZONES_KEY = 'route_viewer_zone_polygons';
  const LEGACY_HISTORY_KEY = 'route_viewer_backup_history';
  const MIGRATED_FLAG = 'route_viewer_migrated_to_idb';

  async function migrateLegacyLocalStorage(backend) {
    let raw = null, zonesRaw = null, historyRaw = null, alreadyDone = false;
    try {
      alreadyDone = localStorage.getItem(MIGRATED_FLAG) === '1';
      raw = localStorage.getItem(LEGACY_ENTRIES_KEY);
      zonesRaw = localStorage.getItem(LEGACY_ZONES_KEY);
      historyRaw = localStorage.getItem(LEGACY_HISTORY_KEY);
    } catch (_) { return; }
    if (alreadyDone) return;

    try {
      if (raw) {
        const obj = JSON.parse(raw);
        const flat = [];
        Object.entries(obj).forEach(([date, rows]) => {
          if (!Array.isArray(rows)) return;
          rows.forEach(r => flat.push({ ...r, date: r.date || date }));
        });
        if (flat.length) {
          const res = await backend.importRecords(flat, { filename: '(이전 버전 localStorage 이관)' });
          console.info(`[경로뷰어] 예전 localStorage 기록 ${res.inserted}건을 IndexedDB로 옮겼어요.`);
        }
      }
      if (zonesRaw) {
        const zones = JSON.parse(zonesRaw);
        const current = await backend.getZonePolygons();
        Object.entries(zones || {}).forEach(([z, pts]) => {
          if (Array.isArray(pts) && pts.length >= 3 && !current[z]) current[z] = pts;
        });
        await backend.saveZonePolygons(current);
      }
      if (historyRaw) {
        const hist = JSON.parse(historyRaw);
        if (Array.isArray(hist) && hist.length) await backend.setBackupHistory(hist);
      }
      try { localStorage.setItem(MIGRATED_FLAG, '1'); } catch (_) { /* 무시 */ }
    } catch (err) {
      console.warn('[경로뷰어] 예전 데이터 이관 실패:', err);
    }
  }

  global.RouteDB = RouteDB;
  global.routeRecordKey = recordKey;
  global.DEDUPE_KEY_FIELDS = DEDUPE_KEY_FIELDS;
}(window));
