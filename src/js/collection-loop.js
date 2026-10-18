// ══════════════════════════════════════════════════════════
//  collection-loop — Route Viewer ↔ nav-app 수집 순환 (서버 없는 파일 연계)
//
//    Route Viewer 분석 → 부족 구간 추천 → CollectionPlan.json → nav-app(TMAP 경로 · 필수 구간 검증 ·
//    RoutePackage 확정 · 주행) → DriveResult.json + 주행기록 엑셀 → Route Viewer(GPS 원본으로 다시 계산) → 다음 추천
//
//  이 파일은 순수 함수만 둔다(UMD). 화면·DB·자동 가져오기가 같은 규칙을 쓴다.
//
//  원칙
//    · 추천 점수·부족량은 이 파일이 새로 만들지 않는다. 계획에는 추천 엔진(recommendation.js)이 낸 값을
//      출처(엔진·정책·데이터 지문)와 함께 그대로 담는다. nav-app 도 다시 계산하지 않는다.
//    · 실제 수행 여부는 DriveResult(nav-app 보고)를 믿지 않고 DB 의 GPS 원본으로 다시 계산한다.
//      GPS 원본이 아직 없으면 "수행 보고 수신 / GPS 미검증"이며 완료로 보지 않는다.
//    · "지나갔다(passed)"와 "목표를 채웠다(achieved)"를 구분한다 — 한 번 통과로 목표 시간·횟수를 채운 것으로 보지 않는다.
//    · 통과 판정은 nav-app 과 글자 그대로 같은 passJudge(nav-app-pass-v1 · 25m · 진행 방향 ±60° · 옆 도로 · 60초 공백 분리 ·
//      한 번에 80% 이상 지나야 통과 1회)를 쓴다 — 계획 경로 검증(nav-app)과 GPS 원본 판정(Route Viewer)이 같은 규칙이다.
//
//  무결성: nav-app Route Package 와 같은 정규 직렬화(nav-app-c14n-v1) + SHA-256.
//    키 정렬 · 공백 없음 · 숫자는 round(x×10⁶) 정수 · 문자열은 JSON.stringify 이스케이프 · integrity 제외
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./subzones.js'), require('./collection-stats.js'), require('./time-conditions.js'));
  } else {
    root.CollectionLoop = factory(root.SubZones, root.CollectionStats, root.TimeConditions);
  }
}(typeof self !== 'undefined' ? self : this, function (SZ, CS, TC) {
  'use strict';

  const PLAN_FORMAT = 'nav-app-collection-plan';
  const RESULT_FORMAT = 'nav-app-drive-result';
  const ROUTE_PACKAGE_FORMAT = 'nav-app-route-package';
  const SCHEMA_VERSION = 1;
  const C14N = 'nav-app-c14n-v1';
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_ITEMS = 30;
  const MAX_GEOMETRY = 2000;
  const MAX_STR = 300;
  const BOUNDS = Object.freeze({ latMin: 33, latMax: 39.5, lngMin: 124, lngMax: 132 });
  const SECRET_KEY = /(app_?key|api_?key|token|secret|passw|authoriz|cookie)/i;
  const REGION_CODE = Object.freeze({ 강남: 'gangnam', 판교: 'pangyo', 시흥: 'siheung', 서초: 'seocho' });

  // 필수 구간 통과 판정 — nav-app 도 같은 값을 쓴다(계획 안 mustPass 에 함께 적는다)
  const MUST_PASS_TOLERANCE_M = 25;      // 자동 분석의 GPS→도로 대응 거리와 같다
  const MUST_PASS_MIN_COVERAGE = 0.8;    // 구간 길이의 80% 이상을 따라 달려야 '통과'
  const DEFAULT_SPEED_KMH = 30;          // 구간 간 이동 시간 어림 (주행 계획과 같은 기본값)
  const ORDER_TRAVEL_WEIGHT = 1;         // 방문 순서: 점수 1점 = 이동 1분으로 견준다
  const MAX_PASSES = 20;                 // 한 항목 최대 방문(반복) — 예전 5회 고정 상한을 없애고 시간대·부족분으로 정한다
  const NEIGHBOR_RADIUS_M = 40;          // 통과 판정의 '옆 도로' — 대상 도로에서 이 거리 안의 다른 도로 구간
  const MAX_NEIGHBORS = 80;
  const MAX_NEIGHBOR_POINTS = 600;
  const TURN_SEC_BOTH = 60;              // 양방향 반복: 구간 끝에서 돌아 반대 방향으로 들어가는 데 드는 어림 시간
  const LOOP_SEC_MIN = 120;              // 한 방향 반복: 진입점으로 되돌아오는 이동 최소 어림 시간
  const COLLECTION_SPEED_KMH = 20;       // 수집 속도 기본 가정 — 추천 엔진(collectionSpeedKmh)과 같은 값
  const SPEED_SENSITIVITY_KMH = [15, 20, 30];   // 예상이 속도 가정에 얼마나 흔들리는지 함께 보여 줄 속도
  const UNSUITABLE_PLAN_FACTOR = 2;      // 필요한 방문이 한 계획 최대의 이 배를 넘으면 '이 구간으로는 부적합'
  const ALTERNATIVE_RADIUS_M = 2000;     // 대안 후보를 찾는 거리
  const MAX_ALTERNATIVES = 3;
  const ROUTE_CHECK_FORMAT = 'nav-app-route-check';   // nav-app TMAP 탐색 결과(구간·방향별) — 확정·주행하지 않아도 보낼 수 있다

  // ── 정규 직렬화 · SHA-256 (nav-app index.html c14n · sha256Hex 와 같은 결과) ──
  function c14n(v) {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!isFinite(v)) throw new Error('숫자가 아닌 값');
      return String(Math.round(v * 1e6));
    }
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(c14n).join(',') + ']';
    if (typeof v === 'object') {
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + c14n(v[k])).join(',') + '}';
    }
    throw new Error('직렬화할 수 없는 값');
  }

  function sha256Hex(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    const w = new Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function documentHash(doc) {
    const body = Object.assign({}, doc);
    delete body.integrity;
    return sha256Hex(c14n(body));
  }
  function verifyCode(hash) {
    const h = String(hash || '').toUpperCase();
    return h.length >= 8 ? h.slice(0, 4) + '-' + h.slice(4, 8) : '—';
  }
  function seal(doc) {
    doc.integrity = { algorithm: 'SHA-256', sha256: documentHash(doc) };
    return doc;
  }

  const r6 = x => Math.round(Number(x) * 1e6) / 1e6;
  const pt = p => [r6(p[0]), r6(p[1])];
  const str = (v, max) => String(v == null ? '' : v).slice(0, max || MAX_STR);
  const inBounds = (lat, lng) => typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng) &&
    lat >= BOUNDS.latMin && lat <= BOUNDS.latMax && lng >= BOUNDS.lngMin && lng <= BOUNDS.lngMax;

  function kstDate(ms) { return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10); }
  function kstClock(ms) { return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19); }

  function newId(prefix, nowMs, seed) {
    const d = kstDate(nowMs).replace(/-/g, '');
    const s = sha256Hex(String(seed || '') + '|' + nowMs + '|' + Math.random()).slice(0, 10);
    return `${prefix}-${d}-${s}`;
  }

  function findSecret(v, path) {
    if (!v || typeof v !== 'object') return null;
    for (const k of Object.keys(v)) {
      if (SECRET_KEY.test(k)) return (path ? path + '.' : '') + k;
      const hit = findSecret(v[k], (path ? path + '.' : '') + k);
      if (hit) return hit;
    }
    return null;
  }

  function parseInput(input) {
    if (typeof input !== 'string') return { doc: input };
    if (input.length > MAX_BYTES) return { error: '파일이 너무 큽니다' };
    try { return { doc: JSON.parse(input.replace(/^﻿/, '')) }; } catch (_) { return { error: 'JSON 형식이 아닙니다' }; }
  }

  function lengthOf(geom) {
    let m = 0;
    for (let i = 1; i < geom.length; i++) m += SZ.distanceM(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1]);
    return m;
  }

  /* PASS-JUDGE nav-app-pass-v1 BEGIN
     통과 판정 공통 규격 — 이 블록은 nav-app index.html 과 Route Viewer src/js/collection-loop.js 에 글자 그대로 같다.
     (두 저장소 시험이 같은 시험 파일 tests/fixtures/pass_judge_cases.json 의 기대값으로 확인하고, 옆 저장소가 있으면 글자도 비교한다)
     입력  track  : [{lat, lng, t}] 시각 순 (t = 초 — GPS 원본은 그날 0시부터 초, TMAP 경로는 경로를 따라 만든 시각)
           path   : 대상 도로 [[lat,lng],…] — 'forward' 는 이 좌표 순서 방향
           options: { neighbors:[[[lat,lng],…],…] 옆 도로(대상 도로 40m 안 다른 도로 구간), window:{fromSec,toSec}|null, …PASS_JUDGE_DEFAULTS }
     규칙  ① 측위 튐(>50m/s)은 버리고, 60초 넘게 끊기면 다른 주행 구간 — 앞뒤를 한 통과로 잇지 않는다
              튄 점 다음 측위가 튄 점과 이어지면 튐이 아니라 '자리 옮김'(GPS 다시 잡힘)으로 보고 거기서 새 주행 구간을 시작한다
              (예전 위치와 견주기만 하면 한 번 옮긴 뒤 모든 측위가 튐으로 버려진다)
           ② 수집 시간은 측위 하나당 최대 5초 (공백이 시간을 부풀리지 않게)
           ③ 진행 방향은 3m 이상 떨어진 기준점에서 (20초 넘은 기준점은 버림) — 방향을 모르면 어느 방향 수집으로도 세지 않는다
           ④ 대상 도로 25m 안이어도, 진행 방향과 나란한 옆 도로가 1m 넘게 더 가까우면 옆 도로 기록 (반대 차도·평행 도로)
              가로지르는 방향(60°~120°)이면 대상 도로 기록이 아니다 (교차로 통과)
           ⑤ 한 방향으로 이어진 기록(같은 주행 구간에서 60초 안에 다시 오면 이어짐 · 대상 도로 위 정차 중 기록도 이어 줌)이
              대상 도로 20m 칸의 80% 이상을 채우면 '통과 1회' — 일부만 지난 것(연결 경로가 스친 것)은 통과로 세지 않는다
     출력  forward/backward 마다 { coverage(전체 칸 비율), cells, seconds, windowSeconds, passes, windowPasses, partials, traversals[] } */
  const PASS_JUDGE_VERSION = 'nav-app-pass-v1';
  const PASS_JUDGE_DEFAULTS = Object.freeze({
    toleranceM: 25, cellM: 20, minCoverage: 0.8, dirTolDeg: 60, runGapSec: 60, maxStepSec: 5,
    jumpMps: 50, anchorM: 3, anchorMaxSec: 20, rejoinSec: 60, neighborMarginM: 1,
  });
  function passJudge(track, path, options) {
    const o = Object.assign({}, PASS_JUDGE_DEFAULTS, options || {});
    const ok = p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]);
    const mk = () => ({ coverage: 0, cells: 0, seconds: 0, windowSeconds: 0, passes: 0, windowPasses: 0, partials: 0, traversals: [] });
    const out = { version: PASS_JUDGE_VERSION, totalCells: 1, points: 0, used: 0, jumps: 0, relocations: 0, gaps: 0, gapSec: 0, runs: 0,
      onTarget: 0, onNeighbor: 0, unknownHeading: 0, forward: mk(), backward: mk() };
    const pts = (path || []).filter(ok);
    if (pts.length < 2) return out;
    const lat0 = pts[0][0], lng0 = pts[0][1];
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const P = p => [(p[1] - lng0) * kx, (p[0] - lat0) * ky];
    const brgOf = (dx, dy) => (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const prep = line => {
      const xy = line.map(P), cum = [0], brg = [];
      for (let i = 1; i < xy.length; i++) {
        const dx = xy[i][0] - xy[i - 1][0], dy = xy[i][1] - xy[i - 1][1];
        cum.push(cum[i - 1] + Math.hypot(dx, dy)); brg.push(brgOf(dx, dy));
      }
      return { xy, cum, brg };
    };
    const T = prep(pts);
    const N = (o.neighbors || []).map(l => (Array.isArray(l) ? l.filter(ok) : [])).filter(l => l.length >= 2).map(prep);
    const totalCells = Math.max(1, Math.ceil(T.cum[T.cum.length - 1] / o.cellM));
    out.totalCells = totalCells;
    const diff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
    const near = (L, x) => {
      let best = null;
      for (let i = 0; i < L.xy.length - 1; i++) {
        const a = L.xy[i], b = L.xy[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        if (l2 < 0.25) continue;
        const t = Math.max(0, Math.min(1, ((x[0] - a[0]) * dx + (x[1] - a[1]) * dy) / l2));
        const d = Math.hypot(x[0] - (a[0] + dx * t), x[1] - (a[1] + dy * t));
        if (!best || d < best.d) best = { d, along: L.cum[i] + Math.sqrt(l2) * t, brg: L.brg[i] };
      }
      return best;
    };
    const inWin = t => !o.window || (t >= o.window.fromSec && t <= o.window.toSec);
    const allCells = { forward: new Set(), backward: new Set() };
    const cur = { forward: null, backward: null };
    const close = dir => {
      const c = cur[dir];
      if (!c) return;
      cur[dir] = null;
      const r = out[dir], cov = c.cells.size / totalCells, pass = cov >= o.minCoverage;
      r.traversals.push({ fromSec: c.from, toSec: c.to, coverage: Math.round(cov * 1000) / 1000, pass });
      if (pass) { r.passes++; if (inWin(c.from) && inWin(c.to)) r.windowPasses++; } else r.partials++;
    };
    let prev = null, run = 0, anchor = null, heading = null, held = null;
    const list = (track || []).filter(p => p && isFinite(p.lat) && isFinite(p.lng) && isFinite(p.t));
    out.points = list.length;
    for (const p of list) {
      const x = P([p.lat, p.lng]);
      let step = 0;
      if (prev) {
        const dt = p.t - prev.t;
        if (dt <= 0) continue;
        if (Math.hypot(x[0] - prev.x[0], x[1] - prev.x[1]) / dt > o.jumpMps) {
          const hdt = held ? p.t - held.t : 0;
          if (held && hdt > 0 && hdt <= o.runGapSec && Math.hypot(x[0] - held.x[0], x[1] - held.x[1]) / hdt <= o.jumpMps) {
            // 자리 옮김 — 붙잡아 둔 점부터 새 주행 구간
            out.relocations++; run++; anchor = { t: held.t, x: held.x }; heading = null; held = null;
            close('forward'); close('backward');
            prev = { t: p.t, x }; out.used++;
            continue;
          }
          if (held) out.jumps++;
          held = { t: p.t, x };
          continue;
        }
        if (held) { out.jumps++; held = null; }
        if (dt > o.runGapSec) {
          out.gaps++; out.gapSec += dt; run++; anchor = null; heading = null;
          close('forward'); close('backward');
        } else {
          if (dt > o.maxStepSec) { out.gaps++; out.gapSec += dt; }
          step = Math.min(dt, o.maxStepSec);
        }
      } else run = 1;
      prev = { t: p.t, x };
      out.used++;
      if (!anchor || p.t - anchor.t > o.anchorMaxSec) { anchor = { t: p.t, x }; heading = null; }
      else if (Math.hypot(x[0] - anchor.x[0], x[1] - anchor.x[1]) >= o.anchorM) {
        heading = brgOf(x[0] - anchor.x[0], x[1] - anchor.x[1]); anchor = { t: p.t, x };
      }
      const m = near(T, x);
      if (!m || m.d > o.toleranceM) continue;
      const along = b => heading == null || diff(heading, b) <= o.dirTolDeg || diff(heading, b) >= 180 - o.dirTolDeg;
      if (!along(m.brg)) continue;
      let toNeighbor = false;
      for (const L of N) { const n = near(L, x); if (n && n.d + o.neighborMarginM < m.d && along(n.brg)) { toNeighbor = true; break; } }
      if (toNeighbor) { out.onNeighbor++; continue; }
      out.onTarget++;
      if (heading == null) {   // 정차·저속 — 방향을 모르니 수집으로 세지 않지만, 하던 통과는 끊지 않는다
        out.unknownHeading++;
        ['forward', 'backward'].forEach(d => { if (cur[d] && cur[d].run === run && p.t - cur[d].to <= o.rejoinSec) cur[d].to = p.t; });
        continue;
      }
      const dir = diff(heading, m.brg) <= o.dirTolDeg ? 'forward' : 'backward';
      const cell = Math.min(totalCells - 1, Math.floor(m.along / o.cellM));
      allCells[dir].add(cell);
      out[dir].seconds += step;
      if (inWin(p.t)) out[dir].windowSeconds += step;
      const c = cur[dir];
      if (c && c.run === run && p.t - c.to <= o.rejoinSec) { c.cells.add(cell); c.to = p.t; }
      else { close(dir); cur[dir] = { run, from: p.t, to: p.t, cells: new Set([cell]) }; }
    }
    if (held) out.jumps++;
    close('forward'); close('backward');
    out.runs = run;
    ['forward', 'backward'].forEach(d => {
      const r = out[d];
      r.cells = allCells[d].size;
      r.coverage = Math.round(allCells[d].size / totalCells * 1000) / 1000;
      r.seconds = Math.round(r.seconds * 10) / 10;
      r.windowSeconds = Math.round(r.windowSeconds * 10) / 10;
    });
    return out;
  }
  /* PASS-JUDGE nav-app-pass-v1 END */

  // ══════════════════════════════════════════════════════
  //  A. CollectionPlan — 추천 → 하루 수집 계획
  // ══════════════════════════════════════════════════════

  // 방향 가능성 — HD Map 선에는 일방통행·분리 차도·진입 제한 정보가 없다(이름·좌표뿐). 그래서 지도만으로 '가능'이라고도 '불가'라고도
  // 정하지 않는다. 기본은 '확인 필요'이고, nav-app 이 TMAP 으로 그 방향 경로를 만들지 못했다고 보고한 방향만 계획에서 뺀다(이유 표시).
  // GPS 기록상 그 방향 주행이 있으면 참고로 적는다(오대응 가능 — 확정 근거 아님).
  const DIRECTION_STATUS_LABEL = Object.freeze({
    needs_check: '확인 필요', gps_seen: '주행 기록 있음(참고)', tmap_unreachable: 'TMAP 경로 없음(nav-app 보고)', tmap_ok: 'TMAP 경로 확인(nav-app 보고)',
  });
  const DIR_LABEL = Object.freeze({ forward: '형상 순서 방향', backward: '형상 반대 방향' });
  // nav-app 이 '그 방향으로 지나는 경로가 없다'고 본 원인 (경유점을 늘려도 나아지지 않는 것) — 사용자가 그냥 뺀 것('user')은 넣지 않는다
  const UNREACHABLE_CAUSES = Object.freeze(['direction_unreachable', 'parallel_road']);

  /**
   * feedback: [{ segmentId, direction:'forward'|'backward', cause, at, resultId }] — nav-app 주행 결과의 planAdjustments 에서 모은 것
   * segStat: 자동 분석 구간 통계(directions.forward/backward 건수) — 없으면 null
   */
  function directionFeasibility(segmentId, feedback, segStat) {
    const out = {};
    ['forward', 'backward'].forEach(d => {
      // 그 구간·방향의 가장 최근 nav-app TMAP 결과 — 실패(경로 없음)든 확인(통과)이든 최신 것을 쓴다
      const fb = (feedback || []).filter(f => f && f.segmentId === segmentId && f.direction === d && (UNREACHABLE_CAUSES.includes(f.cause) || f.cause === 'ok'))
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0];
      const seen = segStat && segStat.directions ? Number(segStat.directions[d]) || 0 : 0;
      if (fb && fb.cause === 'ok') out[d] = { status: 'tmap_ok', basis: `nav-app TMAP 검증에서 이 방향으로 지나는 경로를 확인 (${String(fb.at || '').slice(0, 10)}) — 실제 주행 가능 여부는 현장 확인` };
      else if (fb) out[d] = { status: 'tmap_unreachable', basis: `nav-app TMAP 검증에서 이 방향으로 지나는 경로를 만들지 못함 — ${fb.cause === 'parallel_road' ? '옆 도로·반대 차도로만 지남(분리 차도 가능성)' : '반대 방향으로만 지남(일방통행 가능성)'} (${String(fb.at || '').slice(0, 10)} · ${fb.resultId || ''})` };
      else if (seen >= 5) out[d] = { status: 'gps_seen', basis: `GPS 기록상 이 방향 ${seen}건 — 가능성은 있으나 지도로 확인되지 않음 (TMAP 검증으로 확인)` };
      else out[d] = { status: 'needs_check', basis: 'HD Map 에 일방통행·분리 차도 정보가 없어 지도만으로 판단할 수 없음 (TMAP 검증으로 확인)' };
    });
    return out;
  }

  /** 대상 도로 40m 안의 다른 도로 구간 — 통과 판정(passJudge)의 '옆 도로'. 대상 근처 부분만 잘라 담는다 */
  function pickNeighbors(geometry, roadSegments, selfId, radiusM) {
    const R = radiusM || NEIGHBOR_RADIUS_M;
    if (!Array.isArray(geometry) || geometry.length < 2 || !Array.isArray(roadSegments)) return [];
    const lat0 = geometry[0][0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const P = p => [(p[1] - geometry[0][1]) * kx, (p[0] - lat0) * ky];
    const g = geometry.map(P);
    const xs = g.map(p => p[0]), ys = g.map(p => p[1]);
    const box = [Math.min(...xs) - R - 60, Math.max(...xs) + R + 60, Math.min(...ys) - R - 60, Math.max(...ys) + R + 60];
    const distTo = x => {
      let best = Infinity;
      for (let i = 0; i < g.length - 1; i++) {
        const a = g[i], b = g[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x[0] - a[0]) * dx + (x[1] - a[1]) * dy) / l2));
        best = Math.min(best, Math.hypot(x[0] - (a[0] + dx * t), x[1] - (a[1] + dy * t)));
      }
      return best;
    };
    const out = [];
    roadSegments.forEach(s => {
      if (!s || s.id === selfId || !Array.isArray(s.geometry) || s.geometry.length < 2 || out.length >= MAX_NEIGHBORS) return;
      const q = s.geometry.map(P);
      if (q.every(x => x[0] < box[0] || x[0] > box[1] || x[1] < box[2] || x[1] > box[3])) return;
      // 선분을 5m 간격으로 짚어 대상 R m 안에 드는 부분만 (앞뒤 한 점 더)
      const keep = new Set();
      for (let i = 0; i < q.length - 1; i++) {
        const a = q[i], b = q[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 5));
        for (let k = 0; k <= n; k++) {
          const x = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
          if (distTo(x) <= R) { keep.add(i); keep.add(i + 1); break; }
        }
      }
      if (!keep.size) return;
      const idx = [...keep].sort((a, b) => a - b);
      const lo = Math.max(0, idx[0] - 1), hi = Math.min(q.length - 1, idx[idx.length - 1] + 1);
      const part = s.geometry.slice(lo, hi + 1).map(pt);
      if (part.length >= 2) out.push(part.length > MAX_NEIGHBOR_POINTS ? part.slice(0, MAX_NEIGHBOR_POINTS) : part);
    });
    return out;
  }

  function minutesBetween(w) {
    if (!w || !w.start) return null;
    const s = TC && TC.parseClock ? TC.parseClock(w.start, false) : null;
    const e = TC && TC.parseClock ? TC.parseClock(w.end, true) : null;
    return s == null || e == null ? null : Math.max(0, e - s);
  }

  /**
   * 반복 횟수 · 예상 수집량 — 구간 길이로 1회(편도) 시간을 어림해 부족분을 채우는 데 필요한 횟수와
   * 권장 시간대 안에 들어가는 횟수 중 작은 쪽(최대 MAX_PASSES)으로 정한다. 다 못 채우면 예상 부족량을 남긴다.
   * 예상 수집량은 달성량이 아니다(달성은 주행 뒤 GPS 원본으로만). 속도 가정에 따른 차이(speedSensitivity)를 함께 둔다.
   * 수집 시간 = 구간 위에 머문 시간이라, 빨리 달리면 1회 수집이 줄고 천천히 달리면 늘어난다.
   * quantityStatus: 'achievable'(이번 계획으로 부족분 예상 충족) · 'conditional'(기본 속도로는 되지만 더 빨리 달리면 모자람 /
   *                 시간대를 거의 다 씀) · 'shortfall'(최대 방문·시간대로도 모자람)
   * unsuitable: 필요한 방문이 한 계획 최대의 UNSUITABLE_PLAN_FACTOR 배를 넘음 — 이 목표를 이 구간으로 채우기에 맞지 않음
   */
  function estimatePasses(r, lengthM, dirCount, o) {
    const calc = speed => {
      const passSec = Math.max(5, Math.round(lengthM / (speed / 3.6)));
      // 양방향은 끝에서 돌아 바로 반대 방향 수집, 한 방향 반복은 진입점으로 되돌아오는 이동이 든다
      const turnSec = dirCount === 2 ? TURN_SEC_BOTH : Math.max(LOOP_SEC_MIN, Math.round(passSec * 1.5));
      const deficitMinutes = Math.round((r.need && r.need.additionalMinutes) || 0);
      const neededPasses = Math.max(1, Math.ceil(deficitMinutes * 60 / passSec));
      const windowMinutes = minutesBetween(r.timeWindow) != null ? minutesBetween(r.timeWindow) : (o && o.windowMinutes) || 60;
      const fitPasses = Math.max(1, Math.floor(windowMinutes * 60 / (passSec + turnSec)));
      const planned = Math.max(1, Math.min(neededPasses, fitPasses, MAX_PASSES));
      const expectedMinutes = Math.round(planned * passSec / 6) / 10;
      const limitedBy = planned === neededPasses ? 'deficit' : planned === fitPasses ? 'window' : 'max_passes';
      const shortfall = Math.max(0, Math.round((deficitMinutes - expectedMinutes) * 10) / 10);
      const windowUse = Math.round(planned * (passSec + turnSec) / 60 / Math.max(1, windowMinutes) * 100) / 100;
      return { speedKmh: speed, passSec, turnSec, neededPasses, fitPasses, plannedPasses: planned, windowMinutes, windowUse,
        expectedMinutes, deficitMinutes, shortfallMinutes: shortfall, limitedBy };
    };
    const speed = Math.max(5, (o && o.collectionSpeedKmh) || (r.need && r.need.speedKmh) || COLLECTION_SPEED_KMH);
    const base = calc(speed);
    const sens = SPEED_SENSITIVITY_KMH.filter(s => s !== speed).concat([speed]).sort((a, b) => a - b).map(s => {
      const x = calc(s);
      return { speedKmh: s, plannedPasses: x.plannedPasses, expectedMinutes: x.expectedMinutes, shortfallMinutes: x.shortfallMinutes };
    });
    const faster = sens.filter(x => x.speedKmh > speed);
    let quantityStatus = 'achievable';
    if (base.shortfallMinutes > 0) quantityStatus = 'shortfall';
    else if (faster.some(x => x.shortfallMinutes > 0) || base.windowUse >= 0.8) quantityStatus = 'conditional';
    const unsuitable = base.neededPasses > MAX_PASSES * UNSUITABLE_PLAN_FACTOR;
    const plansNeeded = Math.ceil(base.neededPasses / Math.max(1, Math.min(base.fitPasses, MAX_PASSES)));
    const limitText = { window: '권장 시간대에 들어가는 횟수', max_passes: `한 계획 최대 ${MAX_PASSES}회`, deficit: '' }[base.limitedBy];
    return Object.assign(base, {
      speedSensitivity: sens, quantityStatus, unsuitable, plansNeeded,
      basis: `구간 ${Math.round(lengthM)}m ÷ ${speed}km/h = 편도 약 ${base.passSec}초 · 필요 ${base.neededPasses}회 · 시간대 ${base.windowMinutes}분에 ${base.fitPasses}회`,
      note: base.shortfallMinutes > 0
        ? `이번 계획으로 약 ${base.expectedMinutes}분 예상 · 부족분 ${base.deficitMinutes}분 중 ${base.shortfallMinutes}분은 남음 (${limitText} 제한` +
          (plansNeeded > 1 ? ` · 같은 조건으로 약 ${plansNeeded}번 주행해야 채움` : '') + ')'
        : `이번 계획으로 부족분 ${base.deficitMinutes}분을 채울 것으로 예상 (약 ${base.expectedMinutes}분 · ${speed}km/h 가정)`,
    });
  }

  /**
   * 도로망 연결 — HD Map 선에는 방향(일방통행)·분리 차도 정보가 없고, 이름·좌표·교차점만 있다.
   * 그래서 연결로 알 수 있는 것만 적는다: 구간 끝이 다른 도로와 이어지지 않으면(막다른 길이거나 지도 범위 끝) 되돌아 나오기를 확인해야 한다.
   */
  function endpointConnectivity(segmentId, roadSegments) {
    const segs = Array.isArray(roadSegments) ? roadSegments : null;
    if (!segs) return { known: false, deadEnds: [], note: '도로망 정보 없음' };
    const me = segs.find(s => s.id === segmentId);
    if (!me || !me.startNode || !me.endNode) return { known: false, deadEnds: [], note: '도로망에서 이 구간을 찾지 못함' };
    const deg = n => segs.reduce((a, s) => a + (s.startNode === n ? 1 : 0) + (s.endNode === n ? 1 : 0), 0);
    const deadEnds = [];
    if (deg(me.startNode) <= 1) deadEnds.push('start');
    if (deg(me.endNode) <= 1) deadEnds.push('end');
    return { known: true, deadEnds,
      note: deadEnds.length ? `구간 ${deadEnds.map(d => (d === 'start' ? '시작' : '끝')).join('·')}이 다른 도로와 이어지지 않음 — 막다른 길이거나 지도 범위 끝 (돌아 나오기 확인 필요)` : '양 끝이 다른 도로와 이어짐' };
  }

  const FEASIBILITY_LABEL = Object.freeze({
    achievable: '달성 가능', conditional: '조건부 가능', shortfall: '목표 미달 예상', direction_unknown: '방향 확인 필요', route_failed: '경로 탐색 실패',
  });

  /**
   * 계획 항목 실현 가능성 (확정 전, TMAP 탐색 전) — 수량(estimate)·방향(directionPlan)·연결(connectivity)을 함께 본다.
   * 우선순위: shortfall > direction_unknown > conditional > achievable. ('route_failed' 는 nav-app 이 TMAP 탐색 뒤에 정한다)
   * 방향은 nav-app TMAP 검증이나 GPS 기록으로 확인되기 전에는 '확인 필요'다(지도만으로 가능하다고 보지 않는다).
   */
  function itemFeasibility(est, directionPlan, connectivity) {
    const reasons = [];
    const unknownDirs = (directionPlan.allowed || []).filter(d => {
      const st = directionPlan.feasibility[d] && directionPlan.feasibility[d].status;
      return st !== 'tmap_ok' && st !== 'gps_seen';
    });
    let status;
    if (est.quantityStatus === 'shortfall') { status = 'shortfall'; reasons.push(est.note); }
    if (est.unsuitable) reasons.push(`필요한 방문 ${est.neededPasses}회 — 한 계획 최대 ${MAX_PASSES}회의 ${UNSUITABLE_PLAN_FACTOR}배를 넘어 이 구간으로 이 목표를 채우기에는 맞지 않음 (대안 확인)`);
    if (unknownDirs.length) {
      if (!status) status = 'direction_unknown';
      reasons.push(`${unknownDirs.map(d => DIR_LABEL[d]).join('·')}: 지도로 주행 가능 여부를 알 수 없음 — nav-app TMAP 검증으로 확인`);
    }
    if (connectivity && connectivity.deadEnds && connectivity.deadEnds.length) {
      if (!status) status = 'conditional';
      reasons.push(connectivity.note);
    }
    if (est.quantityStatus === 'conditional') {
      if (!status) status = 'conditional';
      const fast = (est.speedSensitivity || []).find(x => x.speedKmh > est.speedKmh && x.shortfallMinutes > 0);
      reasons.push(fast ? `${fast.speedKmh}km/h 로 더 빨리 달리면 ${fast.shortfallMinutes}분 부족 (구간 위 머문 시간이 줄어듦)` : `권장 시간대의 ${Math.round(est.windowUse * 100)}%를 씀`);
    }
    if (!status) { status = 'achievable'; reasons.push(est.note); }
    return { status, label: FEASIBILITY_LABEL[status], quantityStatus: est.quantityStatus, unknownDirections: unknownDirs, reasons };
  }

  /** 같은 조건 키 — 구간 · 요일 유형 · 교통 시간대 · 조도 (방향 제외). 다른 구간·조건의 수집을 이 목표로 합치지 않는다 */
  function conditionOnlyKey(c) {
    return [c && c.weekdayType || '', c && c.trafficPeriod || '', c && c.lightCondition || ''].join('|');
  }

  /**
   * 대안 — 목표 미달 예상·부적합 항목에 같은 수집 조건(요일·시간대·조도)의 다른 후보를 제안한다.
   *  · 'longer'  : 더 긴(또는 이번 계획으로 채울 수 있는) 다른 구간 — 가까운 순
   *  · 'chain'   : 같은 도로로 바로 이어진 구간(같은 조건 부족) — 함께 넣으면 한 번 주행에 두 목표를 모은다(달성량은 구간마다 따로)
   * 대안의 수집은 그 대안 구간의 목표로만 센다 — 원래 항목의 달성으로 합치지 않는다.
   */
  function findAlternatives(item, candidates, ctx) {
    const key = conditionOnlyKey(item.condition);
    const c = item.geometry[Math.floor(item.geometry.length / 2)];
    const pool = (candidates || []).filter(r => r && r.segmentId && r.segmentId !== item.segmentId && Array.isArray(r.geometry) && r.geometry.length >= 2
      && conditionOnlyKey(r.condition) === key && r.need && r.need.additionalMinutes > 0);
    const seen = new Set();
    const out = [];
    const me = Array.isArray(ctx && ctx.roadSegments) ? ctx.roadSegments.find(s => s.id === item.segmentId) : null;
    pool.forEach(r => {
      if (seen.has(r.segmentId)) return;
      seen.add(r.segmentId);
      const lengthM = Math.round(r.lengthM || lengthOf(r.geometry));
      const est = estimatePasses(r, lengthM, r.direction && r.direction.id === 'both' ? 2 : 1, ctx);
      const mid = r.geometry[Math.floor(r.geometry.length / 2)];
      const distanceM = Math.round(SZ.distanceM(c[0], c[1], mid[0], mid[1]));
      const other = me && Array.isArray(ctx.roadSegments) ? ctx.roadSegments.find(s => s.id === r.segmentId) : null;
      const adjacent = !!(me && other && other.roadName && other.roadName === me.roadName &&
        [other.startNode, other.endNode].some(n => n && (n === me.startNode || n === me.endNode)));
      // 채울 수 있거나, 못 채워도 필요한 주행일이 절반 이하로 주는 후보만 (조금 긴 것만으로는 대안이 아니다)
      const better = est.quantityStatus !== 'shortfall' || est.plansNeeded <= Math.floor(item.estimate.plansNeeded / 2);
      if (!adjacent && (!better || distanceM > ALTERNATIVE_RADIUS_M)) return;
      out.push({
        type: adjacent ? 'chain' : 'longer',
        recommendationId: str(r.id, 200), segmentId: str(r.segmentId, 200), title: str(r.displayName || r.segmentLabel || r.roadName),
        lengthM, distanceM, score: Math.round((Number(r.score) || 0) * 10) / 10,
        expectedMinutes: est.expectedMinutes, shortfallMinutes: est.shortfallMinutes, quantityStatus: est.quantityStatus,
        why: adjacent
          ? `같은 도로로 바로 이어진 구간(${lengthM}m) — 함께 넣으면 한 번 주행에 두 구간을 모음 (달성량은 구간마다 따로)`
          : `같은 조건(${item.conditionLabel || key}) · ${lengthM}m · ${distanceM}m 거리 — 이번 계획 예상 ${est.expectedMinutes}분${est.shortfallMinutes > 0 ? ` (부족 ${est.shortfallMinutes}분 · 약 ${est.plansNeeded}번 주행일, 지금 구간은 ${item.estimate.plansNeeded}번)` : ' (부족분 채움)'}`,
      });
    });
    const rank = a => (a.type === 'chain' ? 0 : 1) * 1e6 + (a.quantityStatus === 'achievable' ? 0 : a.quantityStatus === 'conditional' ? 1 : 2) * 1e5 + a.distanceM;
    return out.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ALTERNATIVES);
  }

  /** 추천(도로 구간) 하나 → 계획 항목. 점수·부족량·근거는 추천 그대로 옮기고, 방향·반복·예상은 따로 적는다 */
  function planItemFromRecommendation(r, index, ctx) {
    const c = ctx || {};
    const geometry = (r.geometry || []).map(pt);
    const dirId = r.direction && r.direction.id ? r.direction.id : 'both';
    const wanted = dirId === 'both' ? ['forward', 'backward'] : [dirId];
    const feas = directionFeasibility(r.segmentId, c.directionFeedback, c.segmentStats ? c.segmentStats[r.segmentId] : null);
    const allowed = wanted.filter(d => feas[d].status !== 'tmap_unreachable');
    const excluded = wanted.filter(d => !allowed.includes(d)).map(d => ({ direction: d, reason: feas[d].basis }));
    const lengthM = Math.round(r.lengthM || lengthOf(geometry));
    const est = estimatePasses(r, lengthM, allowed.length, c);
    const connectivity = endpointConnectivity(r.segmentId, c.roadSegments);
    const visits = [];
    for (let p = 1; allowed.length && p <= est.plannedPasses; p++) visits.push({ passNo: p, direction: allowed[(p - 1) % allowed.length] });
    const first = visits.length ? visits[0].direction : (wanted[0] || 'forward');
    const along = first === 'backward' ? geometry.slice().reverse() : geometry;
    const reasons = (r.breakdown || []).filter(b => !b.excluded && b.value >= 40)
      .sort((a, b) => b.contribution - a.contribution).slice(0, 3)
      .map(b => ({ key: b.key, label: str(b.label || b.key, 60), value: Math.round(b.value * 10) / 10, contribution: Math.round((b.contribution || 0) * 10) / 10 }));
    return {
      itemId: `pi-${index + 1}`,
      recommendationId: str(r.id, 200),
      segmentId: str(r.segmentId, 200),
      title: str(r.displayName || r.segmentLabel || r.roadName || r.segmentId),
      roadName: str(r.roadName),
      parentZone: str(r.parentZone, 40),
      subZoneName: str(r.subZoneName),
      score: Math.round((Number(r.score) || 0) * 10) / 10,
      dataNeedScore: Math.round((Number(r.dataNeedScore != null ? r.dataNeedScore : r.score) || 0) * 10) / 10,
      priorityLabel: str(r.priorityLabel, 20),
      confidence: r.confidence ? str(r.confidence.label || r.confidence.level, 20) : '',
      projectPriority: r.projectPriority && r.projectPriority.applied
        ? { areaNo: r.projectPriority.areaNo || null, value: Math.round(Number(r.projectPriority.value) || 0), label: str(r.projectPriority.label, 60) }
        : null,
      reasons,
      reasonText: str(typeof r.reason === 'string' ? r.reason : (r.reason && r.reason.text) || '', MAX_STR),
      deficit: {
        currentMinutes: Math.round((r.current && r.current.collectionMinutes) || 0),
        targetMinutes: Math.round((r.need && r.need.targetMinutes) || 0),
        additionalMinutes: Math.round((r.need && r.need.additionalMinutes) || 0),
        currentVisits: Math.round((r.current && r.current.visitCount) || 0),
        targetVisits: Math.round((r.need && r.need.targetVisits) || 0),
        coveragePercent: r.current && r.current.coveragePercent != null ? Math.round(r.current.coveragePercent * 10) / 10 : null,
      },
      // 수집 목표 — 추천 엔진 값(목표·누적·부족·방향·기존 방문)과 엔진의 고정 반복 제안을 그대로 남긴다 (계획 반복은 estimate)
      target: {
        targetMinutes: Math.round((r.need && r.need.targetMinutes) || 0),
        currentMinutes: Math.round((r.current && r.current.collectionMinutes) || 0),
        deficitMinutes: Math.round((r.need && r.need.additionalMinutes) || 0),
        direction: dirId,
        currentVisits: Math.round((r.current && r.current.visitCount) || 0),
        recommendedPasses: Math.round((r.need && r.need.passes) || 0),
        recommendedPassMinutes: Math.round((r.need && r.need.passMinutes) || 0),
      },
      condition: {
        weekdayType: str(r.condition && r.condition.weekdayType, 20),
        trafficPeriod: str(r.condition && r.condition.trafficPeriod, 30),
        lightCondition: r.condition && r.condition.lightCondition ? str(r.condition.lightCondition, 20) : null,
      },
      conditionLabel: str(r.conditionLabel, 80),
      timeWindow: r.timeWindow && r.timeWindow.start ? { start: r.timeWindow.start, end: r.timeWindow.end } : null,
      direction: { id: dirId, label: str(r.direction && r.direction.label, 40) },
      directionPlan: {
        feasibility: feas,
        allowed,
        excluded,
        note: 'HD Map 에 일방통행·분리 차도 정보가 없어 방향 가능 여부는 nav-app TMAP 검증으로 확인합니다',
      },
      passes: visits.length,
      // 방문마다 목표 방향 — 'forward' = geometry 좌표 순서
      visits,
      estimate: est,
      connectivity,
      feasibility: itemFeasibility(est, { feasibility: feas, allowed }, connectivity),
      passMinutes: Math.round((r.need && r.need.passMinutes) || 0),
      estimatedMinutes: Math.round(visits.length * est.passSec / 60),
      lengthM,
      geometry,
      // nav-app 이 TMAP 경로로 반드시 지나야 하는 구간 — 첫 방문 방향 순서의 좌표 + 옆 도로(같은 판정 규칙 passJudge)
      mustPass: {
        path: along,
        direction: first,
        toleranceM: MUST_PASS_TOLERANCE_M,
        minCoverage: MUST_PASS_MIN_COVERAGE,
        judge: PASS_JUDGE_VERSION,
        neighbors: pickNeighbors(geometry, c.roadSegments, r.segmentId),
        neighborsKnown: Array.isArray(c.roadSegments) && c.roadSegments.length > 0,
      },
      routeHints: { entry: along[0], exit: along[along.length - 1] },
      roadSource: {
        type: 'hdmap',
        basis: (r.dataSources || []).map(s => str(s, 80)).slice(0, 5),
      },
    };
  }

  function itemCenter(it) {
    const g = it.geometry;
    return { lat: g.reduce((a, p) => a + p[0], 0) / g.length, lng: g.reduce((a, p) => a + p[1], 0) / g.length };
  }

  function travelBetween(a, b, router, speedKmh) {
    const from = { lat: a.routeHints.exit[0], lng: a.routeHints.exit[1] };
    const to = { lat: b.routeHints.entry[0], lng: b.routeHints.entry[1] };
    const speed = Math.max(5, speedKmh || DEFAULT_SPEED_KMH);
    if (router && typeof router.route === 'function') {
      let r = null;
      try { r = router.route(from, to); } catch (_) { r = null; }
      if (r && isFinite(r.distanceM)) {
        const km = r.distanceM / 1000;
        return { distanceKm: Math.round(km * 10) / 10, minutes: Math.round(km / speed * 60), method: 'road_graph' };
      }
    }
    const km = SZ.distanceM(from.lat, from.lng, to.lat, to.lng) / 1000;
    return { distanceKm: Math.round(km * 10) / 10, minutes: Math.round(km / speed * 60), method: 'straight' };
  }

  function windowStart(it) {
    const s = it.timeWindow && TC && TC.parseClock ? TC.parseClock(it.timeWindow.start, false) : null;
    return s == null ? 24 * 60 : s;
  }

  /**
   * 방문 순서 추천 — 권장 시간대가 이른 것부터, 같은 시간대 안에서는
   * (점수 − 이동 분 × ORDER_TRAVEL_WEIGHT) 가 큰 것을 다음으로 고르는 탐욕 순서.
   * 시간대가 다른 항목을 앞당기지 않는다(시간대 조건 유지).
   */
  function orderPlanItems(items, options) {
    const o = options || {};
    const groups = new Map();
    items.forEach(it => { const k = windowStart(it); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); });
    const out = [];
    let prev = null;
    [...groups.keys()].sort((a, b) => a - b).forEach(k => {
      const pool = groups.get(k).slice();
      while (pool.length) {
        let best = null;
        pool.forEach(it => {
          const t = prev ? travelBetween(prev, it, o.router, o.speedKmh) : { minutes: 0 };
          const value = it.score - t.minutes * ORDER_TRAVEL_WEIGHT;
          if (!best || value > best.value || (value === best.value && it.itemId < best.it.itemId)) best = { it, value };
        });
        out.push(best.it);
        pool.splice(pool.indexOf(best.it), 1);
        prev = best.it;
      }
    });
    return out;
  }

  /**
   * 하루 수집 계획 만들기.
   * input: { recommendations:[도로 구간 추천], planDate, region, policy:{policyId,policyName}, window:{start,end},
   *          vehicleCount, router?, speedKmh?, now?, source:{appVersion, dataRevision}, order?:'auto'|'given', planId?, planVersion?,
   *          roadSegments?:[{id,geometry,…}] (그 지역 도로망 — 옆 도로), segmentStats?, directionFeedback?:[…] }
   */
  function buildCollectionPlan(input) {
    const o = input || {};
    const nowMs = o.now != null ? Number(o.now) : Date.now();
    const recs = (o.recommendations || []).filter(r => r && r.segmentId && Array.isArray(r.geometry) && r.geometry.length >= 2);
    if (!recs.length) throw new Error('계획에 넣을 도로 구간 추천이 없습니다 (자동 분석 추천이 필요합니다)');
    if (recs.length > MAX_ITEMS) throw new Error(`한 계획에는 ${MAX_ITEMS}구간까지 넣을 수 있습니다`);
    const ctx = { roadSegments: o.roadSegments, segmentStats: o.segmentStats, directionFeedback: o.directionFeedback, speedKmh: o.speedKmh,
      collectionSpeedKmh: o.collectionSpeedKmh,
      windowMinutes: minutesBetween(o.window) };
    const all = recs.map((r, i) => planItemFromRecommendation(r, i, ctx));
    // 가능한 방향이 하나도 없으면(모두 nav-app TMAP 실패 보고) 계획에 넣지 않고 이유를 남긴다
    const excludedItems = all.filter(it => !it.visits.length).map(it => ({ recommendationId: it.recommendationId, segmentId: it.segmentId, title: it.title,
      reason: it.directionPlan.excluded.map(e => `${DIR_LABEL[e.direction]}: ${e.reason}`).join(' · ') }));
    let items = all.filter(it => it.visits.length);
    if (!items.length) throw new Error('계획에 넣을 수 있는 방향이 없습니다 — ' + excludedItems.map(e => `${e.title}(${e.reason})`).join(', '));
    // 목표 미달 예상·부적합 항목에는 같은 조건의 대안(이어진 구간·더 긴 구간)을 붙인다 — 대안의 수집은 그 구간 목표로만 센다
    items.forEach(it => {
      it.alternatives = it.feasibility.status === 'shortfall' || it.estimate.unsuitable
        ? findAlternatives(it, o.candidates || o.recommendations, ctx).filter(a => !items.some(x => x.segmentId === a.segmentId && conditionOnlyKey(x.condition) === conditionOnlyKey(it.condition)))
        : [];
    });
    if (o.order !== 'given') items = orderPlanItems(items, o);
    items.forEach((it, i) => { it.order = i + 1; });
    const travel = [];
    for (let i = 1; i < items.length; i++) {
      const t = travelBetween(items[i - 1], items[i], o.router, o.speedKmh);
      travel.push({ fromItemId: items[i - 1].itemId, toItemId: items[i].itemId, distanceKm: t.distanceKm, minutes: t.minutes, method: t.method });
    }
    const collectKm = items.reduce((a, it) => a + it.lengthM * it.passes, 0) / 1000;
    const travelKm = travel.reduce((a, t) => a + t.distanceKm, 0);
    const region = o.region || (items[0] && items[0].parentZone) || '';
    // 같은 권장 시간대에 몰린 항목이 그 시간 안에 다 들어가는지 (이동 시간은 어림 — 실제는 nav-app TMAP 경로로 다시 본다)
    const byWindow = new Map();
    items.forEach(it => {
      const k = it.timeWindow ? `${it.timeWindow.start}~${it.timeWindow.end}` : '시간대 없음';
      if (!byWindow.has(k)) byWindow.set(k, { window: k, windowMinutes: minutesBetween(it.timeWindow), needMinutes: 0, items: [] });
      const g = byWindow.get(k);
      g.needMinutes += it.visits.length * (it.estimate.passSec + it.estimate.turnSec) / 60;
      g.items.push(it.itemId);
    });
    const warnings = [];
    byWindow.forEach(g => {
      g.needMinutes = Math.round(g.needMinutes);
      if (g.windowMinutes != null && g.needMinutes > g.windowMinutes) {
        warnings.push(`${g.window}: 계획 방문에 약 ${g.needMinutes}분이 드는데 시간대는 ${g.windowMinutes}분 — 뒤쪽 방문은 시간대 밖이 될 수 있습니다(시간대 밖 수집은 목표에 넣지 않음)`);
      }
    });
    items.forEach(it => {
      if (it.estimate.shortfallMinutes > 0) warnings.push(`${it.title}: ${it.estimate.note}`);
      it.directionPlan.excluded.forEach(e => warnings.push(`${it.title}: ${DIR_LABEL[e.direction]} 제외 — ${e.reason}`));
    });
    const plan = {
      format: PLAN_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      canonicalization: C14N,
      coordOrder: 'lat,lng',
      passJudge: PASS_JUDGE_VERSION,
      planId: o.planId || newId('cp', nowMs, items.map(i => i.segmentId).join(',')),
      planVersion: o.planVersion || 1,
      createdAt: new Date(nowMs).toISOString(),
      planDate: o.planDate || kstDate(nowMs),
      region,
      regionCode: REGION_CODE[region] || '',
      policy: o.policy ? { policyId: str(o.policy.policyId, 80), policyName: str(o.policy.policyName, 120) } : null,
      source: {
        app: 'route-viewer',
        appVersion: str(o.source && o.source.appVersion, 20),
        engine: 'segment-recommendation',
        dataRevision: str(o.source && o.source.dataRevision, 120),
        note: 'score·deficit 는 Route Viewer 추천 엔진 값 — 받는 쪽에서 다시 계산하지 않는다',
      },
      window: o.window && o.window.start ? { start: o.window.start, end: o.window.end } : null,
      vehicleCount: Math.max(1, Number(o.vehicleCount) || 1),
      items,
      excludedItems,
      travel,
      feasibility: {
        windows: [...byWindow.values()].map(g => ({ window: g.window, windowMinutes: g.windowMinutes, needMinutes: g.needMinutes, items: g.items })), warnings,
        speedKmh: items[0] ? items[0].estimate.speedKmh : COLLECTION_SPEED_KMH,
        summary: Object.keys(FEASIBILITY_LABEL).reduce((a, k) => { a[k] = items.filter(it => it.feasibility.status === k).length; return a; }, {}),
        note: '예상은 달성량이 아니다 — 달성은 주행 뒤 GPS 원본으로만. 방향은 nav-app TMAP 검증 전에는 확인 필요',
      },
      totals: {
        items: items.length,
        passes: items.reduce((a, it) => a + it.passes, 0),
        collectKm: Math.round(collectKm * 10) / 10,
        travelKm: Math.round(travelKm * 10) / 10,
        distanceKm: Math.round((collectKm + travelKm) * 10) / 10,
        collectMinutes: items.reduce((a, it) => a + it.estimatedMinutes, 0),
        travelMinutes: travel.reduce((a, t) => a + t.minutes, 0),
        deficitMinutes: items.reduce((a, it) => a + it.estimate.deficitMinutes, 0),
        expectedMinutes: Math.round(items.reduce((a, it) => a + it.estimate.expectedMinutes, 0) * 10) / 10,
        shortfallMinutes: Math.round(items.reduce((a, it) => a + it.estimate.shortfallMinutes, 0) * 10) / 10,
      },
    };
    return seal(plan);
  }

  const validPoint = q => Array.isArray(q) && q.length === 2 && inBounds(q[0], q[1]);

  function validateCollectionPlan(input) {
    const fail = msg => ({ ok: false, errors: [msg], plan: null, hash: null });
    const p = parseInput(input);
    if (p.error) return fail(p.error);
    const plan = p.doc;
    if (!plan || plan.format !== PLAN_FORMAT) return fail('수집 계획(CollectionPlan) 파일이 아닙니다');
    if (plan.schemaVersion !== SCHEMA_VERSION) return fail('지원하지 않는 계획 버전입니다');
    const secret = findSecret(plan, '');
    if (secret) return fail('비밀정보로 보이는 항목이 있습니다: ' + secret);
    const errors = [];
    if (!/^[A-Za-z0-9._-]{4,80}$/.test(String(plan.planId || ''))) errors.push('planId 형식이 틀렸습니다');
    if (!Number.isInteger(plan.planVersion) || plan.planVersion < 1) errors.push('planVersion 이 틀렸습니다');
    if (plan.coordOrder !== 'lat,lng') errors.push('좌표 순서가 lat,lng 가 아닙니다');
    if (!Array.isArray(plan.items) || !plan.items.length || plan.items.length > MAX_ITEMS) errors.push('계획 항목이 없거나 너무 많습니다');
    else {
      const ids = new Set();
      plan.items.forEach((it, i) => {
        const at = `항목 ${i + 1}`;
        if (!it || typeof it !== 'object') { errors.push(at + ': 형식'); return; }
        if (ids.has(it.itemId)) errors.push(at + ': itemId 중복'); ids.add(it.itemId);
        if (!it.segmentId) errors.push(at + ': segmentId 가 없습니다');
        const g = it.geometry;
        if (!Array.isArray(g) || g.length < 2 || g.length > MAX_GEOMETRY || !g.every(validPoint)) errors.push(at + ': 도로 형상 좌표가 틀렸습니다 ([위도, 경도])');
        if (!it.mustPass || !Array.isArray(it.mustPass.path) || it.mustPass.path.length < 2) errors.push(at + ': 필수 통과 구간이 없습니다');
        const nb = it.mustPass && it.mustPass.neighbors;
        if (nb != null && (!Array.isArray(nb) || nb.length > MAX_NEIGHBORS || !nb.every(l => Array.isArray(l) && l.length >= 2 && l.length <= MAX_NEIGHBOR_POINTS && l.every(validPoint)))) {
          errors.push(at + ': 옆 도로 좌표가 틀렸습니다');
        }
        if (!['forward', 'backward', 'both'].includes(it.direction && it.direction.id)) errors.push(at + ': 방향이 틀렸습니다');
        if (!Number.isInteger(it.passes) || it.passes < 1 || it.passes > MAX_PASSES) errors.push(at + `: 반복 횟수가 틀렸습니다 (1~${MAX_PASSES})`);
        if (it.visits != null && (!Array.isArray(it.visits) || it.visits.length !== it.passes || !it.visits.every(v => v && (v.direction === 'forward' || v.direction === 'backward')))) {
          errors.push(at + ': 방문별 방향이 틀렸습니다');
        }
      });
    }
    if (errors.length) return { ok: false, errors, plan: null, hash: null };
    const hash = documentHash(plan);
    if (!plan.integrity || plan.integrity.sha256 !== hash) return fail('SHA-256 검증 실패 — 계획 파일이 바뀌었거나 손상됐습니다');
    return { ok: true, errors: [], plan, hash, code: verifyCode(hash) };
  }

  // ══════════════════════════════════════════════════════
  //  C. DriveResult — nav-app 수행 보고
  // ══════════════════════════════════════════════════════

  function validateDriveResult(input) {
    const fail = msg => ({ ok: false, errors: [msg], result: null, hash: null });
    const p = parseInput(input);
    if (p.error) return fail(p.error);
    const r = p.doc;
    if (!r || r.format !== RESULT_FORMAT) return fail('주행 결과(DriveResult) 파일이 아닙니다');
    if (r.schemaVersion !== SCHEMA_VERSION) return fail('지원하지 않는 결과 버전입니다');
    const secret = findSecret(r, '');
    if (secret) return fail('비밀정보로 보이는 항목이 있습니다: ' + secret);
    const errors = [];
    if (!/^[A-Za-z0-9._-]{4,80}$/.test(String(r.resultId || ''))) errors.push('resultId 형식이 틀렸습니다');
    if (!/^[A-Za-z0-9._-]{4,80}$/.test(String(r.sessionId || ''))) errors.push('sessionId 형식이 틀렸습니다');
    if (!r.vehicle || typeof r.vehicle !== 'string') errors.push('차량이 없습니다');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.driveDate || ''))) errors.push('주행 날짜가 틀렸습니다');
    if (!isFinite(Date.parse(r.startedAt))) errors.push('시작 시각이 틀렸습니다');
    if (r.endedAt != null && !isFinite(Date.parse(r.endedAt))) errors.push('종료 시각이 틀렸습니다');
    if (!Array.isArray(r.legs)) errors.push('구간 결과가 없습니다');
    if (!r.gpsSource || typeof r.gpsSource !== 'object') errors.push('GPS 원본 참조(gpsSource)가 없습니다');
    if (r.driver != null || r.user != null) errors.push('개인 이름 항목은 받지 않습니다');
    if (errors.length) return { ok: false, errors, result: null, hash: null };
    const hash = documentHash(r);
    if (!r.integrity || r.integrity.sha256 !== hash) return fail('SHA-256 검증 실패 — 결과 파일이 바뀌었거나 손상됐습니다');
    return { ok: true, errors: [], result: r, hash };
  }

  /** nav-app TMAP 탐색 결과 파일 검사 — { checkId, planId, createdAt, vehicle, directionChecks:[{segmentId, direction, result, at}] } */
  function validateRouteCheck(input) {
    const fail = msg => ({ ok: false, errors: [msg], doc: null, hash: null });
    const p = parseInput(input);
    if (p.error) return fail(p.error);
    const d = p.doc;
    if (!d || d.format !== ROUTE_CHECK_FORMAT) return fail('탐색 결과(RouteCheck) 파일이 아닙니다');
    if (findSecret(d, '')) return fail('비밀정보로 보이는 항목이 있습니다');
    if (!/^[A-Za-z0-9._-]{4,80}$/.test(String(d.checkId || ''))) return fail('checkId 형식이 틀렸습니다');
    if (!Array.isArray(d.directionChecks) || !d.directionChecks.every(c => c && c.segmentId && (c.direction === 'forward' || c.direction === 'backward') && typeof c.result === 'string')) {
      return fail('구간·방향별 탐색 결과가 틀렸습니다');
    }
    const hash = documentHash(d);
    if (!d.integrity || d.integrity.sha256 !== hash) return fail('SHA-256 검증 실패 — 파일이 바뀌었거나 손상됐습니다');
    return { ok: true, errors: [], doc: d, hash };
  }

  /** 파일 내용이 어떤 연계 문서인가 — 'plan' | 'result' | 'package' | null */
  function detectDocument(text) {
    const p = parseInput(text);
    if (p.error || !p.doc || typeof p.doc !== 'object') return null;
    if (p.doc.format === PLAN_FORMAT) return 'plan';
    if (p.doc.format === RESULT_FORMAT) return 'result';
    if (p.doc.format === ROUTE_PACKAGE_FORMAT) return 'package';
    if (p.doc.format === ROUTE_CHECK_FORMAT) return 'routecheck';
    return null;
  }

  // ══════════════════════════════════════════════════════
  //  계획 대비 수행 — DB 의 GPS 원본으로 다시 계산한다
  // ══════════════════════════════════════════════════════

  function minutesOfClock(t) {
    const s = CS.timeToSec(t);
    return s == null ? null : s / 60;
  }

  /** 항목의 방문 방향 목록 — visits 가 없던 계획(v4.3 초판)은 direction 으로 만든다 */
  function itemVisitDirections(it) {
    if (Array.isArray(it.visits) && it.visits.length) return it.visits.map(v => v.direction);
    const id = it.direction && it.direction.id;
    const out = [];
    for (let p = 1; p <= (it.passes || 1); p++) out.push(id === 'both' ? (p % 2 === 1 ? 'forward' : 'backward') : (id === 'backward' ? 'backward' : 'forward'));
    return out;
  }

  /**
   * 계획 항목별 실제 수행 평가 — 통과 판정은 nav-app 과 같은 passJudge(nav-app-pass-v1).
   * input: { plan, result?, records:[{date,time,vehicle,lat,lng,speed,issueMask}] (차량·시각 순),
   *          roadSegments?:[{id, geometry}] — 계획에 옆 도로(mustPass.neighbors)가 없을 때(예전 계획) 그 지역 도로망에서 고른다 }
   *   records 는 그 결과의 차량·주행 날짜·시작~종료 시각(앞뒤 여유) 안의 GPS 원본이다.
   * 반환: { gpsStatus, roadIndex, items:[...], totals, gps, reported }
   *   gpsStatus: 'verified' | 'unverified'(GPS 원본 없음·모두 이슈) | 'low_quality'
   *   항목 status: 'achieved'(목표 달성) | 'passed'(권장 방향 통과 — 목표 미달) | 'wrong_direction' | 'partial' | 'not_driven' | 'unverified'
   *   routeFollowed(nav-app 보고: 계획 경로를 따라 마친 방문 수)와 GPS 판정은 따로 둔다 — 보고값으로 달성을 정하지 않는다.
   */
  function evaluatePlanExecution(input) {
    const o = input || {};
    const plan = o.plan;
    const rows = (o.records || []).filter(r => r && isFinite(r.lat) && isFinite(r.lng));
    const issueRows = rows.filter(r => (Number(r.issueMask) || 0) & 2);
    const usable = rows.filter(r => !((Number(r.issueMask) || 0) & 2));   // 이슈로 표시한 파일의 기록은 달성에 쓰지 않는다

    // GPS 품질 — 1초 기록 기준 공백(>5초)·점프(>50m/s) · 수집 시간(90초 규칙, 기존 통계와 같음)
    // 튄 점 다음 기록이 튄 점과 이어지면 튐이 아니라 자리 옮김(GPS 다시 잡힘) — 예전 위치와만 견주면 한 번 옮긴 뒤 모든 기록이 튐으로 세진다
    let gaps = 0, gapSec = 0, jumps = 0, relocations = 0, collectionSec = 0, prev = null, held = null;
    usable.forEach(r => {
      if (prev && prev.vehicle === r.vehicle && prev.date === r.date) {
        const d = CS.timeToSec(r.time) - CS.timeToSec(prev.time);
        if (d > 0) {
          if (SZ.distanceM(prev.lat, prev.lng, r.lat, r.lng) / d > 50) {
            const hd = held ? CS.timeToSec(r.time) - CS.timeToSec(held.time) : 0;
            if (held && hd > 0 && hd <= 60 && SZ.distanceM(held.lat, held.lng, r.lat, r.lng) / hd <= 50) { relocations++; held = null; prev = r; return; }
            if (held) jumps++;
            held = r;
            return;
          }
          if (held) { jumps++; held = null; }
          if (d > 5) { gaps++; gapSec += d; }
          if (d <= CS.COLLECTION_GAP_SEC) collectionSec += d;
        }
      } else if (held) { jumps++; held = null; }
      prev = r;
    });
    if (held) jumps++;
    const verified = usable.length > 0;
    const validRatio = rows.length ? usable.length / rows.length : 0;
    const lowQuality = verified && (jumps > Math.max(3, usable.length * 0.02) || validRatio < 0.5);
    const gpsStatus = !verified ? 'unverified' : lowQuality ? 'low_quality' : 'verified';

    // 차량·날짜별 궤적 (t = 그날 0시부터 초)
    const tracks = new Map();
    usable.forEach(r => {
      const k = `${r.vehicle}|${r.date}`;
      if (!tracks.has(k)) tracks.set(k, []);
      tracks.get(k).push({ lat: r.lat, lng: r.lng, t: CS.timeToSec(r.time) });
    });
    const adj = (o.result && o.result.planAdjustments) || {};
    const skipped = new Set((adj.skippedDirections || []).map(s => `${s.itemId}|${s.direction}`));
    const skippedItems = new Set(adj.skippedItems || []);
    const skippedVisits = new Set((adj.skippedVisits || []).map(v => v.key || `${v.itemId}|${v.passNo}`));
    let roadIndex = 'plan_neighbors';
    const items = plan.items.map(it => {
      let neighbors = it.mustPass && Array.isArray(it.mustPass.neighbors) && it.mustPass.neighborsKnown !== false ? it.mustPass.neighbors : null;
      if (!neighbors) {
        if (o.roadSegments && o.roadSegments.length) { neighbors = pickNeighbors(it.geometry, o.roadSegments, it.segmentId); if (roadIndex === 'plan_neighbors') roadIndex = 'region'; }
        else { neighbors = []; roadIndex = 'plan_only'; }
      }
      const ws = it.timeWindow && TC && TC.parseClock ? TC.parseClock(it.timeWindow.start, false) : null;
      const we = it.timeWindow && TC && TC.parseClock ? TC.parseClock(it.timeWindow.end, true) : null;
      const win = ws != null && we != null ? { fromSec: ws * 60, toSec: we * 60 } : null;
      const sum = { forward: null, backward: null };
      tracks.forEach(tr => {
        const j = passJudge(tr, it.geometry, { neighbors, window: win, toleranceM: (it.mustPass && it.mustPass.toleranceM) || MUST_PASS_TOLERANCE_M,
          minCoverage: (it.mustPass && it.mustPass.minCoverage) || MUST_PASS_MIN_COVERAGE });
        ['forward', 'backward'].forEach(d => {
          const s = sum[d] || (sum[d] = { cells: 0, coverage: 0, seconds: 0, windowSeconds: 0, passes: 0, windowPasses: 0, partials: 0, totalCells: j.totalCells, onNeighbor: 0 });
          s.coverage = Math.max(s.coverage, j[d].coverage);
          s.seconds += j[d].seconds; s.windowSeconds += j[d].windowSeconds;
          s.passes += j[d].passes; s.windowPasses += j[d].windowPasses; s.partials += j[d].partials;
          s.onNeighbor += j.onNeighbor;
        });
      });
      const empty = { coverage: 0, seconds: 0, windowSeconds: 0, passes: 0, windowPasses: 0, partials: 0, onNeighbor: 0 };
      const F = sum.forward || empty, B = sum.backward || empty;
      const dirs = itemVisitDirections(it);
      // 계획 방문 — nav-app 에서 뺀 방향·항목·방문(경로 탐색 실패로 뺀 것)은 이 계획의 목표 방문으로 세지 않는다
      const passNos = Array.isArray(it.visits) && it.visits.length ? it.visits.map(v => v.passNo) : dirs.map((d, i) => i + 1);
      const planned = dirs.filter((d, i) => !skipped.has(`${it.itemId}|${d}`) && !skippedItems.has(it.itemId) && !skippedVisits.has(`${it.itemId}|${passNos[i]}`));
      // 수집으로 인정하는 방향 — 계획이 허용한 방향 전부(양방향 항목은 방문이 한 번뿐이어도 두 방향).
      // nav-app 에서 뺀 방향(그 방향 경로가 없어 주행 계획에서 빠짐)은 이 계획의 수행으로 세지 않는다
      const allowed0 = it.directionPlan && Array.isArray(it.directionPlan.allowed) && it.directionPlan.allowed.length ? it.directionPlan.allowed
        : it.direction && it.direction.id === 'both' ? ['forward', 'backward'] : [...new Set(dirs)];
      const allowed = allowed0.filter(d => !skipped.has(`${it.itemId}|${d}`));
      const pick = d => (d === 'forward' ? F : B);
      const covRight = allowed.length ? Math.max(0, ...allowed.map(d => pick(d).coverage)) : 0;
      const notAllowed = ['forward', 'backward'].filter(d => !allowed.includes(d));
      const covWrong = notAllowed.length ? Math.max(...notAllowed.map(d => pick(d).coverage)) : 0;
      const secRight = allowed.reduce((a, d) => a + pick(d).seconds, 0);
      const secWin = allowed.reduce((a, d) => a + pick(d).windowSeconds, 0);
      const passAll = allowed.reduce((a, d) => a + pick(d).passes, 0);
      const passWin = allowed.reduce((a, d) => a + (win ? pick(d).windowPasses : pick(d).passes), 0);
      const partials = allowed.reduce((a, d) => a + pick(d).partials, 0);
      const minCov = (it.mustPass && it.mustPass.minCoverage) || MUST_PASS_MIN_COVERAGE;
      const passed = covRight >= minCov && passAll > 0;
      const collectedMin = Math.round(secRight / 6) / 10;
      const inWindowMin = Math.round(secWin / 6) / 10;
      const needMin = it.deficit.additionalMinutes;
      const plannedPasses = planned.length;
      const achieved = gpsStatus === 'verified' && passed && (win ? inWindowMin : collectedMin) >= needMin && passWin >= plannedPasses;
      let status;
      if (gpsStatus === 'unverified') status = 'unverified';
      else if (achieved) status = 'achieved';
      else if (passed) status = 'passed';
      else if (covWrong >= minCov) status = 'wrong_direction';
      else if (covRight > 0.2 || secRight >= 10) status = 'partial';   // 구간 끝을 스친 한두 칸은 '주행 안 함'으로 둔다
      else status = 'not_driven';
      const reasons = [];
      if (status === 'unverified') {
        reasons.push(issueRows.length
          ? `이 시간대 GPS 기록 ${issueRows.length}건이 모두 이슈로 표시돼 달성에 쓰지 않습니다 — 이슈 표시를 풀면 다시 계산합니다`
          : 'GPS 원본이 아직 없습니다 — 주행기록 엑셀이 들어오면 다시 계산합니다');
      }
      if (gpsStatus === 'low_quality') reasons.push('GPS 품질이 낮아(점프·이슈 기록) 완료로 확정하지 않습니다');
      if (status === 'wrong_direction') reasons.push(`권장 방향(${it.direction.label || it.direction.id})과 반대로 달렸습니다`);
      if (status === 'partial') reasons.push(`권장 방향으로 구간의 ${Math.round(covRight * 100)}%만 지났습니다 (기준 ${Math.round(minCov * 100)}% · 한 번에 이어서 지나야 통과)`);
      if (status === 'not_driven') reasons.push('이 구간 기록이 없습니다');
      if (status === 'passed') {
        if (win && inWindowMin < needMin) reasons.push(`권장 시간대(${it.timeWindow.start}~${it.timeWindow.end}) 수집 ${inWindowMin}분 / 부족분 ${needMin}분`);
        else if (!win && collectedMin < needMin) reasons.push(`수집 ${collectedMin}분 / 부족분 ${needMin}분`);
        if (passWin < plannedPasses) reasons.push(`${win ? '시간대 안 ' : ''}통과 ${passWin}회 / 계획 ${plannedPasses}회`);
      }
      if (partials) reasons.push(`일부만 지난 통과 ${partials}번은 세지 않았습니다`);
      const rep = o.result ? (o.result.legs || []).filter(l => l.planItemId === it.itemId && (l.kind || 'collect') === 'collect') : null;
      return {
        itemId: it.itemId, segmentId: it.segmentId, title: it.title, order: it.order,
        status, passed, achieved,
        coverageRight: Math.round(covRight * 1000) / 10,
        coverageWrong: Math.round(covWrong * 1000) / 10,
        directionOk: allowed.length === 2 ? null : covRight >= covWrong,
        coverageByDirection: { forward: Math.round(F.coverage * 1000) / 10, backward: Math.round(B.coverage * 1000) / 10 },
        collectedMinutes: collectedMin,
        inWindowMinutes: win ? inWindowMin : null,
        timeWindowOk: win ? inWindowMin > 0 : null,
        passCount: passWin, passCountAll: passAll, partialTraversals: partials, plannedPasses,
        needMinutes: needMin,
        neighborPoints: F.onNeighbor,
        // nav-app 보고 — 계획 경로를 따라 마친 방문 수 (GPS 판정과 다르다)
        routeFollowed: rep ? { completed: rep.filter(l => l.status === 'completed').length, visits: rep.length, note: 'nav-app 보고 — 수집 목표 판정에 쓰지 않음' } : null,
        reasons,
      };
    });
    const counts = { achieved: 0, passed: 0, wrong_direction: 0, partial: 0, not_driven: 0, unverified: 0 };
    items.forEach(i => { counts[i.status]++; });
    return {
      gpsStatus,
      gpsStatusLabel: gpsStatus === 'unverified' && issueRows.length ? '수행 보고 수신 / GPS 미검증 (기록이 모두 이슈 표시)'
        : { verified: 'GPS 검증됨', unverified: '수행 보고 수신 / GPS 미검증', low_quality: 'GPS 품질 낮음 — 완료 미확정' }[gpsStatus],
      passJudge: PASS_JUDGE_VERSION,
      roadIndex,
      roadIndexNote: { plan_neighbors: '계획에 담긴 옆 도로로 판정 (nav-app 과 같은 입력)', region: '지역 도로망에서 옆 도로를 골라 판정 (예전 계획)',
        plan_only: '옆 도로 정보 없이 계획 구간만으로 판정 — 옆 도로·이어진 구간 기록이 섞여 수집량이 부풀 수 있음' }[roadIndex],
      items,
      totals: {
        items: items.length,
        ...counts,
        passRate: items.length ? Math.round((items.filter(i => i.passed).length / items.length) * 1000) / 10 : 0,
        achieveRate: items.length ? Math.round((counts.achieved / items.length) * 1000) / 10 : 0,
      },
      gps: {
        records: rows.length, usableRecords: usable.length, issueRecords: issueRows.length,
        validRatio: Math.round(validRatio * 1000) / 10,
        gaps, gapSec, jumps, relocations,
        collectionMinutes: Math.round(collectionSec / 6) / 10,
      },
      reported: o.result ? {
        legsCompleted: (o.result.legs || []).filter(l => l.status === 'completed').length,
        distanceKm: o.result.summary ? o.result.summary.distanceKm : null,
        note: 'nav-app 보고값 — 참고용이며 달성 판정에는 쓰지 않는다',
      } : null,
    };
  }

  /** 주행 결과들의 planAdjustments → 방향 피드백 (다음 계획의 directionFeasibility 입력) */
  function directionFeedbackFromResults(results) {
    const out = [];
    (results || []).forEach(r => {
      (r && Array.isArray(r.directionChecks) ? r.directionChecks : []).forEach(c => {
        if (c && c.segmentId && (c.direction === 'forward' || c.direction === 'backward') && c.result) {
          out.push({ segmentId: c.segmentId, direction: c.direction, cause: c.result, at: c.at || r.endedAt || r.createdAt, resultId: r.resultId || r.checkId });
        }
      });
      const adj = r && r.planAdjustments;
      (adj && adj.skippedDirections || []).forEach(s => {
        if (s && s.segmentId && (s.direction === 'forward' || s.direction === 'backward') && s.cause) {
          out.push({ segmentId: s.segmentId, direction: s.direction, cause: s.cause, at: r.endedAt || r.createdAt, resultId: r.resultId });
        }
      });
    });
    return out;
  }

  /**
   * 계획별 진행 상태 — 증거가 있는 것만 단계로 표시한다. 전달(nav-app 이 받았는지)은 그 계획을 가리키는 주행 결과가 와야만 '확인'.
   * exportInfo: { exportedAt, fileName } | null · results: listDriveResults 행(evaluation 포함) · failures: [{fileName, reason, at}]
   * → { stage, label, steps:[{key,label,state:'done'|'wait'|'unknown'|'fail',detail}] }
   */
  function planStatus(plan, exportInfo, results, failures) {
    const rs = (results || []).filter(r => r.planId === plan.planId && !r.supersededBy);
    const fails = failures || [];
    const verified = rs.filter(r => r.gpsStatus === 'verified');
    const low = rs.filter(r => r.gpsStatus === 'low_quality');
    const steps = [
      { key: 'created', label: '계획 생성', state: 'done', detail: String(plan.createdAt || '').slice(0, 16).replace('T', ' ') },
      { key: 'exported', label: '파일로 내보냄', state: exportInfo ? 'done' : 'unknown', detail: exportInfo ? `${String(exportInfo.exportedAt || '').slice(0, 16).replace('T', ' ')} · ${exportInfo.fileName || ''}` : '내보낸 기록 없음(이 PC 에서 보내지 않았거나 예전 버전)' },
      { key: 'delivered', label: 'nav-app 전달', state: rs.length ? 'done' : 'unknown', detail: rs.length ? '주행 결과가 이 계획을 가리킴 — 전달 확인' : '상태 확인 불가 (파일 전달은 기록이 남지 않음 — 결과가 오면 확인)' },
      { key: 'result', label: '결과 수신', state: rs.length ? 'done' : fails.length ? 'fail' : 'wait', detail: rs.length ? `${rs.length}건` : fails.length ? `가져오기 실패 ${fails.length}건` : '결과 대기' },
      { key: 'gps', label: 'GPS 검증', state: verified.length ? 'done' : low.length ? 'fail' : rs.length ? 'wait' : 'unknown',
        detail: verified.length ? 'GPS 원본으로 판정' : low.length ? 'GPS 품질 낮음' : rs.length ? 'GPS 미검증 — 주행기록 엑셀 대기' : '' },
    ];
    let stage, label;
    if (verified.length) { stage = 'gps_verified'; label = 'GPS 검증 완료'; }
    else if (low.length) { stage = 'gps_low_quality'; label = 'GPS 품질 낮음'; }
    else if (rs.length) { stage = 'gps_unverified'; label = '결과 수신 · GPS 미검증'; }
    else if (fails.length) { stage = 'import_failed'; label = '가져오기 실패'; }
    else if (exportInfo) { stage = 'waiting'; label = '결과 대기 (전달 확인 불가)'; }
    else { stage = 'created'; label = '계획 생성 (전달 상태 확인 불가)'; }
    return { planId: plan.planId, planVersion: plan.planVersion, stage, label, steps, results: rs.length, failures: fails };
  }

  /** 결과의 GPS 원본을 찾을 범위 (차량 · 날짜 · 시각) — 앞뒤 5분 여유 */
  function resultRecordWindow(result) {
    const s = Date.parse(result.startedAt);
    const e = Date.parse(result.endedAt || result.lastHeartbeatAt || result.startedAt);
    const pad = 5 * 60 * 1000;
    // 여유를 붙여도 주행 날짜(KST) 밖으로 넘기지 않는다 (자정 직후 시작·자정 직전 종료)
    const from = kstDate(s - pad) === result.driveDate ? kstClock(s - pad) : '00:00:00';
    const to = kstDate(Math.max(s, e) + pad) === result.driveDate ? kstClock(Math.max(s, e) + pad) : '23:59:59';
    return { vehicle: result.vehicle, date: result.driveDate, fromTime: from, toTime: to };
  }

  // ══════════════════════════════════════════════════════
  //  추천 전후 비교 — 계획 때 점수·부족량 vs 지금 추천 엔진 결과
  // ══════════════════════════════════════════════════════
  /**
   * currentRecs: 새 데이터로 다시 돌린 도로 구간 추천(전체 목록, 숨김 전)
   * → [{ itemId, segmentId, beforeScore, afterScore, beforeNeedMinutes, afterNeedMinutes, needReducedMinutes, status, reason }]
   *   status: 'resolved'(목표 충족 — 추천에서 빠짐) | 'lowered' | 'unchanged' | 'raised' | 'unknown'
   */
  // 같은 조건 키 — 구간 · 요일 유형 · 교통 시간대 · 조도. 방향은 넣지 않는다:
  // 추천 엔진은 기록이 쌓이면 방향을 다시 정한다(양방향 → 적게 모인 쪽) — 그래도 같은 조건의 같은 부족분이다.
  function conditionKey(segmentId, c) {
    return [segmentId, c && c.weekdayType || '', c && c.trafficPeriod || '', c && c.lightCondition || ''].join('|');
  }

  function compareRecommendations(plan, currentRecs, evaluation) {
    const byKey = new Map();
    (currentRecs || []).forEach(r => {
      if (!r || !r.segmentId) return;
      const k = conditionKey(r.segmentId, r.condition);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    return plan.items.map(it => {
      const same = byKey.get(conditionKey(it.segmentId, it.condition)) || [];
      let now = same.find(r => r.id === it.recommendationId) || same[0] || null;
      const ev = evaluation ? evaluation.items.find(e => e.itemId === it.itemId) : null;
      // 한 방향 항목인데 엔진이 반대 방향을 권하게 됐다 = 계획 방향이 더 많이 모였다.
      // 그 추천의 부족분은 반대 방향 것이라 계획 방향과 견주지 않는다 (목록에 없는 경우와 같이 다룬다).
      let flipped = null;
      if (now && it.direction.id !== 'both' && now.direction && now.direction.id !== it.direction.id) { flipped = now; now = null; }
      const beforeScore = it.score, beforeNeed = it.deficit.additionalMinutes;
      const afterNeed = now ? Math.round((now.need && now.need.additionalMinutes) || 0) : null;
      const afterScore = now ? Math.round(now.score * 10) / 10 : null;
      let status, reason;
      if (flipped) {
        const other = `반대 방향(${flipped.direction.label || flipped.direction.id}) 부족분 ${Math.round((flipped.need && flipped.need.additionalMinutes) || 0)}분`;
        if (ev && ev.status === 'achieved') { status = 'resolved'; reason = `목표 달성(GPS 확인) — 이제 ${other}을 권합니다`; }
        else {
          status = 'unknown';
          reason = `계획 방향(${it.direction.label || it.direction.id})보다 반대 방향이 덜 모여 엔진이 그쪽을 권합니다 — 계획 방향의 남은 부족분은 추천에 없습니다 (${other}` +
            (ev && ev.inWindowMinutes != null ? ` · GPS 판정: 시간대 수집 ${ev.inWindowMinutes}분 / 부족분 ${ev.needMinutes}분` : '') + ')';
        }
      } else if (now && afterNeed === 0) {
        status = 'resolved'; reason = '이 조건의 부족분이 0분이 됐습니다';
      } else if (!now) {
        // 추천 목록에 없다고 목표를 채운 것은 아니다 — 엔진은 구간마다 상위 몇 개 조건만 남긴다.
        // GPS 원본으로 목표 달성을 확인한 경우에만 '충족'으로 본다.
        if (!currentRecs || !currentRecs.length) { status = 'unknown'; reason = '현재 추천 결과가 없어 비교하지 못했습니다'; }
        else if (ev && ev.status === 'achieved') { status = 'resolved'; reason = '목표 달성(GPS 확인) — 이 조건이 추천 목록에서 빠졌습니다'; }
        else {
          status = 'unknown';
          reason = '추천 목록에 이 조건이 없습니다 — 구간당 상위 조건만 남기므로 목표 충족 여부는 알 수 없습니다' +
            (ev && ev.inWindowMinutes != null ? ` (GPS 판정: 시간대 수집 ${ev.inWindowMinutes}분 / 부족분 ${ev.needMinutes}분)` : '');
        }
      } else if (afterScore < beforeScore - 0.5) { status = 'lowered'; reason = `부족분 ${beforeNeed}분 → ${afterNeed}분으로 줄어 점수가 낮아졌습니다`; }
      else if (afterScore > beforeScore + 0.5) { status = 'raised'; reason = '다른 조건(정책·미방문 기간 등)이 바뀌어 점수가 올랐습니다'; }
      else { status = 'unchanged'; reason = afterNeed < beforeNeed ? `부족분이 ${beforeNeed - afterNeed}분 줄었지만 점수 변화는 작습니다` : '새로 반영된 기록이 이 조건을 채우지 못했습니다'; }
      if (ev && ev.status === 'unverified') reason += ' · GPS 원본 미검증';
      if (now && now.id !== it.recommendationId) reason += ` · 권장 방향이 ${it.direction.label || it.direction.id} → ${now.direction.label || now.direction.id}(으)로 바뀜`;
      return {
        itemId: it.itemId, segmentId: it.segmentId, recommendationId: it.recommendationId, currentRecommendationId: now ? now.id : null, title: it.title,
        beforeScore, afterScore, beforeNeedMinutes: beforeNeed, afterNeedMinutes: afterNeed,
        // 목록에 없어 모르는 경우는 줄었다고 하지 않는다
        needReducedMinutes: afterNeed == null ? (status === 'resolved' ? beforeNeed : 0) : Math.max(0, beforeNeed - afterNeed),
        status, reason,
      };
    });
  }

  return {
    PLAN_FORMAT, RESULT_FORMAT, ROUTE_PACKAGE_FORMAT, SCHEMA_VERSION, C14N, MAX_BYTES,
    MUST_PASS_TOLERANCE_M, MUST_PASS_MIN_COVERAGE,
    c14n, sha256Hex, documentHash, verifyCode, seal,
    planItemFromRecommendation, orderPlanItems, buildCollectionPlan, validateCollectionPlan,
    validateDriveResult, detectDocument,
    evaluatePlanExecution, resultRecordWindow, compareRecommendations,
    PASS_JUDGE_VERSION, PASS_JUDGE_DEFAULTS, passJudge, pickNeighbors, directionFeasibility, estimatePasses, itemVisitDirections,
    directionFeedbackFromResults, planStatus, MAX_PASSES, DIRECTION_STATUS_LABEL,
    itemFeasibility, findAlternatives, endpointConnectivity, conditionOnlyKey, FEASIBILITY_LABEL, COLLECTION_SPEED_KMH,
    ROUTE_CHECK_FORMAT, validateRouteCheck,
    kstDate, kstClock,
  };
}));
