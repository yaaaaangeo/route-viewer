(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EgoManeuver = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const MANEUVERS = Object.freeze(['STRAIGHT', 'LEFT_TURN', 'RIGHT_TURN', 'U_TURN', 'MERGE', 'DIVERGE', 'UNKNOWN']);
  const DRIVING_STATES = Object.freeze(['MOVING', 'SLOW', 'STOPPED', 'UNKNOWN']);
  const SOURCES = Object.freeze({ trajectory: 'GPS_TRAJECTORY', roadGraph: 'ROAD_GRAPH' });
  const DEFAULTS = Object.freeze({
    stoppedKmh: 1, slowKmh: 10, minMovementM: 12, minTurnMovementM: 20,
    straightMaxDeg: 28, turnMinDeg: 42, uTurnMinDeg: 145, windowSec: 18, maxGapSec: 45,
  });

  const rad = d => d * Math.PI / 180;
  function distanceM(a, b) {
    if (!a || !b) return 0;
    const la1 = Number(a.lat), lo1 = Number(a.lng), la2 = Number(b.lat), lo2 = Number(b.lng);
    if (![la1, lo1, la2, lo2].every(Number.isFinite)) return 0;
    const x = rad(lo2 - lo1) * Math.cos(rad((la1 + la2) / 2));
    const y = rad(la2 - la1);
    return Math.sqrt(x * x + y * y) * 6371000;
  }
  function bearing(a, b) {
    if (distanceM(a, b) < 0.5) return null;
    const p1 = rad(Number(a.lat)), p2 = rad(Number(b.lat)), dl = rad(Number(b.lng) - Number(a.lng));
    return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
  }
  function signedDelta(from, to) { return ((to - from + 540) % 360) - 180; }
  function seconds(row) {
    const value = row && (row.timestamp || (row.date && row.time ? `${row.date}T${row.time}` : row.time));
    if (!value) return null;
    if (/^\d\d:\d\d:\d\d/.test(String(value))) {
      const p = String(value).split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2];
    }
    const n = Date.parse(value); return Number.isFinite(n) ? n / 1000 : null;
  }
  function drivingState(row, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    const speed = Number(row && row.speed);
    if (!Number.isFinite(speed) || speed < 0) return { value: 'UNKNOWN', source: SOURCES.trajectory, confidence: 'LOW' };
    if (speed <= o.stoppedKmh) return { value: 'STOPPED', source: SOURCES.trajectory, confidence: 'HIGH' };
    if (speed < o.slowKmh) return { value: 'SLOW', source: SOURCES.trajectory, confidence: 'HIGH' };
    return { value: 'MOVING', source: SOURCES.trajectory, confidence: 'HIGH' };
  }
  function classifyWindow(points, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    const clean = (points || []).filter(p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
    if (clean.length < 3) return { value: 'UNKNOWN', source: SOURCES.trajectory, confidence: 'LOW', headingChangeDeg: 0, distanceM: 0 };
    let dist = 0; for (let i = 1; i < clean.length; i++) dist += distanceM(clean[i - 1], clean[i]);
    if (dist < o.minMovementM) return { value: 'UNKNOWN', source: SOURCES.trajectory, confidence: 'LOW', headingChangeDeg: 0, distanceM: Math.round(dist) };
    const pivot = Math.max(1, Math.min(clean.length - 2, Math.floor(clean.length / 2)));
    const b1 = bearing(clean[0], clean[pivot]);
    const b2 = bearing(clean[pivot], clean[clean.length - 1]);
    if (b1 == null || b2 == null) return { value: 'UNKNOWN', source: SOURCES.trajectory, confidence: 'LOW', headingChangeDeg: 0, distanceM: Math.round(dist) };
    const change = signedDelta(b1, b2), abs = Math.abs(change);
    let value = 'UNKNOWN', confidence = 'LOW';
    if (abs <= o.straightMaxDeg) { value = 'STRAIGHT'; confidence = dist >= o.minTurnMovementM ? 'HIGH' : 'MEDIUM'; }
    else if (dist >= o.minTurnMovementM && abs >= o.uTurnMinDeg) { value = 'U_TURN'; confidence = 'HIGH'; }
    else if (dist >= o.minTurnMovementM && abs >= o.turnMinDeg) { value = change < 0 ? 'LEFT_TURN' : 'RIGHT_TURN'; confidence = abs >= 65 ? 'HIGH' : 'MEDIUM'; }
    return { value, source: SOURCES.trajectory, confidence, headingChangeDeg: Math.round(change), distanceM: Math.round(dist) };
  }
  function analyzeTrajectory(rows, options) {
    const o = { ...DEFAULTS, ...(options || {}) }, input = rows || [], result = new Array(input.length);
    const groups = new Map();
    input.forEach((row, index) => { const key = String((row && row.vehicle) || ''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ row, index, sec: seconds(row) }); });
    groups.forEach(list => {
      list.sort((a, b) =>
        (a.sec == null ? Infinity : a.sec) - (b.sec == null ? Infinity : b.sec) ||
        Number(a.row.latitude ?? a.row.lat ?? 0) - Number(b.row.latitude ?? b.row.lat ?? 0) ||
        Number(a.row.longitude ?? a.row.lng ?? a.row.lon ?? 0) - Number(b.row.longitude ?? b.row.lng ?? b.row.lon ?? 0) ||
        a.index - b.index
      );
      let lo = 0, hi = 0;
      for (let i = 0; i < list.length; i++) {
        const center = list[i];
        let window;
        if (center.sec == null) window = list.slice(Math.max(0, i - 2), Math.min(list.length, i + 3)).map(x => x.row);
        else {
          while (lo < list.length && list[lo].sec != null && list[lo].sec < center.sec - o.windowSec) lo++;
          if (hi < i) hi = i;
          while (hi < list.length && list[hi].sec != null && list[hi].sec <= center.sec + o.windowSec) hi++;
          window = list.slice(lo, hi).map(x => x.row);
        }
        let maneuver = classifyWindow(window, o);
        const hint = center.row && center.row.roadGraphManeuver;
        if ((hint === 'MERGE' || hint === 'DIVERGE') && center.row.roadGraphConfirmed === true) maneuver = { value: hint, source: SOURCES.roadGraph, confidence: 'HIGH', headingChangeDeg: maneuver.headingChangeDeg, distanceM: maneuver.distanceM };
        result[center.index] = { maneuver, drivingState: drivingState(center.row, o) };
      }
    });
    return result;
  }
  return { VERSION, MANEUVERS, DRIVING_STATES, SOURCES, DEFAULTS, distanceM, bearing, signedDelta, drivingState, classifyWindow, analyzeTrajectory };
}));
