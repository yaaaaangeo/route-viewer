// ══════════════════════════════════════════════════════════
//  derive-hdmap-priority-areas.js
//
//  ①~⑫ 구역 경계를 협의체 도로 데이터에서 만든다.
//
//  ①~⑫ 는 참고 지도에서 빨간 선(간선도로)으로 둘러싸인 블록이다.
//    남북 도로(서→동)  강남대로 · 논현로 · 언주로 · 선릉로 · 삼성로
//    동서 도로(북→남)  도산대로 · 학동로 · 봉은사로 · 테헤란로
//  5 × 4 도로가 만드는 4 × 3 블록이 참고 이미지의 번호와 행 단위로 그대로 맞는다.
//      ① ② ③ ④   (도산대로 ~ 학동로)
//      ⑤ ⑥ ⑦ ⑧   (학동로 ~ 봉은사로)
//      ⑨ ⑩ ⑪ ⑫   (봉은사로 ~ 테헤란로)
//  도로 선 자체는 [산자부E2E]… 폴더의 도로 shapefile(tools/convert-hdmap-shapefile.js 가 WGS84 로
//  바꾼 src/data/hdmap_*_roads.json)에서 가져온다 — 좌표를 손으로 찍거나 이미지에서 역산하지 않는다.
//  사람이 정한 건 "어느 도로가 어느 번호 블록의 테두리인가" 하나뿐이고, 그건 참고 이미지가 알려준다.
//
//  계산
//    1) 도로마다 같은 이름 링크의 꼭짓점을 모아(상·하행 차로 모두) 주축 방향으로 25m 칸에 나눠
//       칸마다 평균을 내서 중앙선 하나를 만든다(곡선인 언주로도 주축 방향으로는 한 방향이라 된다).
//    2) 이웃한 남북·동서 중앙선의 교차점을 모서리로 삼는다.
//    3) 블록 경계 = 위 도로(모서리~모서리) → 오른쪽 도로 → 아래 도로 → 왼쪽 도로.
//       이웃 블록은 같은 중앙선 조각을 나눠 쓰므로 틈도 겹침도 없다.
//
//  실행: node tools/derive-hdmap-priority-areas.js   (그 뒤 build-hdmap-priority-areas.js 가 자동으로 돈다)
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'src', 'data');
const OUT = path.join(DATA_DIR, 'hdmap-priority-areas.json');

const NS_ROADS = ['강남대로', '논현로', '언주로', '선릉로', '삼성로'];   // 서 → 동
const EW_ROADS = ['도산대로', '학동로', '봉은사로', '테헤란로'];         // 북 → 남
const BIN_M = 25;
const EXTEND_M = 150;   // 중앙선 끝이 교차로 직전에서 끊겨도 만나도록 양 끝을 조금 늘린다

const lines = ['gangnam', 'seocho']
  .flatMap(k => require(path.join(DATA_DIR, `hdmap_${k}_roads.json`)).lines || []);

// ── 좌표: 강남 가운데를 원점으로 한 평면 미터(구역 몇 km 안에서는 오차가 cm 수준) ──
const LAT0 = 37.51, LNG0 = 127.045;
const MY = 110574, MX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toXY = ([lat, lng]) => [(lng - LNG0) * MX, (lat - LAT0) * MY];
const toLatLng = ([x, y]) => [LAT0 + y / MY, LNG0 + x / MX];

// ── 1) 도로 중앙선 ──────────────────────────────────
function centerline(name) {
  const pts = [];
  lines.filter(l => l.name === name).forEach(l => {
    const xy = l.points.map(toXY);
    for (let i = 1; i < xy.length; i++) {   // 링크를 10m 간격으로 채워 칸이 비지 않게 한다
      const [a, b] = [xy[i - 1], xy[i]];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 10));
      for (let k = 0; k < n; k++) pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
  });
  if (pts.length < 10) throw new Error(`도로 데이터에 '${name}' 이(가) 없어요.`);
  // 주축(PCA)
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  pts.forEach(([x, y]) => { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); });
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u = [Math.cos(th), Math.sin(th)], v = [-u[1], u[0]];
  const bins = new Map();
  pts.forEach(([x, y]) => {
    const t = (x - mx) * u[0] + (y - my) * u[1], s = (x - mx) * v[0] + (y - my) * v[1];
    const b = Math.floor(t / BIN_M);
    const acc = bins.get(b) || { t: 0, s: 0, n: 0 };
    acc.t += t; acc.s += s; acc.n++; bins.set(b, acc);
  });
  let cl = [...bins.keys()].sort((a, b) => a - b).map(b => bins.get(b)).map(a => [a.t / a.n, a.s / a.n]);
  // 옆길·램프가 섞인 칸이 튀지 않게 이웃 3칸 평균
  cl = cl.map((p, i) => {
    const w = cl.slice(Math.max(0, i - 1), i + 2);
    return [p[0], w.reduce((s, q) => s + q[1], 0) / w.length];
  });
  let xy = cl.map(([t, s]) => [mx + t * u[0] + s * v[0], my + t * u[1] + s * v[1]]);
  const ext = (a, b) => { const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / d * EXTEND_M, a[1] + (a[1] - b[1]) / d * EXTEND_M]; };
  xy = [ext(xy[0], xy[1]), ...xy, ext(xy[xy.length - 1], xy[xy.length - 2])];
  return xy;
}

