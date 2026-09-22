(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoadContext = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 1;
  const TYPES = Object.freeze(['NORMAL_ROAD', 'INTERSECTION', 'MERGE_AREA', 'DIVERGE_AREA', 'HIGHWAY', 'RAMP', 'SCHOOL_ZONE', 'UNKNOWN']);
  const DEFAULTS = Object.freeze({ junctionRadiusM: 28, topologyRadiusM: 35 });
  const rad = d => d * Math.PI / 180;
  function distanceM(a, b) { const x = rad(Number(b.lng) - Number(a.lng)) * Math.cos(rad((Number(a.lat) + Number(b.lat)) / 2)); const y = rad(Number(b.lat) - Number(a.lat)); return Math.sqrt(x*x+y*y)*6371000; }
  function evidence(value, source, confidence) { return { value, source, confidence }; }
  function classContexts(roadClass) {
    const s = String(roadClass || '').toLowerCase(), out = [];
    if (/motorway|trunk|highway|express/.test(s)) out.push(evidence('HIGHWAY', 'HD_MAP', 'HIGH'));
    if (/ramp|link|ic|jc/.test(s)) out.push(evidence('RAMP', 'HD_MAP', 'HIGH'));
    return out;
  }
  function classifyPoint(point, graph, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return [evidence('UNKNOWN', 'NONE', 'LOW')];
    const explicit = Array.isArray(point.roadContexts) ? point.roadContexts : (point.roadContext ? [point.roadContext] : []);
    const verified = explicit.filter(v => TYPES.includes(v) && v !== 'UNKNOWN').map(v => evidence(v, point.roadContextSource || 'HD_MAP', point.roadContextConfidence || 'HIGH'));
    if (point.schoolZoneConfirmed === true) verified.push(evidence('SCHOOL_ZONE', 'HD_MAP', 'HIGH'));
    if (!graph || !graph.nodes) return verified.length ? unique(verified) : [evidence('UNKNOWN', 'NONE', 'LOW')];
    const nodes = graph.nodes instanceof Map ? [...graph.nodes.values()] : Object.values(graph.nodes || {});
    const near = nodes.filter(n => Number.isFinite(n.lat) && Number.isFinite(n.lng) && distanceM(point, n) <= o.topologyRadiusM);
    if (near.some(n => Number(n.degree) >= 3)) verified.push(evidence('INTERSECTION', 'ROAD_GRAPH', 'HIGH'));
    const matched = point.matchedSegment || point.segment || null;
    if (matched) {
      verified.push(...classContexts(matched.roadClass || matched.class));
      if (matched.semanticTypes && matched.semanticTypes.includes('MERGE')) verified.push(evidence('MERGE_AREA', 'ROAD_GRAPH', 'HIGH'));
      if (matched.semanticTypes && matched.semanticTypes.includes('DIVERGE')) verified.push(evidence('DIVERGE_AREA', 'ROAD_GRAPH', 'HIGH'));
      if (!verified.length) verified.push(evidence('NORMAL_ROAD', 'HD_MAP', 'HIGH'));
    }
    return verified.length ? unique(verified) : [evidence('UNKNOWN', 'NONE', 'LOW')];
  }
  function unique(items) { const seen = new Set(); return items.filter(x => !seen.has(x.value) && seen.add(x.value)); }
  function analyzeTrajectory(rows, graph, options) { return (rows || []).map(r => classifyPoint(r, graph, options)); }
  return { VERSION, TYPES, DEFAULTS, distanceM, classifyPoint, analyzeTrajectory };
}));
