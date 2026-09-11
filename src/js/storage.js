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
      getBounds: f => api.getBounds(f || {}),
      getVisitedCellKeys: b => api.getVisitedCellKeys(b),
      getDistribution: (col, f) => api.getDistribution(col, f || {}),
      getTimeBucketDistribution: f => api.getTimeBucketDistribution(f || {}),
      deleteDate: d => api.deleteDate(d),
      deleteAll: () => api.deleteAll(),
      getZonePolygons: () => api.getZonePolygons(),
      saveZonePolygons: p => api.saveZonePolygons(p),
      listImports: n => api.listImports(n),
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
  const IDB_VERSION = 2; // v2: vehicles/zones 설정 저장소 추가 (요구사항 13~16)

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

    // records 를 커서로 훑으면서 콜백에 하나씩 넘긴다(배열로 모으지 않음)
    async function scan(filter, onRecord) {
      const db = await ready();
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
          if (matches(v, filter)) onRecord(v);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }

    // database.js _filterSql 과 같은 조건 — 예전엔 fromDate/toDate 를 빠뜨려서 브라우저 모드에서는
    // 누적 지도 날짜 필터가 통계/밀도/Coverage 어디에도 적용되지 않았다.
    function matches(v, filter) {
      if (!filter) return true;
      if (filter.date && v.date !== filter.date) return false;
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

    async function rebuildDateSummary(date) {
      const rows = [];
      await scan({ date }, r => rows.push(r));
      const db = await ready();
      const t = db.transaction(['summaries'], 'readwrite');
      if (!rows.length) {
        t.objectStore('summaries').delete(date);
      } else {
        rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        t.objectStore('summaries').put({
          date, count: rows.length, ...global.buildDaySummaryFromPoints(rows),
        });
      }
      await done(t);
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

    return {
      kind: 'indexeddb',
      label: 'IndexedDB',

      async init() { await ready(); await seedDefaultsIfNeeded(); },

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

        {
          const t = db.transaction(['records'], 'readwrite');
          const store = t.objectStore('records');
          toPut.forEach(row => store.put(row));
          await done(t);
        }

        for (const d of dates) await rebuildDateSummary(d);

        const duplicates = normalized.length - inserted;
        const distanceKm = fileDistanceKm(normalized);
        const vehicle = mostFrequent(normalized.map(r => r.vehicle).filter(Boolean));

        const t2 = db.transaction(['imports'], 'readwrite');
        t2.objectStore('imports').put({
          filename: meta.filename || '', fileHash: meta.fileHash || '', importedAt, importedBy,
          dates: [...dates].sort().join(','), vehicle, distanceKm,
          total: normalized.length, inserted, duplicates, conflicts: conflicts.length,
          conflictDetails: conflicts.slice(0, 500),
        });
        await done(t2);

        return {
          filename: meta.filename || '',
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

      async getRecordsByDate(date) {
        const rows = [];
        await scan({ date }, r => rows.push(r));
        rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        return rows.map(stripInternal);
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

      async getDensityCells(filter, cell) {
        cell = cell || 0.0007;
        const grid = new Map();
        await scan(filter, r => {
          const key = Math.round(r.lat / cell) + '_' + Math.round(r.lng / cell);
          let g = grid.get(key);
          if (!g) { g = { latSum: 0, lngSum: 0, n: 0, dates: new Set(), zones: {}, vehicles: {} }; grid.set(key, g); }
          g.latSum += r.lat; g.lngSum += r.lng; g.n++;
          if (r.date) g.dates.add(r.date);
          if (r.zone) g.zones[r.zone] = (g.zones[r.zone] || 0) + 1;
          if (r.vehicle) g.vehicles[r.vehicle] = (g.vehicles[r.vehicle] || 0) + 1;
        });
        return [...grid.values()].map(g => ({
          lat: g.latSum / g.n, lng: g.lngSum / g.n, n: g.n,
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
        await scan(null, r => {
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
          const h = parseInt(String(r.time || '').split(':')[0], 10);
          if (isNaN(h) || h < 0 || h > 23) return;
          const start = Math.floor(h / 4) * 4;
          const p = n => String(n).padStart(2, '0');
          const k = `${p(start)}-${p(start + 4)}시`;
          counts[k] = (counts[k] || 0) + 1;
        });
        const ORDER = ['00-04시', '04-08시', '08-12시', '12-16시', '16-20시', '20-24시'];
        return ORDER.filter(k => counts[k]).map(k => [k, counts[k]]);
      },

      async deleteDate(date) {
        const keys = [];
        await scan({ date }, r => keys.push(r.key));
        const db = await ready();
        const t = db.transaction(['records', 'summaries'], 'readwrite');
        const store = t.objectStore('records');
        keys.forEach(k => store.delete(k));
        t.objectStore('summaries').delete(date);
        await done(t);
        return { date, removed: keys.length };
      },

      async deleteAll() {
        const before = (await this.stats()).points;
        const db = await ready();
        const t = db.transaction(['records', 'summaries', 'imports'], 'readwrite');
        t.objectStore('records').clear();
        t.objectStore('summaries').clear();
        t.objectStore('imports').clear();
        await done(t);
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

      // coverageCellSizeM 은 고정값(CoverageGrid.DEFAULT_CELL_SIZE_M) — database.js 와 같은 규칙
      async getSettings() {
        const cellSize = global.CoverageGrid.DEFAULT_CELL_SIZE_M;
        const defaults = { coverageDepthTiers: DEFAULT_DEPTH_TIERS, coverageCellSizeM: cellSize };
        const saved = (await metaGet('app_settings', {})) || {};
        return {
          ...defaults, ...saved,
          coverageCellSizeM: cellSize,
          coverageDepthTiers: (Array.isArray(saved.coverageDepthTiers) && saved.coverageDepthTiers.length)
            ? saved.coverageDepthTiers : defaults.coverageDepthTiers,
        };
      },

      async setSettings(partial) {
        const { coverageCellSizeM, ...merged } = { ...(await this.getSettings()), ...(partial || {}) };
        await metaSet('app_settings', merged);
        return this.getSettings();
      },

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
        await scan(null, r => {
          if (box && box.minLat != null && (r.lat < box.minLat - marginLatDeg || r.lat > box.maxLat + marginLatDeg)) return;
          if (box && box.minLng != null && (r.lng < box.minLng - marginLngDeg || r.lng > box.maxLng + marginLngDeg)) return;
          if (box && !matches(r, box)) return; // 날짜 범위/구역/차량 — database.js getCellVisitCounts 와 같은 조건
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

      async listImports(limit) {
        const db = await ready();
        const t = db.transaction(['imports'], 'readonly');
        const rows = await reqp(t.objectStore('imports').getAll());
        return rows.sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, limit || 200);
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
          imports: await this.listImports(1000),
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
          await this.setSettings(payload.settings);
        }
        if (Array.isArray(payload.backupHistory)) {
          const current = mode === 'replace' ? [] : await this.getBackupHistory();
          await this.setBackupHistory(global.dedupeBackupHistory([...payload.backupHistory, ...current]));
        }
        return { ...result, mode };
      },
    };
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
    'saveZoneManualCells', 'setSettings', 'restoreBackupPayload',
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
