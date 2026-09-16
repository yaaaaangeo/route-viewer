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
const CollectionStats = require('../src/js/collection-stats.js');
const TimeConditions = require('../src/js/time-conditions.js');
const ConditionStats = require('../src/js/condition-stats.js');
const Recommendation = require('../src/js/recommendation.js');
const IssueFilter = require('../src/js/issue-filter.js');

const SCHEMA_VERSION = 2;

// 날짜 범위(fromDate/toDate) 조건은 'YYYY-MM-DD' 형식 날짜에만 건다 — '날짜미상'은
// 문자열 비교로 모든 날짜보다 커서, 예전엔 "시작일만" 필터에 끼어들었다.
// (src/js/storage.js 의 IndexedDB matches() 와 같은 규칙)
const DATE_ONLY_SQL = "date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

// ── 이슈 데이터 필터(SQL) ─────────────────────────────
// 의미는 src/js/issue-filter.js 한 곳에서 정의하고, 여기서는 같은 규칙을 EXISTS 로 옮긴다.
// (IndexedDB 는 같은 규칙을 IssueFilter.maskMatches 로 판정한다 — 두 저장소 결과가 같아야 한다)
const ISSUE_OPEN_COND = "i.has_issue = 1 AND i.issue_status = 'open'";
const ISSUE_ANY_COND = 'i.has_issue = 1';
const ISSUE_NON_OPEN_COND = "(i.has_issue = 0 OR i.issue_status <> 'open')";
// ⚠ 성능: 레코드마다 출처를 EXISTS 로 훑으면 10만 건에서 한 번에 7초씩 걸렸다(실측).
// 그래서 레코드의 출처 마스크를 driving_records.issue_mask 에 저장해 두고(Import·이슈 수정 때
// 그 파일의 레코드만 다시 계산), 조회는 비트 연산만 한다. 뜻은 issue-filter.js 와 같다.
//   1 NON_ISSUE · 2 OPEN · 4 RESOLVED · 0 출처 기록 없음(예전 데이터)
const ISSUE_MASK_COL = 'driving_records.issue_mask';

function issueFilterSql(filter, hasIssueImports) {
  const f = IssueFilter.normalizeFilter(filter);
  // 이슈로 표시한 파일이 하나도 없으면 전체 = 이슈 없음이고 이슈 데이터는 0건이다
  if (hasIssueImports === false) return f === 'issue_all' ? '0' : '';
  switch (f) {
    // 확인 필요 이슈 파일에만 연결된 레코드를 뺀다(정상·확인 완료 출처가 있으면 남긴다, 출처 없는 예전 데이터도 남긴다)
    case 'clean': return `(${ISSUE_MASK_COL} = 0 OR (${ISSUE_MASK_COL} & ${IssueFilter.MASK.NON_ISSUE | IssueFilter.MASK.RESOLVED}) <> 0)`;
    case 'issue_all': return `(${ISSUE_MASK_COL} & ${IssueFilter.MASK.OPEN | IssueFilter.MASK.RESOLVED}) <> 0`;
    default: return '';
  }
}

// 그 레코드가 이슈 파일에서 왔는지(누적 지도에서 회색으로 그릴 칸을 세는 데 쓴다)
const ISSUE_RECORD_SQL = `((${ISSUE_MASK_COL} & ${IssueFilter.MASK.OPEN | IssueFilter.MASK.RESOLVED}) <> 0)`;

