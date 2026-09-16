// ══════════════════════════════════════════════════════════
//  condition-stats — 조건(구역·차량·요일·교통 시간대·조도·날씨)별 기록 수·수집 시간 집계
//
//  1) 날짜 요약을 만들 때(buildConditionSummary) 그 날짜 기록을 "조건 칸(conditionCells)"으로 묶는다.
//     칸 = zone × vehicle × weekdayType × trafficPeriod × lightCondition × weather 조합 하나.
//     칸마다 기록 수 · 유효 수집 시간(초) · 첫/마지막 시각을 저장한다(하루에 보통 수십 칸).
//  2) 달력·통계·향후 추천은 원본 기록을 다시 읽지 않고 날짜 요약의 칸들만 더한다(aggregate).
//     SQLite·IndexedDB가 같은 함수로 같은 칸을 만들므로 두 저장소의 집계 결과가 같다.
//
//  유효 수집 시간은 collection-stats.js 와 같은 규칙이다(차량별 시각 정렬, 0초 초과 90초 이하
//  간격만 더함, 긴 GPS 공백은 제외). 간격 하나는 "간격이 시작되는 기록"의 조건 칸에 넣는다.
//  그래서 칸들의 collectionSec 합 = 그 날짜의 collectionSec(CollectionStats.validDurationSec).
//  같은 차량·같은 시각 기록이 여러 개면(좌표만 다름) 좌표 문자열 순으로 첫 기록을 대표로 쓴다 —
//  저장소마다 행을 읽는 순서가 달라도 결과가 같게 하려는 것이다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./time-conditions.js'), require('./collection-stats.js'));
  } else {
    root.ConditionStats = factory(root.TimeConditions, root.CollectionStats);
  }
}(typeof self !== 'undefined' ? self : this, function (TC, CS) {
  'use strict';

  const CELL_DIMENSIONS = Object.freeze(['zone', 'vehicle', 'weekdayType', 'trafficPeriod', 'lightCondition', 'weather']);
  const DIMENSION_LABELS = Object.freeze({
    zone: '구역', vehicle: '차량', weekdayType: '요일', trafficPeriod: '교통', lightCondition: '조도', weather: '날씨',
  });
  const DIMENSION_ORDERS = Object.freeze({
    trafficPeriod: [...TC.TRAFFIC_PERIOD_IDS, TC.UNKNOWN],
    lightCondition: [...TC.LIGHT_CONDITION_IDS, TC.UNKNOWN],
    weekdayType: [...TC.WEEKDAY_TYPE_IDS, TC.UNKNOWN],
  });

  const str = v => (v == null ? '' : String(v).trim());
  const SLOW_SPEED_KMH = 10;

  // rows: 한 날짜의 기록 [{date,time,vehicle,zone,weather,lat,lng}] (순서 무관)
  // → { classificationSignature, conditionCells:[...] }
  function buildConditionSummary(rows, config) {
    const cfg = config || TC.classificationConfig({});
    const cells = new Map();
    const annotated = [];
    for (const r of rows || []) {
      if (!r) continue;
      const cls = TC.classifyRecord(r, cfg);
      const cell = {
        zone: str(r.zone), vehicle: str(r.vehicle), weekdayType: cls.weekdayType,
        trafficPeriod: cls.trafficPeriod, lightCondition: cls.lightCondition, weather: str(r.weather),
      };
      const key = CELL_DIMENSIONS.map(d => cell[d]).join('');
      let acc = cells.get(key);
      if (!acc) {
        acc = { ...cell, recordCount: 0, collectionSec: 0, firstTime: null, lastTime: null, speedCount: 0, speedSumTenths: 0, stoppedCount: 0, slowCount: 0 };
        cells.set(key, acc);
      }
      acc.recordCount++;
      // 차량속도(km/h) — 0.1km/h 단위 정수로 더한다(실수 합은 저장소마다 더하는 순서가 달라 끝자리가 흔들린다).
      // 정차(0)와 저속(0 초과 10 미만)은 따로 센다. 정체 여부는 이 값만으로 단정하지 않는다(정차엔 대기·주차도 섞임).
      const speed = parseFloat(r.speed);
      if (Number.isFinite(speed) && speed >= 0) {
        acc.speedCount++;
        acc.speedSumTenths += Math.round(speed * 10);
        if (speed === 0) acc.stoppedCount++;
        else if (speed < SLOW_SPEED_KMH) acc.slowCount++;
      }
      const sec = CS.timeToSec(r.time);
      if (sec != null) {
        const t = str(r.time);
        if (acc.firstTime === null || t < acc.firstTime) acc.firstTime = t;
        if (acc.lastTime === null || t > acc.lastTime) acc.lastTime = t;
        annotated.push({
          sec, key, vehicle: str(r.vehicle),
          coord: `${Number(r.lat).toFixed(6)}|${Number(r.lng).toFixed(6)}`,
        });
      }
    }

    // 차량별 유효 수집 시간을 조건 칸에 나눠 담는다 (CollectionStats.validDurationSec 와 같은 간격 규칙)
    const byVehicle = new Map();
    for (const a of annotated) {
      if (!byVehicle.has(a.vehicle)) byVehicle.set(a.vehicle, []);
      byVehicle.get(a.vehicle).push(a);
    }
    byVehicle.forEach(list => {
      list.sort((x, y) => (x.sec - y.sec) || (x.coord < y.coord ? -1 : x.coord > y.coord ? 1 : 0) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
      let rep = list[0]; // 지금 시각 묶음의 대표 기록
      for (let i = 1; i < list.length; i++) {
        if (list[i].sec === list[i - 1].sec) continue;
        const dt = list[i].sec - list[i - 1].sec;
        if (dt > 0 && dt <= CS.COLLECTION_GAP_SEC) cells.get(rep.key).collectionSec += dt;
        rep = list[i];
      }
    });

    const conditionCells = [...cells.values()].sort((a, b) => {
      for (const d of CELL_DIMENSIONS) { if (a[d] < b[d]) return -1; if (a[d] > b[d]) return 1; }
      return 0;
    });
    return { classificationSignature: TC.classificationSignature(cfg), conditionCells };
  }

  function isStale(summary, signature) {
    if (!summary || !Array.isArray(summary.conditionCells)) return true;
    return signature != null && summary.classificationSignature !== signature;
  }

  function matchValue(want, actual) {
    if (want == null || want === '' || want === 'all') return true;
    return Array.isArray(want) ? want.includes(actual) : want === actual;
  }

  // storage.js matches()/database.js _filterSql 과 같은 날짜·구역·차량 의미론 + 조건 축 필터
  function summaryMatchesDate(date, f) {
    if (f.date && date !== f.date) return false;
    if ((f.fromDate || f.toDate) && !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
    if (f.fromDate && !(date >= f.fromDate)) return false;
    if (f.toDate && !(date <= f.toDate)) return false;
    return true;
  }

  function cellMatches(cell, f) {
    if (!matchValue(f.zone, cell.zone)) return false;
    if (!matchValue(f.vehicle, cell.vehicle)) return false;
    if (f.vehicleLike && cell.vehicle.indexOf(f.vehicleLike) < 0) return false;
    if (!matchValue(f.weekdayType, cell.weekdayType)) return false;
    if (!matchValue(f.trafficPeriod, cell.trafficPeriod)) return false;
    if (!matchValue(f.lightCondition, cell.lightCondition)) return false;
    if (!matchValue(f.weather, cell.weather)) return false;
    return true;
  }

  function sortRows(rows, groupBy) {
    return rows.sort((a, b) => {
      for (const d of groupBy) {
        const order = DIMENSION_ORDERS[d];
        if (order) {
          const ia = order.indexOf(a[d]), ib = order.indexOf(b[d]);
          if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        } else if (a[d] !== b[d]) {
          return a[d] < b[d] ? -1 : 1;
        }
      }
      return 0;
    });
  }

  // summaries: 날짜 요약 목록(listDateSummaries 결과)
  // options.filter: {zone, vehicle, vehicleLike, date, fromDate, toDate, weekdayType, trafficPeriod, lightCondition, weather}
  //                 (각 조건 축은 값 하나 또는 배열)
  // options.groupBy: CELL_DIMENSIONS 중 원하는 축들(없으면 전체 합계 한 줄)
  // options.signature: 현재 분류 서명 — 다르면 staleDates 로 센다(집계에는 그대로 포함)
  // options.details: true 면 행마다 uniqueDays(고유 수집일) · vehicleSeconds/vehicleRecordCounts(차량별) ·
  //                  speed(기록 수 · 평균 · 정차/저속 비율)를 더 붙인다(추천 엔진용)
  // → { rows:[{...축, recordCount, collectionSec, collectionMinutes, visitCount, lastVisitedAt}], totals, staleDates, dateCount }
  //   visitCount = 그 조합에 기록이 있는 (날짜, 차량) 수 · lastVisitedAt = 마지막 기록 시각(+09:00)
  function aggregate(summaries, options) {
    const o = options || {};
    const f = o.filter || {};
    const groupBy = (o.groupBy || []).filter(d => CELL_DIMENSIONS.includes(d));
    const tzSuffix = TC.timezoneOffsetString(TC.DEFAULT_TIMEZONE);
    const groups = new Map();
    let staleDates = 0, dateCount = 0;
    const totals = { recordCount: 0, collectionSec: 0 };
    const totalVisits = new Set();

    for (const s of summaries || []) {
      if (!s) continue;
      if (!summaryMatchesDate(s.date, f)) continue;
      dateCount++;
      if (isStale(s, o.signature)) staleDates++;
      for (const cell of s.conditionCells || []) {
        if (!cellMatches(cell, f)) continue;
        const key = groupBy.map(d => cell[d]).join('');
        let g = groups.get(key);
        if (!g) {
          g = { dims: {}, recordCount: 0, collectionSec: 0, visits: new Set(), last: null, dates: new Set(), vehicleSec: {}, vehicleRec: {}, speedCount: 0, speedSumTenths: 0, stoppedCount: 0, slowCount: 0 };
          groupBy.forEach(d => { g.dims[d] = cell[d]; });
          groups.set(key, g);
        }
        g.recordCount += cell.recordCount;
        g.collectionSec += cell.collectionSec;
        if (o.details) {
          g.dates.add(s.date);
          g.vehicleSec[cell.vehicle] = (g.vehicleSec[cell.vehicle] || 0) + cell.collectionSec;
          g.vehicleRec[cell.vehicle] = (g.vehicleRec[cell.vehicle] || 0) + cell.recordCount;
          g.speedCount += cell.speedCount || 0;
          g.speedSumTenths += cell.speedSumTenths || 0;
          g.stoppedCount += cell.stoppedCount || 0;
          g.slowCount += cell.slowCount || 0;
        }
        const visit = `${s.date}|${cell.vehicle}`;
        g.visits.add(visit);
        totalVisits.add(visit);
        if (cell.lastTime) {
          const at = `${s.date}T${cell.lastTime}`;
          if (!g.last || at > g.last) g.last = at;
        }
        totals.recordCount += cell.recordCount;
        totals.collectionSec += cell.collectionSec;
      }
    }

    const sortedObj = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
    const rows = sortRows([...groups.values()].map(g => {
      const row = {
        ...g.dims,
        recordCount: g.recordCount,
        collectionSec: g.collectionSec,
        collectionMinutes: Math.round(g.collectionSec / 60),
        visitCount: g.visits.size,
        lastVisitedAt: g.last && /^\d{4}-\d{2}-\d{2}T/.test(g.last) ? g.last + tzSuffix : null,
      };
      if (o.details) {
        row.uniqueDays = [...g.dates].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).length;
        row.vehicleSeconds = sortedObj(g.vehicleSec);
        row.vehicleRecordCounts = sortedObj(g.vehicleRec);
        const moving = g.speedCount - g.stoppedCount;
        row.speed = {
          count: g.speedCount,
          averageKmh: g.speedCount ? Math.round(g.speedSumTenths / g.speedCount) / 10 : null,
          movingAverageKmh: moving > 0 ? Math.round(g.speedSumTenths / moving) / 10 : null,
          stoppedRatio: g.speedCount ? Math.round((g.stoppedCount / g.speedCount) * 1000) / 1000 : null,
          slowRatio: g.speedCount ? Math.round((g.slowCount / g.speedCount) * 1000) / 1000 : null,
        };
      }
      return row;
    }), groupBy);
    return {
      rows,
      totals: { ...totals, collectionMinutes: Math.round(totals.collectionSec / 60), visitCount: totalVisits.size },
      staleDates,
      dateCount,
    };
  }

  // 없는 조합도 0으로 채운다 — "일몰 전후 데이터가 없는 구역" 같은 질문용.
  // values: {zone:['강남','판교'], lightCondition:['sunset']} 처럼 축별 전체 후보
  function fillMissing(rows, values) {
    const dims = Object.keys(values || {});
    const index = new Map((rows || []).map(r => [dims.map(d => r[d]).join(''), r]));
    let combos = [{}];
    dims.forEach(d => {
      const next = [];
      combos.forEach(c => (values[d] || []).forEach(v => next.push({ ...c, [d]: v })));
      combos = next;
    });
    return sortRows(combos.map(c => index.get(dims.map(d => c[d]).join(''))
      || { ...c, recordCount: 0, collectionSec: 0, collectionMinutes: 0, visitCount: 0, lastVisitedAt: null }), dims);
  }

  function dimensionValueLabel(dim, value) {
    if (dim === 'trafficPeriod') return TC.TRAFFIC_PERIOD_LABELS[value] || value;
    if (dim === 'lightCondition') return TC.LIGHT_CONDITION_LABELS[value] || value;
    if (dim === 'weekdayType') return TC.WEEKDAY_TYPE_LABELS[value] || value;
    if (dim === 'weather') return value || '정보 없음';
    return value || '정보 없음';
  }

  // 조건을 섞지 않고 축별로 따로 — [{dim, axis:'교통', value:'퇴근 피크'}, ...]
  function describeConditions(obj, dims) {
    const list = dims || ['weekdayType', 'trafficPeriod', 'lightCondition', 'weather'];
    return list.filter(d => obj && obj[d] !== undefined)
      .map(d => ({ dim: d, axis: DIMENSION_LABELS[d], value: dimensionValueLabel(d, obj[d]) }));
  }

  // '평일 · 퇴근 피크 · 일몰 전후 · 비'
  function formatConditions(obj, dims) {
    return describeConditions(obj, dims).map(x => x.value).join(' · ');
  }

  return {
    CELL_DIMENSIONS,
    DIMENSION_LABELS,
    DIMENSION_ORDERS,
    buildConditionSummary,
    isStale,
    aggregate,
    fillMissing,
    dimensionValueLabel,
    describeConditions,
    formatConditions,
  };
}));