// ── 2) 교차점: 두 폴리라인이 만나는 첫 자리와 각 선 위의 위치(i + 비율) ──
function intersect(A, B) {
  const hits = [];
  for (let i = 1; i < A.length; i++) {
    for (let j = 1; j < B.length; j++) {
      const [p, r] = [A[i - 1], [A[i][0] - A[i - 1][0], A[i][1] - A[i - 1][1]]];
      const [q, s] = [B[j - 1], [B[j][0] - B[j - 1][0], B[j][1] - B[j - 1][1]]];
      const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-9) continue;
      const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
      const w = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
      if (t >= 0 && t <= 1 && w >= 0 && w <= 1) hits.push({ a: i - 1 + t, b: j - 1 + w, pt: [p[0] + r[0] * t, p[1] + r[1] * t] });
    }
  }
  return hits;
}

// 폴리라인에서 위치 f1 → f2 구간(방향 그대로, 거꾸로면 뒤집어서)
function slice(L, f1, f2) {
  const at = f => { const i = Math.min(L.length - 2, Math.floor(f)), k = f - i; return [L[i][0] + (L[i + 1][0] - L[i][0]) * k, L[i][1] + (L[i + 1][1] - L[i][1]) * k]; };
  const lo = Math.min(f1, f2), hi = Math.max(f1, f2);
  const out = [at(lo)];
  for (let i = Math.floor(lo) + 1; i <= Math.floor(hi); i++) if (i > lo && i < hi) out.push(L[i]);
  out.push(at(hi));
  return f1 <= f2 ? out : out.reverse();
}

const NS = NS_ROADS.map(centerline), EW = EW_ROADS.map(centerline);
const corner = {};   // `${h},${v}` → {h: EW 선 위치, v: NS 선 위치, pt}
EW.forEach((H, h) => NS.forEach((V, v) => {
  const hits = intersect(H, V);
  if (hits.length !== 1) throw new Error(`${EW_ROADS[h]} × ${NS_ROADS[v]} 교차점이 ${hits.length}개예요(1개여야 함).`);
  corner[`${h},${v}`] = { h: hits[0].a, v: hits[0].b, pt: hits[0].pt };
}));

// ── 3) 블록 ────────────────────────────────────────
const round = n => Math.round(n * 1e7) / 1e7;
const polygonArea = r => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const features = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 4; col++) {
    const areaNo = row * 4 + col + 1;
    const nw = corner[`${row},${col}`], ne = corner[`${row},${col + 1}`];
    const se = corner[`${row + 1},${col + 1}`], sw = corner[`${row + 1},${col}`];
    const ring = [
      ...slice(EW[row], nw.h, ne.h),
      ...slice(NS[col + 1], ne.v, se.v).slice(1),
      ...slice(EW[row + 1], se.h, sw.h).slice(1),
      ...slice(NS[col], sw.v, nw.v).slice(1, -1),
    ];
    const coords = ring.map(toLatLng).map(([lat, lng]) => [round(lng), round(lat)]);
    coords.push(coords[0]);   // GeoJSON 링은 닫는다
    features.push({
      areaNo,
      bounds: { north: EW_ROADS[row], south: EW_ROADS[row + 1], west: NS_ROADS[col], east: NS_ROADS[col + 1] },
      areaM2: Math.round(polygonArea(ring)),
      geometry: { type: 'Polygon', coordinates: [coords] },
    });
  }
}

// 기존 파일의 번호·우선순위 정의는 그대로 두고 geometry 와 출처만 채운다
const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
data.polygonSource = '[산자부E2E][데이터협의체]HDMap_구축지역(강남)_세부구역_260209 도로 shapefile 의 간선도로 중앙선으로 둘러싼 블록 '
  + '(tools/derive-hdmap-priority-areas.js 가 생성). 남북 강남대로·논현로·언주로·선릉로·삼성로 × 동서 도산대로·학동로·봉은사로·테헤란로, '
  + '번호는 참고 이미지(src/assets/hdmap-priority-reference.png) 순서. 경계선은 도로 중앙선이라 도로 위 GPS 는 양쪽 블록 중 한쪽에만 들어간다.';
data.generatedAt = new Date().toISOString();
data.features = data.features.map(f => {
  const made = features.find(x => x.areaNo === f.properties.areaNo);
  if (!made) return f;
  return { ...f, geometry: made.geometry, properties: { ...f.properties, bounds: made.bounds, areaM2: made.areaM2 } };
});
fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n', 'utf8');

features.forEach(f => {
  const b = f.bounds;
  console.log(`${String(f.areaNo).padStart(2)}  ${(f.areaM2 / 1e6).toFixed(2)} km²  ${f.geometry.coordinates[0].length - 1}점  `
    + `북 ${b.north} · 남 ${b.south} · 서 ${b.west} · 동 ${b.east}`);
});
console.log(`완료: ${OUT}`);
require('./build-hdmap-priority-areas.js');
