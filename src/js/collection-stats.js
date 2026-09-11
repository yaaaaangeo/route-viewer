// ══════════════════════════════════════════════════════════
//  collection-stats — 데이터 수집 시간 · 수집 목표/진행률 (순수 계산)
//
//  desktop(SQLite, electron/database.js의 buildDaySummary)과 브라우저
//  (IndexedDB, src/js/core.js의 buildDaySummaryFromPoints)가 날짜 요약을 만들 때
//  같은 규칙으로 "유효 수집 시간"을 계산하도록 이 파일 하나로 공유한다
//  (coverage-grid.js와 같은 UMD 패턴 — Node require / 브라우저 전역 CollectionStats).
//
//  유효 수집 시간(collectionSec) — 날짜 요약에 날짜별로 저장된다:
//    1) 그 날짜의 기록을 차량별로 나눈다
//    2) 차량마다 시각(HH:MM:SS) 오름차순으로 정렬한다(같은 시각이 여러 개면 하나로 본다)
//    3) 연속된 두 기록의 간격이 0초 초과 · COLLECTION_GAP_SEC(90초) 이하면 그 간격을 더한다
//    4) 90초보다 긴 간격은 "GPS 공백"(quality.js·database.js의 GAP_THRESHOLD_SEC와 같은
//       기준)으로 보고 더하지 않는다 → 오전 1시간 + 오후 1시간 = 2시간(9시간 아님)
//    5) 차량별 합계를 더한다(여러 차량이 동시에 수집하면 각각 따로 센다)
//  기록은 이미 import 때 date|time|vehicle|lat|lng로 중복 제거돼 DB에 있는 것만 쓴다.
//  전체 수집 시간 = 모든 날짜 요약의 collectionSec 합(원본 기록을 다시 읽지 않는다).
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CollectionStats = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 이보다 긴 기록 간격은 수집 시간에서 뺀다 — quality.js/database.js GAP_THRESHOLD_SEC(90)와 같은 값
  const COLLECTION_GAP_SEC = 90;

  // 날짜 요약 형식 버전 — 2: collectionSec 추가. 예전 요약은 앱을 켤 때 한 번 다시 만든다.
  const SUMMARY_VERSION = 2;

  // 수집 목표 — 여기 한 곳에서만 관리한다(화면 표의 행도 이 목록으로 그린다)
  const COLLECTION_TARGETS = [
    { key: 'kpi', label: 'KPI', targetClips: 8000, targetMinutes: 4000 },
    { key: 'proposal', label: '제안', targetClips: 20000, targetMinutes: 10000 },
  ];

  function timeToSec(t) {
    if (!t) return null;
    const parts = String(t).split(':').map(Number);
    if (parts.length < 3 || parts.some(n => !Number.isFinite(n))) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  // rows: 한 날짜의 기록들 [{time:'HH:MM:SS', vehicle}, ...] (순서 무관)
  function validDurationSec(rows, maxGapSec) {
    const gap = maxGapSec || COLLECTION_GAP_SEC;
    const byVehicle = new Map();
    for (const r of rows || []) {
      const t = timeToSec(r && r.time);
      if (t == null) continue;
      const v = String((r && r.vehicle) || '');
      if (!byVehicle.has(v)) byVehicle.set(v, []);
      byVehicle.get(v).push(t);
    }
    let total = 0;
    byVehicle.forEach(times => {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const dt = times[i] - times[i - 1];
        if (dt > 0 && dt <= gap) total += dt;
      }
    });
    return total;
  }

  // 날짜 요약 목록 → 전체 누적 {totalSec, dateCount, latestDate, missing}
  // missing: collectionSec가 없는(아직 다시 만들지 않은 예전) 요약 수 — 정상이면 0
  function summarizeCollection(summaries) {
    let totalSec = 0, dateCount = 0, missing = 0, latestDate = null;
    for (const s of summaries || []) {
      if (!s) continue;
      dateCount++;
      if (Number.isFinite(s.collectionSec)) totalSec += s.collectionSec;
      else missing++;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(s.date || '')) && (!latestDate || s.date > latestDate)) latestDate = s.date;
    }
    return { totalSec, dateCount, latestDate, missing };
  }

  // 진행률은 수집 시간 기준. 퍼센트는 100%로 자르지 않고, 막대 너비만 100%로 자른다.
  function collectionProgress(totalSec, targets) {
    const sec = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
    const minutes = sec / 60;
    return {
      collectedSec: sec,
      collectedMinutes: Math.round(minutes),
      rows: (targets || COLLECTION_TARGETS).map(t => {
        const percent = t.targetMinutes > 0 ? (minutes / t.targetMinutes) * 100 : 0;
        return { ...t, collectedMinutes: Math.round(minutes), percent, barPercent: Math.min(percent, 100) };
      }),
    };
  }

  function formatPercent(percent) {
    const p = Number.isFinite(percent) ? percent : 0;
    return (Math.round(p * 10) / 10).toFixed(1) + '%';
  }

  return {
    COLLECTION_GAP_SEC,
    SUMMARY_VERSION,
    COLLECTION_TARGETS,
    timeToSec,
    validDurationSec,
    summarizeCollection,
    collectionProgress,
    formatPercent,
  };
}));
