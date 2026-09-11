// ══════════════════════════════════════════════════════════
//  database.js — Route Viewer 영구 저장소 (SQLite)
//
//  핵심 원칙:
//    새 주행기록 파일을 넣는 것은 "교체"가 아니라 "추가(APPEND/MERGE)"다.
//    기존 날짜의 데이터는 사용자가 "데이터 관리"에서 명시적으로 지우지
//    않는 한 절대 사라지지 않는다.
//
//  중복 제거:
//    record_hash = sha1( date | time | vehicle | lat(6자리) | lng(6자리) )
//    이 값에 UNIQUE 제약을 걸고 INSERT OR IGNORE 로 넣기 때문에,
//    같은 파일을 두 번 넣어도 포인트 수가 2배가 되지 않는다.
//    반대로 같은 날짜라도 GPS record가 다르면(오전/오후 주행) 모두 들어간다.
//
//  대용량 대비:
//    달력·누적지도·통계는 전체 레코드를 메모리로 끌어오지 않고
//    SQL 집계(GROUP BY)로 계산해서 요약만 화면에 넘긴다.
//    수십만 포인트가 쌓여도 화면이 버티도록 하기 위한 구조다.
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('node-sqlite3-wasm');
const CoverageGrid = require('../src/js/coverage-grid.js');

const SCHEMA_VERSION = 2;

// 30초 주기로 찍혀야 할 기록에서 이상을 찾는 기준 (기존 route-viewer와 동일)
const GAP_THRESHOLD_SEC = 90;
const TELEPORT_SPEED_KMH = 150;

// 중복 레코드끼리 값이 갈릴 수 있는 필드 — unique key(date|time|vehicle|lat|lng)에는
// 안 들어가지만 그 외 값이 다르면 "완전 동일"이 아니라 "충돌"로 집계한다.
const COMPARABLE_FIELDS = ['place', 'road', 'weather', 'timeOfDay', 'traffic', 'speed'];

function diffComparableFields(a, b) {
  const diffs = [];
  for (const f of COMPARABLE_FIELDS) {
    const av = a && a[f] != null ? String(a[f]) : '';
    const bv = b && b[f] != null ? String(b[f]) : '';
    if (av !== bv) diffs.push({ field: f, from: av, to: bv });
  }
  return diffs;
}

// Coverage Depth 등급 — count가 tier.threshold 이상인 것 중 가장 큰 threshold를 쓴다.
// 설정(settings)에서 바꿀 수 있게 기본값을 여기 하나만 둔다.
const DEFAULT_DEPTH_TIERS = [
  { threshold: 0, label: '미수집', color: '#ff6b6b' },
  { threshold: 1, label: '부족', color: '#f5a623' },
  { threshold: 2, label: '보통', color: '#f5d90a' },
  { threshold: 5, label: '충분', color: '#5fd88a' },
];

function tierForCount(tiers, count) {
  const sorted = [...(tiers && tiers.length ? tiers : DEFAULT_DEPTH_TIERS)].sort((a, b) => a.threshold - b.threshold);
  let best = sorted[0];
  for (const t of sorted) if (count >= t.threshold) best = t;
  return best;
}

class RouteDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // WAL 은 이 VFS에서 지원되지 않을 수 있어 실패해도 그냥 기본(delete) 모드로 간다.
    try { this.db.run('PRAGMA journal_mode = WAL'); } catch (_) { /* 기본 저널 사용 */ }
    this.db.run('PRAGMA synchronous = NORMAL');
    this._migrate();
  }

  close() {
    try { this.db.close(); } catch (_) { /* 이미 닫혔으면 무시 */ }
  }

  // ── 스키마 ────────────────────────────────────────────
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS driving_records (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        record_hash   TEXT    NOT NULL UNIQUE,
        date          TEXT    NOT NULL,
        time          TEXT    NOT NULL DEFAULT '',
        timestamp     TEXT    NOT NULL DEFAULT '',
        vehicle       TEXT    NOT NULL DEFAULT '',
        zone          TEXT    NOT NULL DEFAULT '',
        place         TEXT    NOT NULL DEFAULT '',
        road          TEXT    NOT NULL DEFAULT '',
        weather       TEXT    NOT NULL DEFAULT '',
        time_of_day   TEXT    NOT NULL DEFAULT '',
        traffic       TEXT    NOT NULL DEFAULT '',
        speed         TEXT    NOT NULL DEFAULT '',
        latitude      REAL    NOT NULL,
        longitude     REAL    NOT NULL,
        source_file   TEXT    NOT NULL DEFAULT '',
        imported_at   TEXT    NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_rec_date    ON driving_records(date, timestamp);
      CREATE INDEX IF NOT EXISTS idx_rec_zone    ON driving_records(zone);
      CREATE INDEX IF NOT EXISTS idx_rec_vehicle ON driving_records(vehicle);
      CREATE INDEX IF NOT EXISTS idx_rec_latlng  ON driving_records(latitude, longitude);

      -- Import History: 파일 하나를 불러올 때마다 한 줄. 원본/추가/중복/충돌 집계와
      -- 충돌 상세(conflicts_json), 대표 차량/거리, Import한 사람을 함께 남긴다.
      CREATE TABLE IF NOT EXISTS imports (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        filename          TEXT NOT NULL DEFAULT '',
        file_hash         TEXT NOT NULL DEFAULT '',
        imported_at       TEXT NOT NULL DEFAULT '',
        imported_by       TEXT NOT NULL DEFAULT '',
        dates             TEXT NOT NULL DEFAULT '',
        vehicle           TEXT NOT NULL DEFAULT '',
        distance_km       REAL NOT NULL DEFAULT 0,
        total_records     INTEGER NOT NULL DEFAULT 0,
        inserted_records  INTEGER NOT NULL DEFAULT 0,
        duplicate_records INTEGER NOT NULL DEFAULT 0,
        conflict_records  INTEGER NOT NULL DEFAULT 0,
        conflicts_json    TEXT NOT NULL DEFAULT '[]'
      );

      -- 예전(v3.0) 구역 경계 저장소 — v3.1부터는 zones.polygon 이 정본이고
      -- 이 테이블은 업그레이드 시 1회 migration 출처로만 쓰인다(그대로 남겨둠, 삭제 안 함).
      CREATE TABLE IF NOT EXISTS zone_polygons (
        zone       TEXT PRIMARY KEY,
        points     TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ''
      );

      -- 차량 설정 — 예전엔 소스코드에 토레스 1~4호가 하드코딩돼 있었다.
      -- name 은 driving_records.vehicle 값과 매칭되는 "기준형"('토레스 3호' 등)이다.
      CREATE TABLE IF NOT EXISTS vehicles (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL UNIQUE,
        display_name TEXT    NOT NULL DEFAULT '',
        color        TEXT    NOT NULL DEFAULT '',
        active       INTEGER NOT NULL DEFAULT 1,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT ''
      );

      -- 지역 설정 — 예전엔 ZONE_CENTERS/ZONE_COLORS 가 하드코딩돼 있었다.
      -- polygon 은 zone_polygons 을 대체하는 정본 저장소(JSON [[lat,lng],...]).
      CREATE TABLE IF NOT EXISTS zones (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        color       TEXT    NOT NULL DEFAULT '',
        center_lat  REAL,
        center_lng  REAL,
        polygon     TEXT    NOT NULL DEFAULT '[]',
        active      INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT ''
      );

      -- 달력용 날짜 요약 캐시. import/삭제 때 해당 날짜만 다시 계산한다.
      CREATE TABLE IF NOT EXISTS date_summaries (
        date         TEXT PRIMARY KEY,
        record_count INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);

    // 예전 버전 DB(imports 테이블에 새 컬럼이 없는 경우) 업그레이드 대비.
    // CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블에 컬럼을 추가해주지 않는다.
    this._ensureColumns('imports', {
      imported_by: "TEXT NOT NULL DEFAULT ''",
      vehicle: "TEXT NOT NULL DEFAULT ''",
      distance_km: 'REAL NOT NULL DEFAULT 0',
      conflict_records: 'INTEGER NOT NULL DEFAULT 0',
      conflicts_json: "TEXT NOT NULL DEFAULT '[]'",
    });

    // 커버리지 갭에서 "이 칸은 원래 도로가 아니다(제외)" / "이 칸은 방문한
    // 걸로 친다(수동 방문)"를 사용자가 직접 지정할 수 있게 하는 수동 오버라이드.
    // {excluded:[[lat,lng],...], visited:[[lat,lng],...]} — 칸의 gy/gx가
    // 아니라 위경도 점으로 저장한다. gy/gx는 GAP_CELL_SIZE_M과 구역의
    // refLat(경계 bbox 중심)에 따라 달라지는데, 위경도 점으로 저장해두면
    // 매번 그 시점의 격자 기준으로 다시 계산해서 항상 정확한 칸에 맞는다.
    this._ensureColumns('zones', {
      manual_cells: "TEXT NOT NULL DEFAULT '{}'",
    });

    this._seedDefaults();
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  _ensureColumns(table, columns) {
    const existing = new Set(this.db.all(`PRAGMA table_info(${table})`).map(r => r.name));
    for (const [name, def] of Object.entries(columns)) {
      if (!existing.has(name)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }

  // 차량/지역 하드코딩 목록을 설정 테이블로 최초 1회 migration 한다.
  // 이미 그려둔 구역 경계(zone_polygons)가 있으면 그대로 zones.polygon 으로 옮긴다.
  _seedDefaults() {
    if (!this.getMeta('vehicles_seeded')) {
      const defaults = [
        { name: '토레스 1호', color: '#9ca3af' },
        { name: '토레스 2호', color: '#f97316' },
        { name: '토레스 3호', color: '#8b5cf6' },
        { name: '토레스 4호', color: '#a3e635' },
      ];
      const now = new Date().toISOString();
      defaults.forEach((v, i) => {
        this.db.run(
          'INSERT OR IGNORE INTO vehicles(name, display_name, color, active, sort_order, created_at) VALUES (?,?,?,1,?,?)',
          [v.name, v.name, v.color, i, now]
        );
      });
      this.setMeta('vehicles_seeded', '1');
    }
    if (!this.getMeta('zones_seeded')) {
      const defaults = [
        { name: '강남', color: '#ff7ab6', centerLat: 37.498, centerLng: 127.032 },
        { name: '판교', color: '#ffd93d', centerLat: 37.385, centerLng: 127.115 },
        { name: '시흥', color: '#5ec8f2', centerLat: 37.345, centerLng: 126.730 },
      ];
      const now = new Date().toISOString();
      defaults.forEach((z, i) => {
        let polygon = '[]';
        const legacy = this.db.get('SELECT points FROM zone_polygons WHERE zone = ?', [z.name]);
        if (legacy) {
          try {
            const pts = JSON.parse(legacy.points);
            if (Array.isArray(pts) && pts.length >= 3) polygon = JSON.stringify(pts);
          } catch (_) { /* 저장된 값이 깨졌으면 무시하고 빈 경계로 시작 */ }
        }
        this.db.run(
          'INSERT OR IGNORE INTO zones(name, color, center_lat, center_lng, polygon, active, sort_order, created_at) VALUES (?,?,?,?,?,1,?,?)',
          [z.name, z.color, z.centerLat, z.centerLng, polygon, i, now]
        );
      });
      this.setMeta('zones_seeded', '1');
    }

    // 예전 빌드에서 서초를 별도 기본 구역으로 자동 추가했었다. 실제 운영
    // 구역은 "강남" 경계 안에 서초 쪽 도로까지 함께 포함하는 형태라 필요
    // 없다. 처음엔 비활성화만 했었는데(seocho_default_merged_into_gangnam),
    // 그래도 "지역 관리"에 죽은 항목으로 계속 보여서 아예 지운다. 사용자가
    // 직접 경계를 그려 쓰던 서초 구역(색/좌표가 다르거나 경계·수동 셀이
    // 있는 경우)은 건드리지 않는다.
    if (!this.getMeta('seocho_default_removed')) {
      const row = this.db.get(
        `SELECT color, center_lat AS centerLat, center_lng AS centerLng, polygon, manual_cells AS manualCells
           FROM zones WHERE name = ?`,
        ['서초']
      );
      let polygon = [], manualCells = {};
      try { polygon = JSON.parse((row && row.polygon) || '[]'); } catch (_) { polygon = []; }
      try { manualCells = JSON.parse((row && row.manualCells) || '{}'); } catch (_) { manualCells = {}; }
      const hasManualCells = !!(
        (Array.isArray(manualCells.excluded) && manualCells.excluded.length) ||
        (Array.isArray(manualCells.visited) && manualCells.visited.length)
      );
      const looksAutoSeeded = row && row.color === '#c084fc'
        && Math.abs((row.centerLat || 0) - 37.4837) < 0.0001
        && Math.abs((row.centerLng || 0) - 127.0324) < 0.0001
        && Array.isArray(polygon) && polygon.length === 0 && !hasManualCells;
      if (looksAutoSeeded) {
        this.db.run('DELETE FROM zones WHERE name=?', ['서초']);
      }
      this.setMeta('seocho_default_removed', '1');
    }
  }

  // ── 메타 ──────────────────────────────────────────────
  getMeta(key, fallback = null) {
    const row = this.db.get('SELECT value FROM app_meta WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  setMeta(key, value) {
    this.db.run(
      'INSERT INTO app_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
  }

  // ── 레코드 정규화 / 해시 ──────────────────────────────
  static normalize(raw) {
    const s = v => (v === undefined || v === null ? '' : String(v).trim());
    const lat = Number(raw.lat !== undefined ? raw.lat : raw.latitude);
    const lng = Number(raw.lng !== undefined ? raw.lng : raw.longitude);
    if (!isFinite(lat) || !isFinite(lng)) return null;

    const date = s(raw.date) || '날짜미상';
    const time = s(raw.time);
    const vehicle = s(raw.vehicle);
    return {
      date,
      time,
      timestamp: `${date}T${time || '00:00:00'}`,
      vehicle,
      zone: s(raw.zone),
      place: s(raw.place),
      road: s(raw.road),
      weather: s(raw.weather),
      timeOfDay: s(raw.timeOfDay !== undefined ? raw.timeOfDay : raw.time_of_day),
      traffic: s(raw.traffic),
      speed: s(raw.speed),
      lat,
      lng,
    };
  }

  // 사용자가 지정한 unique key: date | time | vehicle | lat | lng
  // 부동소수 표기가 흔들리지 않도록 좌표는 소수점 6자리로 고정해서 넣는다.
  static hashOf(rec) {
    const key = [
      rec.date,
      rec.time,
      rec.vehicle,
      rec.lat.toFixed(6),
      rec.lng.toFixed(6),
    ].join('|');
    return crypto.createHash('sha1').update(key, 'utf8').digest('hex');
  }

  static hashFile(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
  }

  // ══════════════════════════════════════════════════════
  //  IMPORT — 추가/병합. 기존 데이터는 절대 지우지 않는다.
  //
  //  중복 판정 key: date | time | vehicle | lat(6자리) | lng(6자리)
  //  (record_hash UNIQUE 제약으로 강제된다)
  //
  //  같은 key인데 다른 필드(speed 등)가 다르면 "완전 동일"이 아니라
  //  "충돌(conflict)"로 별도 집계한다 — 대표 레코드(먼저 들어온 것)는
  //  유지하고, 무엇이 달랐는지는 conflictDetails 에 남긴다.
  // ══════════════════════════════════════════════════════
  importRecords(records, meta = {}) {
    const filename = String(meta.filename || '');
    const fileHash = String(meta.fileHash || '');
    const importedAt = meta.importedAt || new Date().toISOString();
    const importedBy = String(meta.importedBy || '');

    const normalized = [];
    let skipped = 0;
    for (const raw of records || []) {
      const rec = RouteDatabase.normalize(raw);
      if (!rec) { skipped++; continue; }
      normalized.push(rec);
    }

    const dates = new Set();
    let inserted = 0;
    const conflicts = [];
    // 이번 import 배치 안에서 처음 만난 hash의 비교값 캐시 — 매번 DB를 다시
    // 조회하지 않고도 "파일 안 중복"과 "DB 기존 중복"을 똑같은 방식으로 비교한다.
    const representative = new Map();

    this.db.run('BEGIN');
    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO driving_records
          (record_hash, date, time, timestamp, vehicle, zone, place, road,
           weather, time_of_day, traffic, speed, latitude, longitude,
           source_file, imported_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const selectStmt = this.db.prepare(
        `SELECT place, road, weather, time_of_day AS timeOfDay, traffic, speed
           FROM driving_records WHERE record_hash = ?`
      );
      try {
        for (const r of normalized) {
          const hash = RouteDatabase.hashOf(r);
          dates.add(r.date);
          const comparable = {
            place: r.place, road: r.road, weather: r.weather,
            timeOfDay: r.timeOfDay, traffic: r.traffic, speed: r.speed,
          };

          let existing = representative.get(hash);
          if (existing === undefined) {
            const row = selectStmt.get([hash]);
            existing = row || null;
          }

          if (!existing) {
            insertStmt.run([
              hash, r.date, r.time, r.timestamp, r.vehicle, r.zone, r.place, r.road,
              r.weather, r.timeOfDay, r.traffic, r.speed, r.lat, r.lng,
              filename, importedAt,
            ]);
            inserted++;
            representative.set(hash, comparable);
          } else {
            representative.set(hash, existing);
            const diffs = diffComparableFields(existing, comparable);
            if (diffs.length) {
              conflicts.push({
                date: r.date, time: r.time, vehicle: r.vehicle, lat: r.lat, lng: r.lng, diffs,
              });
            }
          }
        }
      } finally {
        insertStmt.finalize();
        selectStmt.finalize();
      }

      const duplicates = normalized.length - inserted; // 파일내 중복 + DB 기존 중복
      const distanceKm = fileDistanceKm(normalized);
      const vehicle = mostFrequent(normalized.map(r => r.vehicle).filter(Boolean));

      this.db.run(
        `INSERT INTO imports
           (filename, file_hash, imported_at, imported_by, dates, vehicle, distance_km,
            total_records, inserted_records, duplicate_records, conflict_records, conflicts_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [filename, fileHash, importedAt, importedBy, [...dates].sort().join(','), vehicle, distanceKm,
          normalized.length, inserted, duplicates, conflicts.length, JSON.stringify(conflicts.slice(0, 500))]
      );
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    // 영향 받은 날짜의 요약만 다시 계산
    for (const d of dates) this._rebuildDateSummary(d);

    const duplicates = normalized.length - inserted;
    return {
      filename,
      dates: [...dates].sort(),
      total: normalized.length,
      inserted,
      duplicates,
      exactDuplicates: duplicates - conflicts.length,
      conflicts: conflicts.length,
      conflictDetails: conflicts,
      skipped,
    };
  }

  // ══════════════════════════════════════════════════════
  //  날짜 요약 (달력용) — 포인트를 화면으로 넘기지 않기 위한 캐시
  // ══════════════════════════════════════════════════════
  _rebuildDateSummary(date) {
    const rows = this.db.all(
      `SELECT time, zone, vehicle, latitude AS lat, longitude AS lng
         FROM driving_records WHERE date = ? ORDER BY timestamp, id`,
      [date]
    );
    if (!rows.length) {
      this.db.run('DELETE FROM date_summaries WHERE date = ?', [date]);
      return;
    }
    const summary = buildDaySummary(rows);
    this.db.run(
      `INSERT INTO date_summaries(date, record_count, summary_json) VALUES(?,?,?)
       ON CONFLICT(date) DO UPDATE SET record_count = excluded.record_count,
                                       summary_json = excluded.summary_json`,
      [date, rows.length, JSON.stringify(summary)]
    );
  }

  rebuildAllSummaries() {
    const dates = this.db.all('SELECT DISTINCT date FROM driving_records');
    this.db.run('DELETE FROM date_summaries');
    for (const r of dates) this._rebuildDateSummary(r.date);
    return dates.length;
  }

  // 달력이 쓰는 데이터 — 날짜별 요약만 (포인트 원본 없음)
  listDateSummaries() {
    const rows = this.db.all(
      'SELECT date, record_count, summary_json FROM date_summaries ORDER BY date'
    );
    return rows.map(r => ({
      date: r.date,
      count: r.record_count,
      ...JSON.parse(r.summary_json || '{}'),
    }));
  }

  // ══════════════════════════════════════════════════════
  //  조회
  // ══════════════════════════════════════════════════════
  // 하루치 원본 — 리플레이/일자 상세용. 하루는 많아야 수천 건이라 그대로 넘긴다.
  getRecordsByDate(date) {
    const rows = this.db.all(
      `SELECT date, time, vehicle, zone, place, road, weather,
              time_of_day AS timeOfDay, traffic, speed,
              latitude AS lat, longitude AS lng
         FROM driving_records WHERE date = ? ORDER BY timestamp, id`,
      [date]
    );
    return rows;
  }

  _filterSql(filter = {}) {
    const where = [];
    const params = [];
    if (filter.zone && filter.zone !== 'all') { where.push('zone = ?'); params.push(filter.zone); }
    if (filter.date) { where.push('date = ?'); params.push(filter.date); }
    if (filter.fromDate) { where.push('date >= ?'); params.push(filter.fromDate); }
    if (filter.toDate) { where.push('date <= ?'); params.push(filter.toDate); }
    if (filter.vehicleLike) { where.push('vehicle LIKE ?'); params.push('%' + filter.vehicleLike + '%'); }
    return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  // 누적지도/통계 상단 요약
  getOverview(filter = {}) {
    const { clause, params } = this._filterSql(filter);
    const agg = this.db.get(
      `SELECT COUNT(*) AS points, COUNT(DISTINCT date) AS days FROM driving_records ${clause}`,
      params
    ) || { points: 0, days: 0 };
    const zones = this.db.all(
      `SELECT zone AS k, COUNT(*) AS n FROM driving_records ${clause}
       ${clause ? 'AND' : 'WHERE'} zone <> '' GROUP BY zone ORDER BY n DESC`,
      params
    );
    const vehicles = this.db.all(
      `SELECT vehicle AS k, COUNT(*) AS n FROM driving_records ${clause}
       ${clause ? 'AND' : 'WHERE'} vehicle <> '' GROUP BY vehicle ORDER BY n DESC`,
      params
    );
    return {
      points: agg.points,
      days: agg.days,
      zones: zones.map(r => [r.k, r.n]),
      vehicles: vehicles.map(r => [r.k, r.n]),
    };
  }

  // 누적 지도 밀도 격자 — 전체 포인트가 아니라 "칸"만 넘긴다
  getDensityCells(filter = {}, cell = 0.0007) {
    const { clause, params } = this._filterSql(filter);
    const cells = this.db.all(
      `SELECT CAST(ROUND(latitude / ${cell}) AS INTEGER)  AS gy,
              CAST(ROUND(longitude / ${cell}) AS INTEGER) AS gx,
              AVG(latitude)  AS lat,
              AVG(longitude) AS lng,
              COUNT(*)       AS n,
              COUNT(DISTINCT date) AS dateCount
         FROM driving_records ${clause}
        GROUP BY gy, gx`,
      params
    );
    const byKey = new Map();
    for (const c of cells) {
      byKey.set(c.gy + '_' + c.gx, {
        lat: c.lat, lng: c.lng, n: c.n, dateCount: c.dateCount, zones: {}, vehicles: {},
      });
    }
    const zoneRows = this.db.all(
      `SELECT CAST(ROUND(latitude / ${cell}) AS INTEGER)  AS gy,
              CAST(ROUND(longitude / ${cell}) AS INTEGER) AS gx,
              zone AS k, COUNT(*) AS n
         FROM driving_records ${clause}
         ${clause ? 'AND' : 'WHERE'} zone <> ''
        GROUP BY gy, gx, zone`,
      params
    );
    for (const r of zoneRows) {
      const c = byKey.get(r.gy + '_' + r.gx);
      if (c) c.zones[r.k] = r.n;
    }
    const vehRows = this.db.all(
      `SELECT CAST(ROUND(latitude / ${cell}) AS INTEGER)  AS gy,
              CAST(ROUND(longitude / ${cell}) AS INTEGER) AS gx,
              vehicle AS k, COUNT(*) AS n
         FROM driving_records ${clause}
         ${clause ? 'AND' : 'WHERE'} vehicle <> ''
        GROUP BY gy, gx, vehicle`,
      params
    );
    for (const r of vehRows) {
      const c = byKey.get(r.gy + '_' + r.gx);
      if (c) c.vehicles[r.k] = r.n;
    }
    return [...byKey.values()];
  }

  getBounds(filter = {}) {
    const { clause, params } = this._filterSql(filter);
    const r = this.db.get(
      `SELECT MIN(latitude) AS minLat, MAX(latitude) AS maxLat,
              MIN(longitude) AS minLng, MAX(longitude) AS maxLng,
              COUNT(*) AS n
         FROM driving_records ${clause}`,
      params
    );
    if (!r || !r.n) return null;
    return { minLat: r.minLat, maxLat: r.maxLat, minLng: r.minLng, maxLng: r.maxLng, count: r.n };
  }

  // 커버리지 갭 — 어떤 격자 칸을 지나갔는지(방문한 칸 키)만 뽑는다.
  // 갭 계산은 "지금까지의 전체 기록" 기준이라 구역 필터를 걸지 않는다.
  getVisitedCellKeys(box) {
    const { latDeg, lngDeg, minLat, maxLat, minLng, maxLng } = box;
    // 화면쪽 paintZoneGapGrid 의 Math.floor(p.lat/latDeg) 와 같은 값이 나와야 한다.
    const rows = this.db.all(
      `SELECT DISTINCT CAST(floor(latitude / ?)  AS INTEGER) AS la,
                       CAST(floor(longitude / ?) AS INTEGER) AS lo
         FROM driving_records
        WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
      [latDeg, lngDeg, minLat, maxLat, minLng, maxLng]
    );
    return rows.map(r => r.la + '_' + r.lo);
  }

  // 통계 분포 — 컬럼별 GROUP BY
  getDistribution(column, filter = {}) {
    const allowed = {
      zone: 'zone', vehicle: 'vehicle', place: 'place', road: 'road',
      weather: 'weather', timeOfDay: 'time_of_day', traffic: 'traffic',
    };
    const col = allowed[column];
    if (!col) throw new Error('unknown distribution column: ' + column);
    const { clause, params } = this._filterSql(filter);
    const rows = this.db.all(
      `SELECT ${col} AS k, COUNT(*) AS n FROM driving_records ${clause}
       ${clause ? 'AND' : 'WHERE'} ${col} <> '' GROUP BY ${col} ORDER BY n DESC`,
      params
    );
    return rows.map(r => [r.k, r.n]);
  }

  // 시간대 컬럼이 비어있는 옛 파일 대비 — 시각을 4시간 구간으로 묶은 분포
  getTimeBucketDistribution(filter = {}) {
    const { clause, params } = this._filterSql(filter);
    const rows = this.db.all(
      `SELECT SUBSTR(time, 1, 2) AS hh, COUNT(*) AS n FROM driving_records ${clause}
       ${clause ? 'AND' : 'WHERE'} time <> '' GROUP BY hh`,
      params
    );
    const buckets = {};
    for (const r of rows) {
      const h = parseInt(r.hh, 10);
      if (isNaN(h) || h < 0 || h > 23) continue;
      const start = Math.floor(h / 4) * 4;
      const p = n => String(n).padStart(2, '0');
      const key = `${p(start)}-${p(start + 4)}시`;
      buckets[key] = (buckets[key] || 0) + r.n;
    }
    const ORDER = ['00-04시', '04-08시', '08-12시', '12-16시', '16-20시', '20-24시'];
    return ORDER.filter(k => buckets[k]).map(k => [k, buckets[k]]);
  }

  // 통계 탭의 차량 필터는 '토레스 3호' 로 고르고 파일에는 '토레스 3호차' 로 들어있다
  getVehicleDistribution(filter = {}) {
    return this.getDistribution('vehicle', filter);
  }

  // ══════════════════════════════════════════════════════
  //  삭제 — 오직 명시적인 요청으로만
  // ══════════════════════════════════════════════════════
  deleteDate(date) {
    const before = this.db.get('SELECT COUNT(*) AS n FROM driving_records WHERE date = ?', [date]).n;
    this.db.run('DELETE FROM driving_records WHERE date = ?', [date]);
    this.db.run('DELETE FROM date_summaries WHERE date = ?', [date]);
    return { date, removed: before };
  }

  deleteAll() {
    const before = this.db.get('SELECT COUNT(*) AS n FROM driving_records').n;
    this.db.run('DELETE FROM driving_records');
    this.db.run('DELETE FROM date_summaries');
    this.db.run('DELETE FROM imports');
    return { removed: before };
  }

  // ══════════════════════════════════════════════════════
  //  차량 설정 — 예전 VEHICLE_ORDER/VEHICLE_COLORS 하드코딩을 대체.
  //  driving_records.vehicle 은 자유 텍스트라, 여기 없는 이름이 와도
  //  Import 자체는 항상 성공한다(필터 버튼에만 안 뜬다).
  // ══════════════════════════════════════════════════════
  listVehicles() {
    return this.db.all(
      `SELECT id, name, display_name AS displayName, color, active,
              sort_order AS sortOrder, created_at AS createdAt
         FROM vehicles ORDER BY sort_order, id`
    ).map(r => ({ ...r, active: !!r.active }));
  }

  saveVehicle(v) {
    const name = String((v && v.name) || '').trim();
    if (!name) throw new Error('차량 이름을 입력해주세요.');
    const displayName = String((v && (v.displayName || v.display_name)) || name).trim();
    const color = String((v && v.color) || '').trim();
    const active = v && v.active === false ? 0 : 1;
    const now = new Date().toISOString();
    const existing = this.db.get('SELECT id FROM vehicles WHERE name = ?', [name]);
    if (existing) {
      this.db.run('UPDATE vehicles SET display_name=?, color=?, active=? WHERE name=?',
        [displayName, color, active, name]);
    } else {
      const maxOrder = (this.db.get('SELECT COALESCE(MAX(sort_order),-1) AS m FROM vehicles') || { m: -1 }).m;
      this.db.run(
        'INSERT INTO vehicles(name, display_name, color, active, sort_order, created_at) VALUES (?,?,?,?,?,?)',
        [name, displayName, color, active, maxOrder + 1, now]
      );
    }
    return this.listVehicles().find(x => x.name === name);
  }

  setVehicleActive(name, active) {
    this.db.run('UPDATE vehicles SET active=? WHERE name=?', [active ? 1 : 0, name]);
    return this.listVehicles();
  }

  // ══════════════════════════════════════════════════════
  //  지역 설정 — 예전 ZONE_CENTERS/ZONE_COLORS/ZONE_POLYGONS 하드코딩을 대체.
  //  polygon 이 이제 정본이고, getZonePolygons()/saveZonePolygons() 는
  //  기존 accum.js 호출부가 그대로 동작하도록 이 테이블을 통해 구현한다.
  // ══════════════════════════════════════════════════════
  listZones() {
    return this.db.all(
      `SELECT id, name, color, center_lat AS centerLat, center_lng AS centerLng,
              polygon, active, sort_order AS sortOrder, created_at AS createdAt
         FROM zones ORDER BY sort_order, id`
    ).map(r => {
      let polygon = [];
      try {
        const p = JSON.parse(r.polygon || '[]');
        if (Array.isArray(p)) polygon = p;
      } catch (_) { /* 저장값이 깨졌으면 빈 경계로 취급 */ }
      return { ...r, polygon, active: !!r.active };
    });
  }

  saveZone(z) {
    const name = String((z && z.name) || '').trim();
    if (!name) throw new Error('지역 이름을 입력해주세요.');
    const color = String((z && z.color) || '').trim();
    const centerLat = z && z.centerLat != null ? Number(z.centerLat) : null;
    const centerLng = z && z.centerLng != null ? Number(z.centerLng) : null;
    const active = z && z.active === false ? 0 : 1;
    const now = new Date().toISOString();
    const existing = this.db.get('SELECT id, polygon FROM zones WHERE name = ?', [name]);
    const polygonJson = Array.isArray(z && z.polygon) && z.polygon.length >= 3
      ? JSON.stringify(z.polygon)
      : (existing ? existing.polygon : '[]');
    if (existing) {
      this.db.run('UPDATE zones SET color=?, center_lat=?, center_lng=?, active=?, polygon=? WHERE name=?',
        [color, centerLat, centerLng, active, polygonJson, name]);
    } else {
      const maxOrder = (this.db.get('SELECT COALESCE(MAX(sort_order),-1) AS m FROM zones') || { m: -1 }).m;
      this.db.run(
        'INSERT INTO zones(name, color, center_lat, center_lng, polygon, active, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [name, color, centerLat, centerLng, polygonJson, active, maxOrder + 1, now]
      );
    }
    return this.listZones().find(x => x.name === name);
  }

  setZoneActive(name, active) {
    this.db.run('UPDATE zones SET active=? WHERE name=?', [active ? 1 : 0, name]);
    return this.listZones();
  }

  // 기존 accum.js 는 ZONE_POLYGONS 를 {zone:[[lat,lng],...]} 통짜 객체로
  // 주고받는다 — 그 계약을 그대로 zones 테이블 위에서 구현한다.
  getZonePolygons() {
    const out = {};
    this.listZones().forEach(z => { if (z.polygon && z.polygon.length >= 3) out[z.name] = z.polygon; });
    return out;
  }

  // "전체 교체" 의미론 — dict에 없는(=지워진) 구역은 경계를 비운다.
  // (기존 clearZoneBoundary() 가 이 방식에 의존한다)
  saveZonePolygons(polygons) {
    const dict = polygons || {};
    const zones = this.listZones();
    zones.forEach(z => {
      const pts = dict[z.name];
      const polygonJson = (Array.isArray(pts) && pts.length >= 3) ? JSON.stringify(pts) : '[]';
      this.db.run('UPDATE zones SET polygon=? WHERE name=?', [polygonJson, z.name]);
    });
    const known = new Set(zones.map(z => z.name));
    Object.keys(dict).forEach(name => {
      if (known.has(name)) return;
      const pts = dict[name];
      if (Array.isArray(pts) && pts.length >= 3) this.saveZone({ name, polygon: pts });
    });
    return this.getZonePolygons();
  }

  // 커버리지 갭 수동 오버라이드 — "이 칸은 도로가 아니다(excluded)" /
  // "이 칸은 방문한 걸로 친다(visited)". accum.js가 위경도 점 배열로
  // 주고받고, 매 렌더링 시점의 격자 기준으로 gy/gx를 다시 계산한다.
  getZoneManualCells(name) {
    const row = this.db.get('SELECT manual_cells FROM zones WHERE name = ?', [name]);
    if (!row) return { excluded: [], visited: [] };
    try {
      const data = JSON.parse(row.manual_cells || '{}');
      return {
        excluded: Array.isArray(data.excluded) ? data.excluded : [],
        visited: Array.isArray(data.visited) ? data.visited : [],
      };
    } catch (_) { return { excluded: [], visited: [] }; }
  }

  saveZoneManualCells(name, data) {
    const excluded = Array.isArray(data && data.excluded) ? data.excluded : [];
    const visited = Array.isArray(data && data.visited) ? data.visited : [];
    this.db.run('UPDATE zones SET manual_cells=? WHERE name=?',
      [JSON.stringify({ excluded, visited }), name]);
    return this.getZoneManualCells(name);
  }

  // ══════════════════════════════════════════════════════
  //  설정 — Coverage Depth 등급 기준 등 (item 13, 21)
  // ══════════════════════════════════════════════════════
  getSettings() {
    const defaults = { coverageDepthTiers: DEFAULT_DEPTH_TIERS, coverageCellSizeM: 50 };
    try {
      const saved = JSON.parse(this.getMeta('app_settings', '{}')) || {};
      return {
        ...defaults,
        ...saved,
        coverageDepthTiers: (Array.isArray(saved.coverageDepthTiers) && saved.coverageDepthTiers.length)
          ? saved.coverageDepthTiers : defaults.coverageDepthTiers,
      };
    } catch (_) { return defaults; }
  }

  setSettings(partial) {
    const merged = { ...this.getSettings(), ...(partial || {}) };
    this.setMeta('app_settings', JSON.stringify(merged));
    return merged;
  }

  listImports(limit = 200) {
    return this.db.all(
      `SELECT id, filename, file_hash AS fileHash, imported_at AS importedAt,
              imported_by AS importedBy, dates, vehicle, distance_km AS distanceKm,
              total_records AS total, inserted_records AS inserted,
              duplicate_records AS duplicates, conflict_records AS conflicts
         FROM imports ORDER BY id DESC LIMIT ?`,
      [limit]
    );
  }

  // Import History의 "[상세]" — 그 import에서 값이 갈렸던 레코드 목록
  getImportConflicts(importId) {
    const row = this.db.get('SELECT conflicts_json AS json FROM imports WHERE id = ?', [importId]);
    if (!row) return [];
    try { return JSON.parse(row.json || '[]'); } catch (_) { return []; }
  }

  findImportByFileHash(fileHash) {
    if (!fileHash) return null;
    return this.db.get(
      'SELECT filename, imported_at AS importedAt FROM imports WHERE file_hash = ? ORDER BY id DESC LIMIT 1',
      [fileHash]
    ) || null;
  }

  // ══════════════════════════════════════════════════════
  //  Coverage — 셀 방문 횟수(연속 방문은 1회로 묶음)
  //
  //  같은 (date, vehicle) 안에서 시간순으로 셀이 바뀔 때만 "새 방문"으로
  //  센다. GPS가 한 칸에서 100개 찍혀도 연속이면 방문 1회다.
  //
  //  GPS는 보통 ~10초 간격이라, 두 GPS 사이(예: 120m 이동)의 중간 칸들은
  //  예전엔 아예 방문으로 안 잡혔다(시작/끝 칸만 SQL이 셈). 이제
  //  CoverageGrid(coverage-grid.js, DB/화면 공용)가 두 점 사이 실제 이동
  //  segment가 지나가는 모든 칸을 계산해서 채운다 — 그래서 SQL만으로는
  //  안 되고, 정렬된 레코드를 가져와 (date,vehicle) 파티션별로 나눠
  //  CoverageGrid에 넘긴다. 이동 판정(그 사이를 이을지)은 시간차·속도
  //  조건을 만족할 때만 하고, 아니면(기록 유실/좌표 점프) 점 하나만 남긴다
  //  — 자세한 규칙은 coverage-grid.js 주석 참고.
  // ══════════════════════════════════════════════════════
  getCellVisitCounts(box, cellSizeM) {
    const size = cellSizeM || (this.getSettings().coverageCellSizeM || 50);
    const latDeg = size / 111320;
    const refLat = (box && box.refLat) || 37.5;
    const lngDeg = box && box.lngDeg ? box.lngDeg : size / (111320 * Math.cos(refLat * Math.PI / 180));

    // segment 연결을 허용하는 최대 거리(최대속도×최대시간차)만큼 쿼리
    // bbox를 넉넉히 넓힌다 — bbox 경계에서 살짝 벗어난 이웃 점이 잘려서
    // "시간상 바로 다음 기록인데 마치 그 사이 뭔가 빠진 것처럼" 오판되는
    // 일이 없도록 한다(그 이웃 점 자체가 결과 bbox 밖이라 화면엔 안 그려
    // 지지만, 그 점까지의 segment 판정에는 필요하다).
    const marginM = (CoverageGrid.MAX_INTERPOLATION_SPEED_KMH / 3.6) * CoverageGrid.MAX_INTERPOLATION_GAP_SEC;
    const marginLatDeg = marginM / 111320;
    const marginLngDeg = marginM / (111320 * Math.cos(refLat * Math.PI / 180));

    const where = [];
    const params = [];
    if (box && box.minLat != null) { where.push('latitude BETWEEN ? AND ?'); params.push(box.minLat - marginLatDeg, box.maxLat + marginLatDeg); }
    if (box && box.minLng != null) { where.push('longitude BETWEEN ? AND ?'); params.push(box.minLng - marginLngDeg, box.maxLng + marginLngDeg); }
    if (box && box.zone && box.zone !== 'all') { where.push('zone = ?'); params.push(box.zone); }
    if (box && box.date) { where.push('date = ?'); params.push(box.date); }
    if (box && box.fromDate) { where.push('date >= ?'); params.push(box.fromDate); }
    if (box && box.toDate) { where.push('date <= ?'); params.push(box.toDate); }
    if (box && box.vehicleLike) { where.push('vehicle LIKE ?'); params.push('%' + box.vehicleLike + '%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = this.db.all(
      `SELECT date, vehicle, timestamp, latitude, longitude
         FROM driving_records ${whereSql}
        ORDER BY date, vehicle, timestamp, id`,
      params
    );

    const partitions = new Map();
    rows.forEach(r => {
      const key = r.date + '|' + r.vehicle;
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push({ lat: r.latitude, lng: r.longitude, timestamp: r.timestamp });
    });

    const visitCounts = new Map();
    partitions.forEach(points => {
      CoverageGrid.accumulatePartitionVisits(points, latDeg, lngDeg, visitCounts);
    });

    return [...visitCounts.entries()].map(([k, v]) => {
      const [gy, gx] = k.split('_').map(Number);
      return { gy, gx, visits: v };
    });
  }

  getBackupHistory() {
    try { return JSON.parse(this.getMeta('backup_history', '[]')) || []; } catch (_) { return []; }
  }

  setBackupHistory(history) {
    this.setMeta('backup_history', JSON.stringify(Array.isArray(history) ? history.slice(0, 10) : []));
  }

  // ── 서버 동기화 설정 ────────────────────────────────
  // 이 값들은 server.js 를 띄운 주소를 기억해뒀다가, "지금 동기화"를
  // 누르면(또는 시작할 때 자동으로) 서버와 기록을 주고받는 데 쓴다.
  // 같은 주소는 앱 자동 업데이트 배포 주소로도 함께 쓰인다(<주소>/updates).
  getSyncConfig() {
    try { return JSON.parse(this.getMeta('sync_config', '{}')) || {}; } catch (_) { return {}; }
  }

  setSyncConfig(config) {
    const clean = {
      serverUrl: String((config && config.serverUrl) || '').trim(),
      token: String((config && config.token) || '').trim(),
      autoSyncOnStart: !!(config && config.autoSyncOnStart),
      lastSyncAt: (config && config.lastSyncAt) || this.getSyncConfig().lastSyncAt || null,
    };
    this.setMeta('sync_config', JSON.stringify(clean));
    return clean;
  }

  getStats() {
    const r = this.db.get(
      'SELECT COUNT(*) AS points, COUNT(DISTINCT date) AS days FROM driving_records'
    ) || { points: 0, days: 0 };
    let bytes = 0;
    try { bytes = fs.statSync(this.dbPath).size; } catch (_) { /* 아직 파일이 없을 수 있음 */ }
    return {
      points: r.points,
      days: r.days,
      imports: (this.db.get('SELECT COUNT(*) AS n FROM imports') || { n: 0 }).n,
      dbPath: this.dbPath,
      dbBytes: bytes,
    };
  }

  // 백업 payload — 기존 route-viewer-backup 포맷과 호환되게 data{날짜:[포인트]} 유지.
  // vehicles/zones/settings 는 v3.1부터 추가된 필드다(요구사항 23) — 이 필드가
  // 없는 v2/v3.0 백업을 복구해도 restoreBackupPayload 가 그냥 건너뛰므로 안전하다.
  buildBackupPayload() {
    const dates = this.db.all('SELECT DISTINCT date FROM driving_records ORDER BY date');
    const data = {};
    for (const { date } of dates) data[date] = this.getRecordsByDate(date);
    return {
      type: 'route-viewer-backup',
      version: 3,
      exportedAt: new Date().toISOString(),
      dateCount: dates.length,
      data,
      zonePolygons: this.getZonePolygons(),
      vehicles: this.listVehicles(),
      zones: this.listZones(),
      settings: this.getSettings(),
      backupHistory: this.getBackupHistory(),
      imports: this.listImports(1000),
    };
  }

  // mode: 'merge'(병합 복구) | 'replace'(전체 교체 복구)
  //
  // vehicles/zones/settings 는 mode 와 무관하게 항상 upsert(추가/갱신)만 한다 —
  // "전체 교체"가 지워도 되는 건 주행 데이터뿐이고, 설정을 지우면 그 설정을
  // 쓰던 다른 기록의 필터/색상이 갑자기 사라지는 놀라움이 생기기 때문이다.
  restoreBackupPayload(payload, mode = 'merge') {
    if (!payload || payload.type !== 'route-viewer-backup' || !payload.data || typeof payload.data !== 'object') {
      throw new Error('invalid backup payload');
    }
    if (mode === 'replace') this.deleteAll();

    const flat = [];
    for (const [date, rows] of Object.entries(payload.data)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) flat.push({ ...row, date: row.date || date });
    }
    const result = this.importRecords(flat, {
      filename: '(백업 복구)',
      fileHash: '',
      importedAt: payload.exportedAt || new Date().toISOString(),
    });

    if (payload.zonePolygons && typeof payload.zonePolygons === 'object') {
      const merged = mode === 'replace' ? {} : this.getZonePolygons();
      for (const [zone, pts] of Object.entries(payload.zonePolygons)) {
        if (Array.isArray(pts) && pts.length >= 3) merged[zone] = pts;
      }
      this.saveZonePolygons(merged);
    }
    if (Array.isArray(payload.vehicles)) {
      payload.vehicles.forEach(v => { if (v && v.name) this.saveVehicle(v); });
    }
    if (Array.isArray(payload.zones)) {
      payload.zones.forEach(z => { if (z && z.name) this.saveZone(z); });
    }
    if (payload.settings && typeof payload.settings === 'object') {
      this.setSettings(payload.settings);
    }
    if (Array.isArray(payload.backupHistory)) {
      const merged = mode === 'replace'
        ? payload.backupHistory
        : [...payload.backupHistory, ...this.getBackupHistory()];
      this.setBackupHistory(dedupeHistory(merged));
    }
    return { ...result, mode };
  }
}

// ── 하루치 요약 + 품질 검사 (기존 analyzeDayQuality 와 같은 규칙) ──
function timeToSec(t) {
  if (!t) return null;
  const parts = String(t).split(':').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Import 결과 리포트의 "거리" — 그 파일 자체의 레코드를 시간순으로 이었을 때 거리.
// (날짜별 누적 거리와는 별개로, "이 파일 하나가 몇 km짜리 주행이었는지"를 보여준다)
function fileDistanceKm(normalizedRecords) {
  const sorted = [...normalizedRecords].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
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

function buildDaySummary(rows) {
  const zoneCount = {}, vehicleCount = {};
  let minTime = null, maxTime = null;
  let gaps = 0, teleports = 0;
  let distM = 0;

  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    if (p.zone) zoneCount[p.zone] = (zoneCount[p.zone] || 0) + 1;
    if (p.vehicle) vehicleCount[p.vehicle] = (vehicleCount[p.vehicle] || 0) + 1;
    if (p.time) {
      if (minTime === null || p.time < minTime) minTime = p.time;
      if (maxTime === null || p.time > maxTime) maxTime = p.time;
    }
    if (i === 0) continue;
    const prev = rows[i - 1];
    const t1 = timeToSec(prev.time), t2 = timeToSec(p.time);
    let dtSec = null;
    if (t1 != null && t2 != null) {
      dtSec = t2 - t1;
      if (dtSec < 0) dtSec += 86400;
    }
    const d = haversine(prev.lat, prev.lng, p.lat, p.lng);
    distM += d;
    if (dtSec != null && dtSec > GAP_THRESHOLD_SEC) gaps++;
    if (dtSec != null && dtSec > 0 && (d / dtSec) * 3.6 > TELEPORT_SPEED_KMH) teleports++;
    else if (dtSec === 0 && d > 200) teleports++;
  }

  const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return {
    zones: sortDesc(zoneCount),
    vehicles: sortDesc(vehicleCount),
    startTime: minTime,
    endTime: maxTime,
    distanceKm: Math.round(distM / 10) / 100,
    quality: { gaps, teleports, total: gaps + teleports },
  };
}

function dedupeHistory(history) {
  const seen = new Set();
  return (Array.isArray(history) ? history : [])
    .filter(h => h && h.at)
    .map(h => ({ kind: String(h.kind || '백업 기록'), at: String(h.at), detail: String(h.detail || '') }))
    .filter(h => {
      const k = `${h.kind}|${h.at}|${h.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0))
    .slice(0, 10);
}

module.exports = { RouteDatabase, buildDaySummary, dedupeHistory, haversine, timeToSec };
