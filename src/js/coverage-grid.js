// ══════════════════════════════════════════════════════════
//  coverage-grid — 연속된 두 GPS 좌표 사이의 이동 segment가 지나가는
//  Coverage 격자 칸을 전부 계산한다(Amanatides & Woo 스타일 grid
//  traversal). GPS가 ~10초 간격으로 찍혀도, "GPS가 실제로 찍힌 칸"만이
//  아니라 "그 사이 실제로 지나갔을 모든 칸"을 방문으로 잡기 위함이다.
//
//  desktop(Electron/SQLite, electron/database.js)과 브라우저
//  (IndexedDB, src/js/storage.js) 두 백엔드가 완전히 같은 판정 로직을
//  쓰도록 이 파일 하나로 공유한다 — parser.js와 같은 UMD 패턴
//  (Node require / 브라우저 전역 CoverageGrid).
//
//  이 파일은 순수 계산만 한다 — DB 조회, date/vehicle 그룹핑, bbox 필터
//  같은 I/O는 각 백엔드(database.js/storage.js)가 맡는다. 도로/건물/
//  아파트/주차장 판정(accum.js)과도 완전히 무관하다 — 여기서 내놓는
//  {gy,gx,visits}는 "그 칸을 실제로 지나갔는가"만 말해준다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CoverageGrid = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // GPS가 보통 ~10초 간격이라 이보다 넉넉히 잡는다 — 이보다 더 비면
  // 그 사이 기록이 유실된 것으로 보고 이동 경로를 추정하지 않는다.
  const MAX_INTERPOLATION_GAP_SEC = 30;
  // 도시 주행에서 나올 수 없는 속도로 두 점이 떨어져 있으면 좌표 점프로
  // 보고 연결하지 않는다. quality.js의 TELEPORT_SPEED_KMH와 값(150)은
  // 같지만 "GPS 기록 품질 검사"와 "Coverage interpolation 허용 여부"는
  // 별개 의미라 상수를 따로 둔다 — 하나를 바꿔도 다른 하나에 영향 없게.
  const MAX_INTERPOLATION_SPEED_KMH = 150;

  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // timestamp는 "YYYY-MM-DDTHH:MM:SS" 형태(문자열) — Date.parse로 초 단위 차를 잰다.
  function timeDiffSec(tsA, tsB) {
    const a = Date.parse(tsA), b = Date.parse(tsB);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return (b - a) / 1000;
  }

  // accum.js/database.js와 완전히 같은 격자 기준 — 절대 어긋나면 안 된다.
  //   gy = Math.floor(lat / latDeg)
  //   gx = Math.floor(lng / lngDeg)
  function cellOf(lat, lng, latDeg, lngDeg) {
    return { gy: Math.floor(lat / latDeg), gx: Math.floor(lng / lngDeg) };
  }

  // A→B 이동 segment가 지나가는 모든 격자 칸을(A, B 자신의 칸 포함) 순서대로
  // 반환한다 — 고정 간격으로 점을 찍어 보간하는 방식이 아니라, grid line을
  // 실제로 넘는 지점마다 정확히 한 칸씩 전진하는 DDA(Amanatides & Woo,
  // 1987) 방식이라 대각선/얕은 각도에서도 칸을 놓치지 않는다.
  //
  // 격자 꼭짓점을 정확히 지나가는 경우(가로/세로 경계를 동시에 넘음)는
  // "supercover"로 처리해서, 모서리만 스치는 양옆 두 칸도 같이 넣는다 —
  // 그래야 연속한 칸끼리 항상 변을 공유해서 대각선 방향 구멍이 안 생긴다.
  function traverseCells(aLat, aLng, bLat, bLng, latDeg, lngDeg) {
    const u0 = aLat / latDeg, v0 = aLng / lngDeg;
    const u1 = bLat / latDeg, v1 = bLng / lngDeg;
    let gy = Math.floor(u0), gx = Math.floor(v0);
    const endGy = Math.floor(u1), endGx = Math.floor(v1);
    const cells = [{ gy, gx }];
    if (gy === endGy && gx === endGx) return cells;

    const du = u1 - u0, dv = v1 - v0;
    const stepY = du > 0 ? 1 : (du < 0 ? -1 : 0);
    const stepX = dv > 0 ? 1 : (dv < 0 ? -1 : 0);
    const tDeltaY = stepY !== 0 ? Math.abs(1 / du) : Infinity;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dv) : Infinity;
    let tMaxY = stepY > 0 ? ((gy + 1) - u0) / du : (stepY < 0 ? (gy - u0) / du : Infinity);
    let tMaxX = stepX > 0 ? ((gx + 1) - v0) / dv : (stepX < 0 ? (gx - v0) / dv : Infinity);

    // 안전장치 — 부동소수 오차로 무한루프에 빠지지 않도록 한다(정상적인
    // 경우엔 격자 칸 이동 횟수가 이 범위를 절대 넘지 않는다).
    const maxSteps = (Math.abs(endGy - gy) + Math.abs(endGx - gx)) * 2 + 8;
    for (let steps = 0; !(gy === endGy && gx === endGx) && steps < maxSteps; steps++) {
      if (stepY !== 0 && stepX !== 0 && Math.abs(tMaxY - tMaxX) < 1e-9) {
        cells.push({ gy: gy + stepY, gx });
        cells.push({ gy, gx: gx + stepX });
        gy += stepY; gx += stepX;
        tMaxY += tDeltaY; tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        gy += stepY; tMaxY += tDeltaY;
      } else {
        gx += stepX; tMaxX += tDeltaX;
      }
      cells.push({ gy, gx });
    }
    return cells;
  }

  // points: 이미 시간순 정렬된 "같은 date+vehicle" 한 묶음(파티션). 각
  // {lat,lng,timestamp}. visitCounts(Map<'gy_gx', number>)에 이 묶음에서
  // 나온 방문을 더해서 반환한다 — 파티션을 섞지 않는 건 호출부 책임이다
  // (날짜/차량이 다르면 절대 같은 배열로 넘기면 안 된다).
  //
  // 판정 순서:
  //  1) 연속 두 점 사이 시간차(0 < dt <= maxGapSec)와 추정 속도(<=
  //     maxSpeedKmh)가 둘 다 통과하면 그 사이를 traverseCells로 채운다.
  //  2) 통과 못하면(기록 유실/좌표 점프) 사이를 잇지 않는다 — 대신 그
  //     GPS 포인트 자신의 칸은 그대로 방문 기록에 남는다.
  //  3) 이렇게 만든 "지나간 칸" 순서열에서 바로 이웃한 같은 칸은
  //     압축한다(연속 segment 경계에서 중복 카운트 방지) — 칸이 실제로
  //     바뀔 때만 방문 1회. 칸을 벗어났다가 나중에 다시 들어오면(순서열
  //     안에서 같은 칸이 다시 나타나면) 그건 새 방문으로 센다.
  function accumulatePartitionVisits(points, latDeg, lngDeg, visitCounts, opts) {
    const maxGapSec = (opts && opts.maxGapSec) || MAX_INTERPOLATION_GAP_SEC;
    const maxSpeedKmh = (opts && opts.maxSpeedKmh) || MAX_INTERPOLATION_SPEED_KMH;
    if (!points || !points.length) return visitCounts;

    const sequence = [];
    let prev = null;
    points.forEach(p => {
      const cell = cellOf(p.lat, p.lng, latDeg, lngDeg);
      if (prev) {
        const dtSec = timeDiffSec(prev.timestamp, p.timestamp);
        let connected = false;
        if (dtSec != null && dtSec > 0 && dtSec <= maxGapSec) {
          const distM = haversineM(prev.lat, prev.lng, p.lat, p.lng);
          const speedKmh = (distM / dtSec) * 3.6;
          connected = speedKmh <= maxSpeedKmh;
        }
        if (connected) {
          const traversed = traverseCells(prev.lat, prev.lng, p.lat, p.lng, latDeg, lngDeg);
          for (let i = 1; i < traversed.length; i++) sequence.push(traversed[i]);
        } else {
          sequence.push(cell);
        }
      } else {
        sequence.push(cell);
      }
      prev = p;
    });

    let lastKey = null;
    sequence.forEach(({ gy, gx }) => {
      const key = gy + '_' + gx;
      if (key !== lastKey) {
        visitCounts.set(key, (visitCounts.get(key) || 0) + 1);
        lastKey = key;
      }
    });
    return visitCounts;
  }

  // ── 수동 셀 오버라이드 저장 형식 ─────────────────────────────
  // {excluded:[[lat,lng],...], visited:[...], unvisited:[...]} — SQLite(zones.manual_cells)
  // /IndexedDB(zones.manualCells)/백업/서버 동기화가 모두 이 형식을 쓴다.
  // unvisited는 v3.1.3에 추가됐다. 예전 데이터에는 이 필드가 없으므로 읽을 때
  // 항상 빈 배열로 채운다(DB 마이그레이션 없이 호환).
  const MANUAL_CELL_LISTS = ['excluded', 'unvisited', 'visited']; // 한 칸이 여러 상태면 앞쪽이 우선

  function isLatLngPair(p) {
    return Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
  }

  function normalizeManualCells(data) {
    const out = {};
    MANUAL_CELL_LISTS.forEach(name => {
      const list = data && Array.isArray(data[name]) ? data[name] : [];
      out[name] = list.filter(isLatLngPair).map(p => [Number(p[0]), Number(p[1])]);
    });
    return { excluded: out.excluded, visited: out.visited, unvisited: out.unvisited };
  }

  function manualCellPointKey(p) {
    return Number(p[0]).toFixed(7) + ',' + Number(p[1]).toFixed(7);
  }

  // 백업 복원/서버 동기화용 병합 — 같은 칸 중심점(좌표 7자리)이면 incoming 상태가
  // 이기고, base에만 있는 칸은 그대로 남는다. 한 점은 결과에서 한 목록에만 들어간다.
  // (칸 격자 키는 구역 경계에 따라 달라지므로 여기선 저장된 중심점 좌표로만 맞춘다 —
  //  격자 기준 최종 정리는 화면(accum.js)이 현재 격자로 다시 한다)
  function mergeManualCellsByPoint(base, incoming) {
    const states = new Map();
    const absorb = data => {
      const n = normalizeManualCells(data);
      // 우선순위가 낮은 목록부터 넣어서, 같은 입력 안에서 겹치면 높은 쪽이 남게 한다
      [...MANUAL_CELL_LISTS].reverse().forEach(name => {
        n[name].forEach(p => states.set(manualCellPointKey(p), { name, p }));
      });
    };
    absorb(base);
    absorb(incoming);
    const out = { excluded: [], visited: [], unvisited: [] };
    states.forEach(({ name, p }) => out[name].push(p));
    return out;
  }

  function hasManualCells(data) {
    const n = normalizeManualCells(data);
    return MANUAL_CELL_LISTS.some(name => n[name].length > 0);
  }

  // Coverage 격자 한 칸 크기(m) — 화면(accum.js)·SQLite·IndexedDB의 단일 기준.
  // 50m였다가 건물/아파트를 더 정확히 빼려고 20m로 줄였다. 사용자 설정값이 아니다.
  const DEFAULT_CELL_SIZE_M = 20;

  return {
    MAX_INTERPOLATION_GAP_SEC,
    MAX_INTERPOLATION_SPEED_KMH,
    DEFAULT_CELL_SIZE_M,
    MANUAL_CELL_LISTS,
    haversineM,
    timeDiffSec,
    cellOf,
    traverseCells,
    accumulatePartitionVisits,
    normalizeManualCells,
    mergeManualCellsByPoint,
    hasManualCells,
  };
}));