// 저장해 둔 마스크를 다시 계산하는 식 — Import 직후와 이슈 수정 직후에만 돌린다(그 파일의 레코드만).
const ISSUE_MASK_RECOMPUTE = `COALESCE((
    SELECT SUM(DISTINCT CASE WHEN i.has_issue = 1 AND i.issue_status = 'open' THEN 2
                             WHEN i.has_issue = 1 THEN 4 ELSE 1 END)
      FROM record_sources rs JOIN imports i ON i.id = rs.import_id
     WHERE rs.record_hash = driving_records.record_hash), 0)`;

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
    this._migrateSummaries();
  }

  // 날짜 요약 형식이 바뀌면(CollectionStats.SUMMARY_VERSION) 앱을 처음 켤 때 한 번 전체를 다시 만든다.
  // 형식은 같아도 분류 기준(교통 시간대·일출/일몰 범위)이 요약을 만들 때와 다르면 — 설정을 바꾸고
  // 재분류가 끝나기 전에 앱을 껐던 경우 — 그 날짜들만 이어서 다시 만든다.
  _migrateSummaries() {
    const version = String(CollectionStats.SUMMARY_VERSION);
    if (this.getMeta('summary_version') !== version) {
      this.rebuildAllSummaries();
      this.setMeta('summary_version', version);
      return;
    }
    this.reclassifyStaleSummariesSync();
  }

  // 지금 설정 기준의 분류 설정(교통 시간대·일출/일몰 범위·시간대). 저장값이 깨졌으면 기본값.
  _classificationConfig() {
    return TimeConditions.classificationConfig(this.getSettings());
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
        imported_at   TEXT    NOT NULL DEFAULT '',
        -- 이 레코드가 어떤 파일에서 왔는지 요약한 비트(1 이슈 없는 파일 · 2 확인 필요 · 4 확인 완료).
        -- record_sources 를 매번 훑지 않으려고 저장해 둔다(_recomputeIssueMasks 가 관리).
        issue_mask    INTEGER NOT NULL DEFAULT 0
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

      -- GPS 레코드가 "어느 Import 파일에서 나왔는지" — 중복 제거된 레코드도 출처를 잃지 않는다.
      -- 같은 레코드가 여러 파일에 있으면 행이 여러 개 생기고(PRIMARY KEY 로 같은 쌍은 한 번만),
      -- 이슈 필터는 이 관계를 EXISTS 로 훑어서 판정한다(src/js/issue-filter.js 규칙).
      CREATE TABLE IF NOT EXISTS record_sources (
        record_hash TEXT    NOT NULL,
        import_id   INTEGER NOT NULL,
        PRIMARY KEY (record_hash, import_id)
      );

      CREATE INDEX IF NOT EXISTS idx_rs_import ON record_sources(import_id);
    `);

    // 예전 버전 DB(imports 테이블에 새 컬럼이 없는 경우) 업그레이드 대비.
    // CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블에 컬럼을 추가해주지 않는다.
    this._ensureColumns('imports', {
      imported_by: "TEXT NOT NULL DEFAULT ''",
      vehicle: "TEXT NOT NULL DEFAULT ''",
      distance_km: 'REAL NOT NULL DEFAULT 0',
      conflict_records: 'INTEGER NOT NULL DEFAULT 0',
      conflicts_json: "TEXT NOT NULL DEFAULT '[]'",
      // 파일별 이슈 — 예전 DB 의 Import 이력은 "이슈 정보 없음"(has_issue 0)으로 남는다.
      // 출처를 복원할 근거가 없으므로 예전 레코드를 임의의 파일에 연결하지 않는다.
      has_issue: 'INTEGER NOT NULL DEFAULT 0',
      issue_note: "TEXT NOT NULL DEFAULT ''",
      issue_status: "TEXT NOT NULL DEFAULT ''",
      issue_created_at: "TEXT NOT NULL DEFAULT ''",
      issue_updated_at: "TEXT NOT NULL DEFAULT ''",
      issue_conflict_json: "TEXT NOT NULL DEFAULT ''",
    });
    // 이슈 컬럼을 추가한 뒤에 인덱스를 만든다(예전 DB 는 이 컬럼이 없어서 먼저 만들 수 없다)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_imports_issue ON imports(has_issue, issue_status);');

    // 커버리지 갭에서 "이 칸은 원래 도로가 아니다(제외)" / "이 칸은 방문한
    // 걸로 친다(수동 방문)" / "GPS가 지나갔어도 미방문으로 친다(수동 미방문)"를
    // 사용자가 직접 지정할 수 있게 하는 수동 오버라이드.
    // {excluded:[[lat,lng],...], visited:[...], unvisited:[...]} — unvisited는 나중에
    // 추가돼서 예전 행에는 없다(읽을 때 빈 배열로 채움, 별도 마이그레이션 없음). 칸의 gy/gx가
    // 아니라 위경도 점으로 저장한다. gy/gx는 GAP_CELL_SIZE_M과 구역의
    // refLat(경계 bbox 중심)에 따라 달라지는데, 위경도 점으로 저장해두면
    // 매번 그 시점의 격자 기준으로 다시 계산해서 항상 정확한 칸에 맞는다.
    this._ensureColumns('zones', {
      manual_cells: "TEXT NOT NULL DEFAULT '{}'",
    });

    // 예전 DB 에 issue_mask 컬럼을 새로 붙였으면 한 번만 전부 계산해 둔다
    if (this._ensureColumns('driving_records', { issue_mask: 'INTEGER NOT NULL DEFAULT 0' }).added.length) {
      this._recomputeIssueMasks();
    }

    this._seedDefaults();
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  _ensureColumns(table, columns) {
    const existing = new Set(this.db.all(`PRAGMA table_info(${table})`).map(r => r.name));
    const added = [];
    for (const [name, def] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      added.push(name);
    }
    return { added };
  }

  // 출처 마스크를 다시 계산한다. importId 를 주면 그 파일에서 나온 레코드만(보통 수천 건),
  // 안 주면 전체(컬럼을 새로 붙인 예전 DB 를 한 번 채울 때만).
  _recomputeIssueMasks(importId) {
    if (importId === undefined) {
      this.db.run(`UPDATE driving_records SET issue_mask = ${ISSUE_MASK_RECOMPUTE}`);
      return;
    }
    this.db.run(
      `UPDATE driving_records SET issue_mask = ${ISSUE_MASK_RECOMPUTE}
        WHERE record_hash IN (SELECT record_hash FROM record_sources WHERE import_id = ?)`,
      [importId]
    );
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
      const hasManualCells = CoverageGrid.hasManualCells(manualCells);
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
    this._issueImportsDirty();   // 이 파일이 이슈일 수도 있다
    const filename = String(meta.filename || '');
    const fileHash = String(meta.fileHash || '');
    const importedAt = meta.importedAt || new Date().toISOString();
    const importedBy = String(meta.importedBy || '');

    const normalized = [];
    let skipped = 0;
    let importId = null;
    for (const raw of records || []) {
      const rec = RouteDatabase.normalize(raw);
      if (!rec) { skipped++; continue; }
      normalized.push(rec);
    }

    const dates = new Set();
    const hashes = new Set();   // 이 파일에서 나온 레코드(신규·중복 모두) — 출처 관계로 남긴다
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
          hashes.add(hash);
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

      // 이슈 입력(파일 하나에 하나) — 체크했는데 메모가 없으면 여기서 던져서 Import 자체를 되돌린다
      const issue = IssueFilter.normalizeIssueForStorage({ hasIssue: meta.hasIssue, issueNote: meta.issueNote, issueStatus: meta.issueStatus });
      const issueAt = issue.hasIssue ? (meta.issueCreatedAt || importedAt) : '';
      this.db.run(
        `INSERT INTO imports
           (filename, file_hash, imported_at, imported_by, dates, vehicle, distance_km,
            total_records, inserted_records, duplicate_records, conflict_records, conflicts_json,
            has_issue, issue_note, issue_status, issue_created_at, issue_updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [filename, fileHash, importedAt, importedBy, [...dates].sort().join(','), vehicle, distanceKm,
          normalized.length, inserted, duplicates, conflicts.length, JSON.stringify(conflicts.slice(0, 500)),
          issue.hasIssue ? 1 : 0, issue.issueNote, issue.issueStatus, issueAt, issue.hasIssue ? (meta.issueUpdatedAt || issueAt) : '']
      );
      importId = (this.db.get('SELECT last_insert_rowid() AS id') || {}).id;
      // 출처 관계 — 중복이라 새로 넣지 않은 레코드도 "이 파일에서도 나왔다"를 남긴다.
      // 같은 (레코드, 파일) 쌍은 PRIMARY KEY 로 한 번만 저장된다.
      // meta.trackSources === false 는 백업 복원처럼 "파일에서 온 게 아닌" 경로다(출처로 남기지 않는다)
      if (meta.trackSources !== false) {
        const sourceStmt = this.db.prepare('INSERT OR IGNORE INTO record_sources(record_hash, import_id) VALUES (?,?)');
        try { hashes.forEach(h => sourceStmt.run([h, importId])); }
        finally { sourceStmt.finalize(); }
        // 출처가 하나 늘어난 것뿐이라 비트를 OR 로 더하면 된다(빼야 할 비트는 없다) —
        // 전체 재계산보다 훨씬 싸다. 상태가 바뀌어 비트가 빠질 수 있는 경우만 _recomputeIssueMasks 를 쓴다.
        this.db.run(
          `UPDATE driving_records SET issue_mask = issue_mask | ?
            WHERE record_hash IN (SELECT record_hash FROM record_sources WHERE import_id = ?)`,
          [IssueFilter.maskBitOf({ hasIssue: issue.hasIssue, issueStatus: issue.issueStatus }), importId]
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    // 영향 받은 날짜의 요약만 다시 계산
    const classification = this._classificationConfig();
    for (const d of dates) this._rebuildDateSummary(d, classification);

    const duplicates = normalized.length - inserted;
    return {
      filename,
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
  }

  // ══════════════════════════════════════════════════════
  //  날짜 요약 (달력용) — 포인트를 화면으로 넘기지 않기 위한 캐시
  // ══════════════════════════════════════════════════════
  // 날짜 요약 한 행을 통째로 다시 쓴다(UPSERT 한 문장) — 중간에 실패해도 그 날짜는
  // 예전 요약 그대로이거나 새 요약이거나 둘 중 하나다. 원본 기록(driving_records)은 건드리지 않는다.
  _rebuildDateSummary(date, classification) {
    const rows = this.db.all(
      `SELECT date, time, zone, vehicle, weather, speed, latitude AS lat, longitude AS lng,
              issue_mask AS issueMask
         FROM driving_records WHERE date = ? ORDER BY timestamp, id`,
      [date]
    );
    if (!rows.length) {
      this.db.run('DELETE FROM date_summaries WHERE date = ?', [date]);
      return;
    }
    const summary = buildDaySummary(rows, classification || this._classificationConfig());
    // 그 날짜 기록이 어느 Import 에서 왔는지 — 달력 배지·일자 요약의 이슈 목록이 쓴다(상태는 조회할 때 합친다)
    summary.importSources = this.db.all(
      `SELECT rs.import_id AS importId, COUNT(*) AS recordCount
         FROM driving_records dr JOIN record_sources rs ON rs.record_hash = dr.record_hash
        WHERE dr.date = ? GROUP BY rs.import_id ORDER BY rs.import_id`,
      [date]
    );
    this.db.run(
      `INSERT INTO date_summaries(date, record_count, summary_json) VALUES(?,?,?)
       ON CONFLICT(date) DO UPDATE SET record_count = excluded.record_count,
                                       summary_json = excluded.summary_json`,
      [date, rows.length, JSON.stringify(summary)]
    );
  }

  rebuildAllSummaries() {
    const dates = this.db.all('SELECT DISTINCT date FROM driving_records');
    const classification = this._classificationConfig();
    this.db.run('DELETE FROM date_summaries');
    for (const r of dates) this._rebuildDateSummary(r.date, classification);
    return dates.length;
  }

  // ══════════════════════════════════════════════════════
  //  조건 분류(교통 시간대·조도) 재분류
  //
  //  분류값은 원본(시각·날짜·GPS)에서 다시 계산할 수 있는 파생값이라 기록에는 저장하지 않는다.
  //  저장되는 곳은 날짜 요약의 conditionCells 뿐이고, 요약마다 그때의 분류 서명
  //  (classificationSignature = 판정 규칙 버전 + 설정값)을 같이 적는다. 설정을 바꾸면 서명이 달라진
  //  날짜 요약만 다시 만든다 — 날짜 하나씩(한 문장 UPSERT) 처리하므로 중간에 실패하거나 앱이 꺼져도
  //  원본 기록은 그대로고, 남은 날짜는 다음 실행 때(_migrateSummaries) 이어서 처리된다.
  // ══════════════════════════════════════════════════════
  _staleSummaryDates(signature) {
    const rows = this.db.all(
      `SELECT date FROM date_summaries
        WHERE COALESCE(json_extract(summary_json, '$.classificationSignature'), '') <> ?
        ORDER BY date`,
      [signature]
    );
    // 기록은 있는데 요약이 없는 날짜(예전 버그/중단)도 함께 채운다
    const missing = this.db.all(
      `SELECT DISTINCT r.date FROM driving_records r
         LEFT JOIN date_summaries s ON s.date = r.date
        WHERE s.date IS NULL`
    );
    return [...new Set([...rows, ...missing].map(r => r.date))].sort();
  }

  getClassificationStatus() {
    const config = this._classificationConfig();
    const signature = TimeConditions.classificationSignature(config);
    const totalDates = (this.db.get('SELECT COUNT(*) AS n FROM date_summaries') || { n: 0 }).n;
    const running = !!this._reclassifyRun;
    return {
      signature,
      totalDates,
      staleDates: this._staleSummaryDates(signature).length,
      running,
      progress: running ? { ...this._reclassifyProgress } : null,
    };
  }

  // 앱 시작·백업 복원·서버 동기화 안에서 쓰는 동기 버전
  reclassifyStaleSummariesSync() {
    const config = this._classificationConfig();
    const signature = TimeConditions.classificationSignature(config);
    const dates = this._staleSummaryDates(signature);
    for (const d of dates) this._rebuildDateSummary(d, config);
    return { rebuilt: dates.length, signature };
  }

  // 설정 화면에서 쓰는 비동기 버전 — 날짜 사이마다 이벤트 루프를 한 번 비워서, 도는 동안에도
  // 화면이 getClassificationStatus()로 진행률을 물어볼 수 있다. 이미 돌고 있으면 같은 작업을 돌려준다.
  reclassifySummaries() {
    if (this._reclassifyRun) return this._reclassifyRun;
    const run = (async () => {
      let rebuilt = 0;
      // 도는 중에 설정이 또 바뀌면 서명이 달라지므로, 남은 날짜가 없을 때까지 반복한다
      for (let pass = 0; pass < 5; pass++) {
        const config = this._classificationConfig();
        const signature = TimeConditions.classificationSignature(config);
        const dates = this._staleSummaryDates(signature);
        if (!dates.length) return { rebuilt, signature };
        this._reclassifyProgress = { done: 0, total: dates.length };
        for (const d of dates) {
          this._rebuildDateSummary(d, config);
          rebuilt++;
          this._reclassifyProgress.done++;
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      return { rebuilt, signature: TimeConditions.classificationSignature(this._classificationConfig()) };
    })();
    this._reclassifyRun = run.finally(() => { this._reclassifyRun = null; this._reclassifyProgress = null; });
    return this._reclassifyRun;
  }

  // 달력이 쓰는 데이터 — 날짜별 요약만 (포인트 원본 없음)
  // 이슈로 표시한 Import 가 하나라도 있는지 — 없으면 이슈 관련 조건을 통째로 건너뛴다.
  // Import·이슈 수정·삭제·복원 때 _issueImportsDirty 로 비운다(그때만 다시 센다).
  hasIssueImports() {
    if (this._hasIssueImports === undefined) {
      this._hasIssueImports = !!(this.db.get('SELECT 1 AS n FROM imports WHERE has_issue = 1 LIMIT 1') || {}).n;
    }
    return this._hasIssueImports;
  }

  _issueImportsDirty() { this._hasIssueImports = undefined; }

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
  // 교통 시간대·조도·요일은 저장값이 아니라 지금 설정으로 그때 계산해서 붙인다(timeOfDay 원본은 그대로).
  getRecordsByDate(date) {
    const rows = this.db.all(
      `SELECT date, time, vehicle, zone, place, road, weather,
              time_of_day AS timeOfDay, traffic, speed,
              latitude AS lat, longitude AS lng, issue_mask AS issueMask
         FROM driving_records WHERE date = ? ORDER BY timestamp, id`,
      [date]
    );
    const classification = this._classificationConfig();
    return rows.map(r => ({ ...r, ...TimeConditions.classifyRecord(r, classification) }));
  }

  _filterSql(filter = {}) {
    const where = [];
    const params = [];
    if (filter.zone && filter.zone !== 'all') { where.push('zone = ?'); params.push(filter.zone); }
    if (filter.date) { where.push('date = ?'); params.push(filter.date); }
    if (filter.fromDate || filter.toDate) where.push(DATE_ONLY_SQL);
    if (filter.fromDate) { where.push('date >= ?'); params.push(filter.fromDate); }
    if (filter.toDate) { where.push('date <= ?'); params.push(filter.toDate); }
    if (filter.vehicleLike) { where.push('vehicle LIKE ?'); params.push('%' + filter.vehicleLike + '%'); }
    const issueSql = issueFilterSql(filter.issueFilter, this.hasIssueImports());
    if (issueSql) where.push(issueSql);
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
              COUNT(DISTINCT date) AS dateCount,
              SUM(CASE WHEN ${ISSUE_RECORD_SQL} THEN 1 ELSE 0 END) AS issueN
         FROM driving_records ${clause}
        GROUP BY gy, gx`,
      params
    );
    const byKey = new Map();
    for (const c of cells) {
      byKey.set(c.gy + '_' + c.gx, {
        lat: c.lat, lng: c.lng, n: c.n, dateCount: c.dateCount, issueN: c.issueN || 0, zones: {}, vehicles: {},
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
    const issueSql = issueFilterSql(box && box.issueFilter, this.hasIssueImports());
    // 화면쪽 paintZoneGapGrid 의 Math.floor(p.lat/latDeg) 와 같은 값이 나와야 한다.
    const rows = this.db.all(
      `SELECT DISTINCT CAST(floor(latitude / ?)  AS INTEGER) AS la,
                       CAST(floor(longitude / ?) AS INTEGER) AS lo
         FROM driving_records
        WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?${issueSql ? ` AND ${issueSql}` : ''}`,
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
    this._issueImportsDirty();
    const before = this.db.get('SELECT COUNT(*) AS n FROM driving_records WHERE date = ?', [date]).n;
    this.db.run('DELETE FROM driving_records WHERE date = ?', [date]);
    this.db.run('DELETE FROM date_summaries WHERE date = ?', [date]);
    // 지운 레코드의 출처 관계도 정리한다(Import 이력과 이슈 메모 자체는 남긴다)
    this.db.run('DELETE FROM record_sources WHERE record_hash NOT IN (SELECT record_hash FROM driving_records)');
    return { date, removed: before };
  }

  deleteAll() {
    this._issueImportsDirty();
    const before = this.db.get('SELECT COUNT(*) AS n FROM driving_records').n;
    this.db.run('DELETE FROM driving_records');
    this.db.run('DELETE FROM date_summaries');
    this.db.run('DELETE FROM imports');
    this.db.run('DELETE FROM record_sources');
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
              polygon, active, sort_order AS sortOrder, created_at AS createdAt,
              manual_cells AS manualCellsJson
         FROM zones ORDER BY sort_order, id`
    ).map(({ manualCellsJson, ...r }) => {
      let polygon = [];
      try {
        const p = JSON.parse(r.polygon || '[]');
        if (Array.isArray(p)) polygon = p;
      } catch (_) { /* 저장값이 깨졌으면 빈 경계로 취급 */ }
      // 백업/동기화 payload(zones[])에 수동 셀도 함께 실리도록 같이 돌려준다
      return { ...r, polygon, active: !!r.active, manualCells: parseManualCells(manualCellsJson) };
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
  // "이 칸은 방문한 걸로 친다(visited)" / "미방문으로 친다(unvisited)".
  // accum.js가 위경도 점 배열로 주고받고, 매 렌더링 시점의 격자 기준으로
  // gy/gx를 다시 계산한다. 반환 형식은 항상 세 배열을 모두 가진다.
  getZoneManualCells(name) {
    const row = this.db.get('SELECT manual_cells FROM zones WHERE name = ?', [name]);
    return parseManualCells(row && row.manual_cells);
  }

  saveZoneManualCells(name, data) {
    const cells = CoverageGrid.normalizeManualCells(data);
    this.db.run('UPDATE zones SET manual_cells=? WHERE name=?', [JSON.stringify(cells), name]);
    return this.getZoneManualCells(name);
  }

  // ══════════════════════════════════════════════════════
  //  설정 — Coverage Depth 등급 기준 등 (item 13, 21)
  // ══════════════════════════════════════════════════════
  // coverageCellSizeM 은 사용자 설정이 아니라 고정값(CoverageGrid.DEFAULT_CELL_SIZE_M)
  // 이다. 예전 버전이 app_settings 에 50을 같이 저장해둔 경우가 있어서, 읽을 때
  // 항상 고정값으로 덮고 저장할 때는 빼고 저장한다.
  // trafficPeriods / sunriseWindowMinutes / sunsetWindowMinutes 는 저장값이 없거나 깨졌으면 기본값으로
  // 채워 돌려준다(TimeConditions.classificationConfig — IndexedDB 백엔드와 같은 규칙).
  getSettings() {
    const defaults = { coverageDepthTiers: DEFAULT_DEPTH_TIERS, coverageCellSizeM: CoverageGrid.DEFAULT_CELL_SIZE_M };
    let saved = {};
    try { saved = JSON.parse(this.getMeta('app_settings', '{}')) || {}; } catch (_) { saved = {}; }
    const classification = TimeConditions.classificationConfig(saved);
    return {
      ...defaults,
      ...saved,
      coverageCellSizeM: CoverageGrid.DEFAULT_CELL_SIZE_M,
      coverageDepthTiers: (Array.isArray(saved.coverageDepthTiers) && saved.coverageDepthTiers.length)
        ? saved.coverageDepthTiers : defaults.coverageDepthTiers,
      trafficPeriods: classification.trafficPeriods,
      sunriseWindowMinutes: classification.sunriseWindowMinutes,
      sunsetWindowMinutes: classification.sunsetWindowMinutes,
      // 추천 주행 설정(가중치·목표 등) — 없거나 깨졌으면 기본값(recommendation.js)
      recommendationSettings: Recommendation.effectiveRecommendationSettings(saved.recommendationSettings),
    };
  }

  // 분류 설정·추천 설정은 저장 전에 검증한다 — 겹침·공백·형식 오류, 가중치 합계가 100%가 아님 등
  // 하나라도 있으면 아무것도 저장하지 않고 이유를 담은 Error 를 던진다. 재분류·추천 재계산은 따로 한다.
  setSettings(partial) {
    const patch = Recommendation.normalizeRecommendationPatch(TimeConditions.normalizeClassificationPatch(partial));
    const { coverageCellSizeM, ...merged } = { ...this.getSettings(), ...patch };
    this.setMeta('app_settings', JSON.stringify(merged));
    return this.getSettings();
  }

  // ══════════════════════════════════════════════════════
  //  추천 주행 — Coverage 스냅샷 · 추천 상태
  //
  //  Coverage 는 도로 데이터(HD map/OSM)가 필요해 누적 지도 화면에서만 계산된다. 계산이 끝나면 화면이
  //  구역별 요약(유효/방문/미방문 Cell)을 여기 저장하고, 추천은 이 스냅샷만 읽는다. 저장할 때 지금의
  //  데이터·경계·수동 셀 지문을 같이 적어 두고, 읽을 때 지문이 다르면 fresh=false(추천 점수에서 제외).
  //  추천 상태(기간 제외·수집 완료 표시)는 실제 주행 기록과 완전히 따로 저장한다 — 기록을 바꾸지 않는다.
  // ══════════════════════════════════════════════════════
  _jsonMeta(key, fallback) {
    try { const v = JSON.parse(this.getMeta(key, 'null')); return v == null ? fallback : v; } catch (_) { return fallback; }
  }

  _coverageFingerprint(zoneName) {
    const summaries = this.db.all('SELECT date, record_count AS count FROM date_summaries');
    return Recommendation.coverageFingerprint(summaries, this.listZones().find(z => z.name === zoneName));
  }

  saveCoverageSnapshot(zoneName, snapshot) {
    const name = String(zoneName || '').trim();
    if (!name) throw new Error('구역 이름이 없어요.');
    const n = v => (Number.isInteger(v) && v >= 0 ? v : null);
    const total = n(snapshot && snapshot.total), visited = n(snapshot && snapshot.visited);
    if (total == null || visited == null || visited > total) throw new Error('Coverage 스냅샷 값이 올바르지 않아요.');
    const all = this._jsonMeta('coverage_snapshots', {});
    all[name] = {
      zone: name, total, visited, unvisited: total - visited,
      coveragePct: total ? (visited / total) * 100 : 0,
      provisional: !!(snapshot && snapshot.provisional),
      cellSizeM: snapshot && Number.isFinite(snapshot.cellSizeM) ? snapshot.cellSizeM : null,
      computedAt: (snapshot && snapshot.computedAt) || new Date().toISOString(),
      fingerprint: this._coverageFingerprint(name),
    };
    this.setMeta('coverage_snapshots', JSON.stringify(all));
    return this.listCoverageSnapshots().find(s => s.zone === name);
  }

  listCoverageSnapshots() {
    const all = this._jsonMeta('coverage_snapshots', {});
    const summaries = this.db.all('SELECT date, record_count AS count FROM date_summaries');
    const zones = this.listZones();
    return Object.values(all).sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0)).map(s => ({
      ...s, ...Recommendation.coverageSnapshotFreshness(s, Recommendation.coverageFingerprint(summaries, zones.find(z => z.name === s.zone))),
    }));
  }

  listRecommendationStates() {
    return this._jsonMeta('recommendation_states', {});
  }

  // state: null(해제) | {status:'snoozed', until:'YYYY-MM-DD'} | {status:'completed', snapshot:{collectionSec, visitCount}}
  setRecommendationState(id, state) {
    const key = String(id || '');
    if (!key) throw new Error('추천 id 가 없어요.');
    const all = this.listRecommendationStates();
    if (state == null) delete all[key];
    else all[key] = normalizeRecommendationState(state);
    this.setMeta('recommendation_states', JSON.stringify(all));
    return all;
  }

  // options: {issueOnly, issueStatus, search, withRelatedRecords} — 데이터 관리의 "이슈만 보기"·파일명/메모 검색.
  // withRelatedRecords 를 켤 때만 파일별 레코드 수를 센다(목록마다 세면 파일이 많아질수록 느려진다)
  listImports(limit = 200, options = {}) {
    const where = [];
    const params = [];
    const o = options || {};
    if (o.issueOnly) where.push('has_issue = 1');
    if (o.issueStatus) { where.push('has_issue = 1 AND issue_status = ?'); params.push(o.issueStatus); }
    if (o.search) { where.push('(filename LIKE ? OR issue_note LIKE ?)'); params.push('%' + o.search + '%', '%' + o.search + '%'); }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = this.db.all(
      `SELECT id, filename, file_hash AS fileHash, imported_at AS importedAt,
              imported_by AS importedBy, dates, vehicle, distance_km AS distanceKm,
              total_records AS total, inserted_records AS inserted,
              duplicate_records AS duplicates, conflict_records AS conflicts,
              has_issue AS hasIssue, issue_note AS issueNote, issue_status AS issueStatus,
              issue_created_at AS issueCreatedAt, issue_updated_at AS issueUpdatedAt,
              issue_conflict_json AS issueConflictJson
              ${o.withRelatedRecords ? ', (SELECT COUNT(*) FROM record_sources rs WHERE rs.import_id = imports.id) AS relatedRecords' : ''}
         FROM imports ${clause} ORDER BY id DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(normalizeImportRow);
  }

  // ══════════════════════════════════════════════════════
  //  Import 이슈 — 메모·상태 수정. 원본 GPS 레코드와 Import 이력은 절대 지우지 않는다.
  //  상태/메모가 바뀌면 그 파일이 관여한 날짜의 요약만 다시 만든다(조건 칸의 이슈 마스크가 달라지므로).
  // ══════════════════════════════════════════════════════
  updateImportIssue(importId, patch) {
    this._issueImportsDirty();
    const row = this.db.get(
      `SELECT id, has_issue AS hasIssue, issue_note AS issueNote, issue_status AS issueStatus,
              issue_created_at AS issueCreatedAt, issue_updated_at AS issueUpdatedAt
         FROM imports WHERE id = ?`, [importId]);
    if (!row) throw new Error('그 Import 이력을 찾지 못했어요.');
    const next = IssueFilter.normalizeIssueForStorage(patch || {}, {
      hasIssue: !!row.hasIssue, issueNote: row.issueNote, issueStatus: row.issueStatus || 'open',
    });
    const now = new Date().toISOString();
    const createdAt = next.hasIssue ? (row.issueCreatedAt || now) : row.issueCreatedAt; // 이슈가 있었던 사실은 지우지 않는다
    this.db.run(
      `UPDATE imports SET has_issue = ?, issue_note = ?, issue_status = ?, issue_created_at = ?, issue_updated_at = ?
        WHERE id = ?`,
      [next.hasIssue ? 1 : 0, next.issueNote, next.issueStatus, createdAt || '', now, importId]
    );
    this._recomputeIssueMasks(importId);   // 상태가 바뀌었으니 그 파일 레코드의 마스크를 다시 계산
    this.rebuildSummariesForImport(importId);
    return this.getImport(importId);
  }

  getImport(importId) {
    const rows = this.db.all(
      `SELECT id, filename, file_hash AS fileHash, imported_at AS importedAt, imported_by AS importedBy,
              dates, vehicle, distance_km AS distanceKm, total_records AS total, inserted_records AS inserted,
              duplicate_records AS duplicates, conflict_records AS conflicts,
              has_issue AS hasIssue, issue_note AS issueNote, issue_status AS issueStatus,
              issue_created_at AS issueCreatedAt, issue_updated_at AS issueUpdatedAt,
              issue_conflict_json AS issueConflictJson,
              (SELECT COUNT(*) FROM record_sources rs WHERE rs.import_id = imports.id) AS relatedRecords
         FROM imports WHERE id = ?`, [importId]);
    return rows.length ? normalizeImportRow(rows[0]) : null;
  }

  // 그 Import 의 기록이 들어 있는 날짜들의 요약만 다시 만든다
  rebuildSummariesForImport(importId) {
    const dates = this.db.all(
      `SELECT DISTINCT dr.date AS date FROM record_sources rs
         JOIN driving_records dr ON dr.record_hash = rs.record_hash
        WHERE rs.import_id = ?`, [importId]);
    const config = this._classificationConfig();
    dates.forEach(d => this._rebuildDateSummary(d.date, config));
    return dates.map(d => d.date);
  }

  // 그 날짜의 기록이 어느 Import 에서 왔는지(이슈 정보 포함) — 일자 요약의 "이슈사항"
  listDateImports(date) {
    const rows = this.db.all(
      `SELECT i.id AS id, i.filename AS filename, i.imported_at AS importedAt, i.imported_by AS importedBy,
              i.vehicle AS vehicle, i.has_issue AS hasIssue, i.issue_note AS issueNote, i.issue_status AS issueStatus,
              i.issue_created_at AS issueCreatedAt, i.issue_updated_at AS issueUpdatedAt,
              i.issue_conflict_json AS issueConflictJson, COUNT(*) AS recordCount
         FROM record_sources rs
         JOIN driving_records dr ON dr.record_hash = rs.record_hash
         JOIN imports i ON i.id = rs.import_id
        WHERE dr.date = ?
        GROUP BY i.id
        ORDER BY i.has_issue DESC, i.issue_status, i.id`, [date]);
    return rows.map(r => ({ ...normalizeImportRow(r), importId: r.id }));
  }

  // 이슈 현황 요약(통계·데이터 관리) — 파일 수와 이슈 레코드 수
  getIssueOverview(filter = {}) {
    const imports = this.listImports(100000, {});
    const summary = IssueFilter.summarizeImports(imports);
    const count = issueFilter => {
      const { clause, params } = this._filterSql({ ...filter, issueFilter });
      return (this.db.get(`SELECT COUNT(*) AS n FROM driving_records ${clause}`, params) || { n: 0 }).n;
    };
    return {
      ...summary,
      // 필터로 고를 수 있는 셋만 센다. 확인 필요/확인 완료는 "그 상태인 파일에서 온 기록"이라
      // 필터가 아니라 참고 수치로만 둔다(파일 상태를 바꾸면 이슈만/이슈 없음 쪽이 달라진다).
      recordCounts: {
        all: count('all'), clean: count('clean'), issue_all: count('issue_all'),
      },
      openRecordCount: (this.db.get(
        `SELECT COUNT(*) AS n FROM driving_records WHERE (issue_mask & ${IssueFilter.MASK.OPEN}) <> 0`
      ) || { n: 0 }).n,
      unlinkedRecords: (this.db.get(
        `SELECT COUNT(*) AS n FROM driving_records
          WHERE NOT EXISTS (SELECT 1 FROM record_sources rs WHERE rs.record_hash = driving_records.record_hash)`
      ) || { n: 0 }).n,
    };
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
    const size = cellSizeM || CoverageGrid.DEFAULT_CELL_SIZE_M;
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
    if (box && (box.fromDate || box.toDate)) where.push(DATE_ONLY_SQL);
    if (box && box.fromDate) { where.push('date >= ?'); params.push(box.fromDate); }
    if (box && box.toDate) { where.push('date <= ?'); params.push(box.toDate); }
    if (box && box.vehicleLike) { where.push('vehicle LIKE ?'); params.push('%' + box.vehicleLike + '%'); }
    // 이슈 필터는 GPS 방문 데이터에만 건다 — 구역 경계·도로/건물 Geometry 는 이 필터와 무관하다(화면에서 따로 캐시)
    const visitIssueSql = box ? issueFilterSql(box.issueFilter, this.hasIssueImports()) : '';
    if (visitIssueSql) where.push(visitIssueSql);
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
      // Import 이력에 이슈(여부·메모·상태·시각)와 그 파일에서 나온 레코드 키를 함께 싣는다 —
      // 다른 PC 에서 복원해도 "어느 레코드가 어느 파일에서 왔는지"가 살아 있어야 이슈 필터가 같게 동작한다.
      // 레코드 키는 저장소 공통 형식(date|time|vehicle|lat|lng)이고, SQLite 는 복원할 때 sha1 로 바꿔 넣는다.
      imports: this.listImports(1000).map(im => ({ ...im, recordKeys: this.listImportRecordKeys(im.id) })),
    };
  }

  // 그 Import 에서 나온 레코드들의 공통 키(date|time|vehicle|lat|lng)
  listImportRecordKeys(importId) {
    return this.db.all(
      `SELECT dr.date AS date, dr.time AS time, dr.vehicle AS vehicle, dr.latitude AS lat, dr.longitude AS lng
         FROM record_sources rs JOIN driving_records dr ON dr.record_hash = rs.record_hash
        WHERE rs.import_id = ?`, [importId]
    ).map(r => recordKeyOf(r));
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
      // 이 Import 는 "어느 파일에서 왔는지"가 아니라 복원 경로일 뿐이다. 출처로 남기면 모든
      // 기록이 "이슈 없는 파일에서도 왔다"가 되어 이슈 데이터 분리가 통째로 무너진다.
      // 진짜 출처는 아래 restoreImports(payload.imports) 가 recordKeys 로 되살린다.
      trackSources: false,
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
      // 수동 셀(제외/방문/미방문)은 mode 와 무관하게 칸 단위로 병합한다 — 백업에 있는
      // 칸은 백업 상태로, 백업에 없는 지금 칸은 그대로 둔다. manualCells 필드가 없는
      // 옛 백업이면 아무것도 바꾸지 않는다.
      payload.zones.forEach(z => {
        if (!z || !z.name || !z.manualCells || !CoverageGrid.hasManualCells(z.manualCells)) return;
        const merged = CoverageGrid.mergeManualCellsByPoint(this.getZoneManualCells(z.name), z.manualCells);
        this.saveZoneManualCells(z.name, merged);
      });
    }
    if (payload.settings && typeof payload.settings === 'object') {
      // 잘못된 분류·추천 설정이 든 백업·서버 데이터는 그 값만 빼고(지금 설정 유지) 나머지를 반영한다
      this.setSettings(Recommendation.sanitizeRecommendationSettings(TimeConditions.sanitizeClassificationSettings(payload.settings)));
    }
    if (Array.isArray(payload.backupHistory)) {
      const merged = mode === 'replace'
        ? payload.backupHistory
        : [...payload.backupHistory, ...this.getBackupHistory()];
      this.setBackupHistory(dedupeHistory(merged));
    }
    const importResult = this.restoreImports(payload.imports);
    // 백업의 설정이 분류 기준을 바꿨으면 기존 날짜 요약도 새 기준으로 맞춘다(원본 기록은 그대로)
    const reclassified = this.reclassifyStaleSummariesSync();
    return { ...result, mode, reclassifiedDates: reclassified.rebuilt, imports: importResult };
  }

  // ══════════════════════════════════════════════════════
  //  Import 이력 복원(백업·서버 동기화) — 이슈와 출처 관계를 함께 되살린다.
  //
  //  같은 Import 인지는 파일명|파일 지문|Import 시각으로 가린다(기기마다 id 가 다르다).
  //  이슈가 양쪽에서 수정됐으면 issueUpdatedAt 이 최신인 쪽을 쓰고, 밀려난 내용은 지우지 않고
  //  issue_conflict_json 에 남겨 Import 상세에서 확인할 수 있게 한다(메모를 임의로 합치지 않는다).
  // ══════════════════════════════════════════════════════
  restoreImports(imports) {
    this._issueImportsDirty();
    if (!Array.isArray(imports) || !imports.length) return { added: 0, updated: 0, conflicts: 0, sources: 0 };
    let added = 0, updated = 0, conflicts = 0, sources = 0;
    const touched = new Set();
    const sourceStmt = this.db.prepare(`INSERT OR IGNORE INTO record_sources(record_hash, import_id)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM driving_records WHERE record_hash = ?)`);
    try {
      for (const im of imports) {
        if (!im || typeof im !== 'object') continue;
        const filename = String(im.filename || '');
        const fileHash = String(im.fileHash || '');
        const importedAt = String(im.importedAt || '');
        const existing = this.db.get(
          `SELECT id, has_issue AS hasIssue, issue_note AS issueNote, issue_status AS issueStatus,
                  issue_created_at AS issueCreatedAt, issue_updated_at AS issueUpdatedAt
             FROM imports WHERE filename = ? AND file_hash = ? AND imported_at = ?`,
          [filename, fileHash, importedAt]);
        const incoming = {
          hasIssue: !!im.hasIssue,
          issueNote: String(im.issueNote || ''),
          issueStatus: im.hasIssue ? (im.issueStatus === 'resolved' ? 'resolved' : 'open') : '',
          issueCreatedAt: String(im.issueCreatedAt || ''),
          issueUpdatedAt: String(im.issueUpdatedAt || ''),
        };
        let importId;
        if (!existing) {
          this.db.run(
            `INSERT INTO imports (filename, file_hash, imported_at, imported_by, dates, vehicle, distance_km,
               total_records, inserted_records, duplicate_records, conflict_records, conflicts_json,
               has_issue, issue_note, issue_status, issue_created_at, issue_updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [filename, fileHash, importedAt, String(im.importedBy || ''), String(im.dates || ''), String(im.vehicle || ''),
              Number(im.distanceKm) || 0, Number(im.total) || 0, Number(im.inserted) || 0, Number(im.duplicates) || 0,
              Number(im.conflicts) || 0, '[]',
              incoming.hasIssue ? 1 : 0, incoming.issueNote, incoming.issueStatus, incoming.issueCreatedAt, incoming.issueUpdatedAt]);
          importId = (this.db.get('SELECT last_insert_rowid() AS id') || {}).id;
          added++;
        } else {
          importId = existing.id;
          const mineUpdated = existing.issueUpdatedAt || '';
          const theirsUpdated = incoming.issueUpdatedAt || '';
          const differs = (!!existing.hasIssue !== incoming.hasIssue) || ((existing.issueNote || '') !== incoming.issueNote)
            || ((existing.issueStatus || '') !== incoming.issueStatus);
          if (differs && theirsUpdated > mineUpdated) {
            // 들어온 쪽이 최신 — 지금 값을 충돌 기록으로 남기고 덮어쓴다
            if (mineUpdated) {
              conflicts++;
              this.db.run('UPDATE imports SET issue_conflict_json = ? WHERE id = ?', [JSON.stringify({
                keptFrom: 'incoming', detectedAt: new Date().toISOString(),
                replaced: { hasIssue: !!existing.hasIssue, issueNote: existing.issueNote || '', issueStatus: existing.issueStatus || '', issueUpdatedAt: mineUpdated },
              }), importId]);
            }
            this.db.run(
              `UPDATE imports SET has_issue = ?, issue_note = ?, issue_status = ?, issue_created_at = ?, issue_updated_at = ? WHERE id = ?`,
              [incoming.hasIssue ? 1 : 0, incoming.issueNote, incoming.issueStatus,
                incoming.issueCreatedAt || existing.issueCreatedAt || '', theirsUpdated, importId]);
            updated++;
          } else if (differs && mineUpdated && theirsUpdated && theirsUpdated < mineUpdated) {
            // 지금 값이 최신 — 들어온 값은 반영하지 않고 충돌만 기록한다
            conflicts++;
            this.db.run('UPDATE imports SET issue_conflict_json = ? WHERE id = ?', [JSON.stringify({
              keptFrom: 'local', detectedAt: new Date().toISOString(),
              replaced: { hasIssue: incoming.hasIssue, issueNote: incoming.issueNote, issueStatus: incoming.issueStatus, issueUpdatedAt: theirsUpdated },
            }), importId]);
          } else if (differs && !mineUpdated) {
            this.db.run(
              `UPDATE imports SET has_issue = ?, issue_note = ?, issue_status = ?, issue_created_at = ?, issue_updated_at = ? WHERE id = ?`,
              [incoming.hasIssue ? 1 : 0, incoming.issueNote, incoming.issueStatus, incoming.issueCreatedAt, theirsUpdated, importId]);
            updated++;
          }
        }
        (im.recordKeys || []).forEach(key => {
          const hash = crypto.createHash('sha1').update(String(key), 'utf8').digest('hex');
          sourceStmt.run([hash, importId, hash]);
          sources++;
        });
        touched.add(importId);
      }
    } finally {
      sourceStmt.finalize();
    }
    // 출처·이슈가 달라졌으니 그 파일 레코드의 마스크와, 그 파일이 관여한 날짜 요약을 다시 만든다
    touched.forEach(id => { this._recomputeIssueMasks(id); this.rebuildSummariesForImport(id); });
    return { added, updated, conflicts, sources };
  }
}

// imports 한 행 → 화면·백업이 쓰는 형태(이슈 필드 정규화, 예전 행은 "이슈 정보 없음")
// 저장소 공통 레코드 키 — src/js/storage.js recordKey() 와 같은 형식이어야 백업이 서로 통한다
function recordKeyOf(rec) {
  return [rec.date, rec.time, rec.vehicle, Number(rec.lat).toFixed(6), Number(rec.lng).toFixed(6)].join('|');
}

// 백업·동기화에서 같은 Import 인지 가리는 키(기기마다 id 가 다르므로 파일 지문·시각으로 맞춘다)
function importIdentityOf(im) {
  return [im.filename || '', im.fileHash || '', im.importedAt || ''].join('|');
}

function normalizeImportRow(r) {
  const { issueConflictJson, ...rest } = r;
  let issueConflict = null;
  try { issueConflict = issueConflictJson ? JSON.parse(issueConflictJson) : null; } catch (_) { issueConflict = null; }
  return {
    ...rest,
    hasIssue: !!r.hasIssue,
    issueNote: r.issueNote || '',
    issueStatus: r.hasIssue ? (r.issueStatus || 'open') : null,
    issueCreatedAt: r.issueCreatedAt || null,
    issueUpdatedAt: r.issueUpdatedAt || null,
    issueConflict,
    relatedRecords: r.relatedRecords != null ? r.relatedRecords : null,
  };
}

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

function parseManualCells(json) {
  try { return CoverageGrid.normalizeManualCells(JSON.parse(json || '{}')); } catch (_) { return CoverageGrid.normalizeManualCells(null); }
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

// classification: TimeConditions.classificationConfig(설정) — 없으면 기본 분류 기준
function buildDaySummary(rows, classification) {
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
    // 유효 수집 시간(초) — 차량별 90초 이하 기록 간격의 합(collection-stats.js, IndexedDB와 같은 규칙)
    collectionSec: CollectionStats.validDurationSec(rows),
    // 주행 시간(초) — 차량별 첫 기록~마지막 기록(휴식·공백 포함)의 합
    driveSpanSec: CollectionStats.spanDurationSec(rows),
    // 조건 칸(구역·차량·요일·교통 시간대·조도·날씨별 기록 수·수집 시간) + 분류 서명(condition-stats.js)
    ...ConditionStats.buildConditionSummary(rows, classification),
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

module.exports = { RouteDatabase, buildDaySummary, dedupeHistory, haversine, timeToSec, normalizeRecommendationState };
