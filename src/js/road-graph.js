// ══════════════════════════════════════════════════════════
//  road-graph — 지도 도로 데이터 → 분석용 도로망(Graph)과 Segment
//
//  HD Map 은 짧은 선 조각(중앙값 57m, 3,350개)으로 들어온다. 조각 하나하나로는 추천할 수 없고,
//  "테헤란로 전체"로 묶으면 너무 크다. 그래서 조각을 이어 붙이되 다음 지점에서 끊는다.
//
//    · 교차로(끝점을 세 갈래 이상이 공유하는 노드)
//    · 도로명이 바뀌는 지점
//    · 도로 등급이 바뀌는 지점(지도 데이터에 등급이 있을 때만)
//    · 상위 구역 경계 밖으로 나가는 지점
//    · 최대 길이(기본 800m)
//
//  ⚠ 이름은 지도 데이터에 적힌 것만 쓴다. 없으면 '이름 없는 도로'로 두고 지어내지 않는다.
//  ⚠ Segment id 는 분석을 다시 돌려도 같아야 한다(사용자 보정이 id 로 붙어 있기 때문).
//     id = 상위 구역 + 도로명 + 좌표 지문(fnv1a) 이라, 지도 데이터가 그대로면 id 도 그대로다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./subzones.js'));
  } else {
    root.RoadGraph = factory(root.SubZones);
  }
}(typeof self !== 'undefined' ? self : this, function (SZ) {
  'use strict';

  // 판정식을 바꾸면 올린다 — 저장해 둔 분석 결과가 이 버전과 다르면 다시 분석한다
  const ROAD_GRAPH_VERSION = 1;

  const DEFAULTS = Object.freeze({
    nodeSnapDigits: 5,      // 끝점을 노드로 묶는 정밀도(5자리 ≈ 1.1m) — HD Map 은 끝점이 정확히 맞는다
    maxSegmentM: 800,       // 이보다 길면 끊는다(추천 구간이 너무 길어지지 않게)
    minSegmentM: 30,        // 이보다 짧은 꼬리는 앞 Segment 에 붙인다
  });

  const UNNAMED = SZ.UNNAMED_ROAD;
  const nameOf = line => (SZ.isUsableRoadName(line && line.name) ? String(line.name).trim() : UNNAMED);

  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  const nodeKey = (p, digits) => `${p[0].toFixed(digits)},${p[1].toFixed(digits)}`;

  function lineLengthM(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += SZ.distanceM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    return sum;
  }

  // ── 1) 도로망 Graph ───────────────────────────────────
  // lines: [{name, points:[[lat,lng],...], class?}]
  // → { nodes: Map(key → {key, lat, lng, degree, edgeIds}), edges: [{id, name, roadClass, points, from, to, lengthM}] }
  function buildGraph(lines, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    const nodes = new Map();
    const edges = [];
    const touch = (key, point) => {
      if (!nodes.has(key)) nodes.set(key, { key, lat: point[0], lng: point[1], degree: 0, edgeIds: [] });
      return nodes.get(key);
    };
    (lines || []).forEach((line, i) => {
      const pts = (line && line.points) || [];
      if (pts.length < 2) return;
      const lengthM = lineLengthM(pts);
      if (lengthM <= 0) return;
      const fromKey = nodeKey(pts[0], o.nodeSnapDigits);
      const toKey = nodeKey(pts[pts.length - 1], o.nodeSnapDigits);
      const edge = {
        id: `e${i}`, name: nameOf(line), roadClass: line.class || null,
        points: pts, from: fromKey, to: toKey, lengthM,
      };
      const a = touch(fromKey, pts[0]);
      const b = touch(toKey, pts[pts.length - 1]);
      a.degree++; a.edgeIds.push(edge.id);
      if (toKey !== fromKey) { b.degree++; b.edgeIds.push(edge.id); }
      edges.push(edge);
    });
    return { nodes, edges, byId: new Map(edges.map(e => [e.id, e])) };
  }

  // 교차로 = 세 갈래 이상이 만나는 노드. 두 갈래뿐이면 도로가 이어지는 중간 지점이다.
  const isJunction = node => node.degree >= 3;

  // ── 2) Segment 자동 분할 ──────────────────────────────
  // graph 를 걸어가며 "교차로에서 교차로까지" 한 덩어리로 묶는다.
  // 도중에 도로명·등급이 바뀌거나 최대 길이를 넘으면 거기서 끊는다.
  function buildSegments(graph, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    const parentZone = o.parentZone || '';
    const polygon = o.polygon || null;
    const used = new Set();
    const segments = [];

    const insidePolygon = pts => !polygon || pts.some(([la, lo]) => SZ.pointInPolygon(la, lo, polygon));

    // 노드에서 이어지는 다음 조각 하나(같은 이름·등급, 아직 안 쓴 것)를 찾는다.
    // 두 갈래 노드에서만 이어 붙인다 — 교차로에서는 무조건 끊는다.
    function nextEdge(nodeKeyAt, fromEdge) {
      const node = graph.nodes.get(nodeKeyAt);
      if (!node || isJunction(node)) return null;
      const candidates = node.edgeIds
        .filter(id => id !== fromEdge.id && !used.has(id))
        .map(id => graph.byId.get(id))
        .filter(e => e && e.name === fromEdge.name && (e.roadClass || null) === (fromEdge.roadClass || null));
      return candidates.length === 1 ? candidates[0] : null;
    }

    graph.edges.forEach(start => {
      if (used.has(start.id)) return;
      used.add(start.id);
      let points = start.points.slice();
      let lengthM = start.lengthM;
      let endKey = start.to;
      let startKey = start.from;
      const memberIds = [start.id];
      let cutReason = '교차로';

      // 앞으로 이어 붙이기
      let cur = start;
      while (lengthM < o.maxSegmentM) {
        const next = nextEdge(endKey, cur);
        if (!next) break;
        used.add(next.id);
        memberIds.push(next.id);
        const forward = next.from === endKey;
        const nextPts = forward ? next.points : next.points.slice().reverse();
        points = points.concat(nextPts.slice(1));
        lengthM += next.lengthM;
        endKey = forward ? next.to : next.from;
        cur = next;
      }
      if (lengthM >= o.maxSegmentM) cutReason = '최대 길이';

      // 뒤로도 이어 붙이기(시작 조각이 도로 중간이었을 수 있다)
      cur = start;
      while (lengthM < o.maxSegmentM) {
        const prev = nextEdge(startKey, cur);
        if (!prev) break;
        used.add(prev.id);
        memberIds.unshift(prev.id);
        const forward = prev.to === startKey;
        const prevPts = forward ? prev.points : prev.points.slice().reverse();
        points = prevPts.slice(0, -1).concat(points);
        lengthM += prev.lengthM;
        startKey = forward ? prev.from : prev.to;
        cur = prev;
      }

      if (!insidePolygon(points)) return;
      segments.push(makeSegment({ parentZone, name: start.name, roadClass: start.roadClass, points, lengthM, startKey, endKey, memberIds, cutReason, graph }));
    });

    // 너무 짧은 Segment 는 같은 이름의 이웃에 붙인다(추천 목록이 10m 짜리로 도배되지 않게)
    const merged = [];
    segments.sort((a, b) => a.roadName.localeCompare(b.roadName) || b.lengthM - a.lengthM);
    segments.forEach(seg => {
      if (seg.lengthM >= o.minSegmentM) { merged.push(seg); return; }
      const host = merged.find(m => m.roadName === seg.roadName && (m.startNode === seg.endNode || m.endNode === seg.startNode));
      if (!host) { merged.push(seg); return; }
      host.geometry = host.endNode === seg.startNode ? host.geometry.concat(seg.geometry.slice(1)) : seg.geometry.concat(host.geometry.slice(1));
      host.lengthM += seg.lengthM;
      host.memberEdgeIds = host.memberEdgeIds.concat(seg.memberEdgeIds);
      if (host.endNode === seg.startNode) host.endNode = seg.endNode; else host.startNode = seg.startNode;
      refreshSegmentGeometry(host);
    });
    return merged.sort((a, b) => b.lengthM - a.lengthM);
  }

  function makeSegment({ parentZone, name, roadClass, points, lengthM, startKey, endKey, memberIds, cutReason, graph }) {
    const seg = {
      // 좌표 지문 — 같은 지도 데이터면 다시 분석해도 같은 id 가 나온다
      id: '',
      parentZone,
      roadName: name,
      named: name !== UNNAMED,
      roadClass: roadClass || null,
      geometry: points,
      lengthM: Math.round(lengthM),
      startNode: startKey,
      endNode: endKey,
      memberEdgeIds: memberIds,
      cutReason,
      startJunction: !!(graph.nodes.get(startKey) && isJunction(graph.nodes.get(startKey))),
      endJunction: !!(graph.nodes.get(endKey) && isJunction(graph.nodes.get(endKey))),
      semanticTypes: [],
      source: { type: 'hdmap', identifiers: memberIds },
    };
    refreshSegmentGeometry(seg);
    seg.id = segmentId(seg);
    return seg;
  }

  function refreshSegmentGeometry(seg) {
    const pts = seg.geometry;
    seg.start = { lat: pts[0][0], lng: pts[0][1] };
    seg.end = { lat: pts[pts.length - 1][0], lng: pts[pts.length - 1][1] };
    seg.bearing = SZ.bearingDeg(seg.start.lat, seg.start.lng, seg.end.lat, seg.end.lng);
    seg.headingLabel = SZ.compassOf(seg.bearing);
    seg.backHeadingLabel = SZ.compassOf((seg.bearing + 180) % 360);
    seg.center = {
      lat: pts.reduce((a, p) => a + p[0], 0) / pts.length,
      lng: pts.reduce((a, p) => a + p[1], 0) / pts.length,
    };
  }

  // 안정적인 id — 상위 구역 + 도로명 + 좌표 지문(양끝을 정렬해서 방향이 뒤집혀도 같은 값)
  function segmentId(seg) {
    const a = `${seg.start.lat.toFixed(5)},${seg.start.lng.toFixed(5)}`;
    const b = `${seg.end.lat.toFixed(5)},${seg.end.lng.toFixed(5)}`;
    const ends = [a, b].sort().join('~');
    return `${seg.parentZone}:${seg.roadName}:${fnv1a(`${ends}|${seg.lengthM}`)}`;
  }

  // ── 3) 이름 붙이기 ────────────────────────────────────
  // 도로명이 있으면 "테헤란로 동측 구간 #2", 없으면 "이름 없는 구간 #4",
  // 그것도 애매하면 좌표로. 지도에 없는 이름(학교·IC·상권)은 만들지 않는다.
  function labelSegments(segments) {
    const counters = new Map();
    segments.forEach(seg => {
      const side = seg.headingLabel ? `${seg.headingLabel}측` : null;
      const base = seg.named ? `${seg.roadName}${side ? ` ${side}` : ''} 구간` : '이름 없는 구간';
      const n = (counters.get(base) || 0) + 1;
      counters.set(base, n);
      seg.label = `${base} #${n}`;
      seg.labelBasis = seg.named
        ? '지도 데이터(HD Map)의 도로명 + 구간 진행 방위'
        : `지도 데이터에 도로명이 없어 좌표로 표시 — 약 ${seg.center.lat.toFixed(4)}, ${seg.center.lng.toFixed(4)}`;
      if (!seg.named) seg.label = `이름 없는 구간 #${n} (약 ${seg.center.lat.toFixed(4)}, ${seg.center.lng.toFixed(4)})`;
    });
    return segments;
  }

  // 지도 데이터 지문 — 파일이 바뀌면 값이 달라져서 분석을 다시 한다
  function mapDataRevision(sources) {
    return fnv1a((sources || []).map(s => `${s.source || ''}|${s.generatedAt || ''}|${(s.lines || []).length}`).join(';'));
  }

  function graphRevision(segments, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    return fnv1a(`${ROAD_GRAPH_VERSION}|${o.maxSegmentM}|${o.minSegmentM}|${segments.length}|${segments.map(s => s.id).sort().join(',')}`);
  }

  return {
    ROAD_GRAPH_VERSION, DEFAULTS, UNNAMED,
    fnv1a, buildGraph, isJunction, buildSegments, labelSegments, segmentId,
    lineLengthM, mapDataRevision, graphRevision,
  };
}));
