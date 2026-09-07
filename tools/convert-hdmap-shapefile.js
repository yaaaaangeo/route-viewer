// ══════════════════════════════════════════════════════════
//  convert-hdmap-shapefile.js
//
//  산자부 E2E 데이터협의체 HD map(표준노드링크 형식 shapefile)을 앱이
//  바로 쓸 수 있는 WGS84 lat/lng LineString JSON/JS로 변환한다.
//
//  입력 좌표계: KGD2002 Central Belt(EPSG:5181) — Transverse Mercator,
//  중앙자오선 127°E, 위도원점 38°N, false easting 200000 / northing
//  500000, GRS80 타원체(a=6378137, 1/f=298.257222101). 강남/서초 두
//  shapefile 모두 .prj로 실측 확인함(둘 다 동일 좌표계).
//  Snyder(1987)의 타원체 Transverse Mercator 역변환 공식을 그대로
//  구현한다(proj4 등 외부 라이브러리 없이, 표준 공식) — 이전엔 PowerShell
//  로 짰었는데(같은 공식), Node로 옮겨서 실제로 실행/검증하기 쉽게 했다.
//
//  .json은 데이터 그대로(테스트/검증용), .js는 <script src="..."> 태그로
//  불러써서 window.<globalVar> 전역에 담는다 — src/index.html을 file://
//  로 그냥 더블클릭해서 열어도 동작해야 하는데, fetch()로 로컬 JSON을
//  읽는 건 브라우저 CORS 정책상 file://에서 막히지만(Failed to fetch),
//  <script> 태그로 로드하는 건 file://에서도 막히지 않는다.
//
//  실행: node tools/convert-hdmap-shapefile.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HDMAP_DIR = path.join(ROOT, '[산자부E2E][데이터협의체]HDMap_구축지역(강남)_세부구역_260209');
const OUT_DIR = path.join(ROOT, 'src', 'data');

// ── EPSG:5181(KGD2002 Central Belt) → WGS84 역변환 ──────────────────
function inverseTM(x, y) {
  const a = 6378137.0;
  const invf = 298.257222101;
  const f = 1.0 / invf;
  const e2 = f * (2.0 - f);
  const ep2 = e2 / (1.0 - e2);
  const k0 = 1.0;
  const lat0 = 38.0 * Math.PI / 180.0;
  const lon0 = 127.0 * Math.PI / 180.0;
  const FE = 200000.0;
  const FN = 500000.0;

  const M0 = a * ((1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0) * lat0
    - (3.0 * e2 / 8.0 + 3.0 * e2 * e2 / 32.0 + 45.0 * e2 * e2 * e2 / 1024.0) * Math.sin(2.0 * lat0)
    + (15.0 * e2 * e2 / 256.0 + 45.0 * e2 * e2 * e2 / 1024.0) * Math.sin(4.0 * lat0)
    - (35.0 * e2 * e2 * e2 / 3072.0) * Math.sin(6.0 * lat0));

  const xp = x - FE;
  const yp = y - FN;
  const M = M0 + yp / k0;
  const mu = M / (a * (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0));

  const e1 = (1.0 - Math.sqrt(1.0 - e2)) / (1.0 + Math.sqrt(1.0 - e2));

  const phi1 = mu + (3.0 * e1 / 2.0 - 27.0 * e1 * e1 * e1 / 32.0) * Math.sin(2.0 * mu)
    + (21.0 * e1 * e1 / 16.0 - 55.0 * e1 * e1 * e1 * e1 / 32.0) * Math.sin(4.0 * mu)
    + (151.0 * e1 * e1 * e1 / 96.0) * Math.sin(6.0 * mu)
    + (1097.0 * e1 * e1 * e1 * e1 / 512.0) * Math.sin(8.0 * mu);

  const sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1), tanPhi1 = Math.tan(phi1);
  const C1 = ep2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const N1 = a / Math.sqrt(1.0 - e2 * sinPhi1 * sinPhi1);
  const R1 = a * (1.0 - e2) / Math.pow(1.0 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = xp / (N1 * k0);

  const latRad = phi1 - (N1 * tanPhi1 / R1) * (D * D / 2.0
    - (5.0 + 3.0 * T1 + 10.0 * C1 - 4.0 * C1 * C1 - 9.0 * ep2) * Math.pow(D, 4) / 24.0
    + (61.0 + 90.0 * T1 + 298.0 * C1 + 45.0 * T1 * T1 - 252.0 * ep2 - 3.0 * C1 * C1) * Math.pow(D, 6) / 720.0);

  const lonRad = lon0 + (D - (1.0 + 2.0 * T1 + C1) * Math.pow(D, 3) / 6.0
    + (5.0 - 2.0 * C1 + 28.0 * T1 - 3.0 * C1 * C1 + 8.0 * ep2 + 24.0 * T1 * T1) * Math.pow(D, 5) / 120.0) / cosPhi1;

  return [latRad * 180.0 / Math.PI, lonRad * 180.0 / Math.PI];
}

// ── .dbf에서 ROAD_NAME만 뽑는다(디버그용, 필수는 아님) ──────────────
function readDbfRoadNames(dbfPath) {
  const buf = fs.readFileSync(dbfPath);
  const numRecords = buf.readInt32LE(4);
  const headerSize = buf.readInt16LE(8);
  const recordSize = buf.readInt16LE(10);

  const fields = [];
  let off = 32;
  while (buf[off] !== 0x0d) {
    const name = buf.toString('ascii', off, off + 11).replace(/\0.*$/, '');
    const len = buf[off + 16];
    fields.push({ name, len });
    off += 32;
  }

  const roadNameIdx = fields.findIndex(f => f.name === 'ROAD_NAME');
  const names = [];
  let recOff = headerSize;
  for (let r = 0; r < numRecords; r++) {
    let fieldOff = recOff + 1; // 삭제 플래그 1바이트
    let roadName = '';
    for (let fi = 0; fi < fields.length; fi++) {
      const raw = buf.toString('utf8', fieldOff, fieldOff + fields[fi].len).trim();
      if (fi === roadNameIdx) roadName = raw;
      fieldOff += fields[fi].len;
    }
    names.push(roadName);
    recOff += recordSize;
  }
  return names;
}

// ── .shp(PolyLine, shape type 3) 파싱 + 좌표 변환 ────────────────────
function convertShapefile(shpPath, dbfPath) {
  const buf = fs.readFileSync(shpPath);
  const fileLenWords = buf.readInt32BE(24);
  const fileLenBytes = fileLenWords * 2;

  const roadNames = fs.existsSync(dbfPath) ? readDbfRoadNames(dbfPath) : [];

  const lines = [];
  let pos = 100; // 헤더 100바이트
  let recIdx = 0;
  while (pos < fileLenBytes) {
    pos += 4; // record number
    const contentWords = buf.readInt32BE(pos); pos += 4;
    const contentStart = pos;
    const shapeType = buf.readInt32LE(pos); pos += 4;
    if (shapeType === 3) {
      pos += 32; // bbox(4 double)
      const numParts = buf.readInt32LE(pos); pos += 4;
      const numPoints = buf.readInt32LE(pos); pos += 4;
      const parts = [];
      for (let i = 0; i < numParts; i++) { parts.push(buf.readInt32LE(pos)); pos += 4; }
      const rawPts = [];
      for (let i = 0; i < numPoints; i++) {
        const x = buf.readDoubleLE(pos); pos += 8;
        const y = buf.readDoubleLE(pos); pos += 8;
        rawPts.push([x, y]);
      }
      for (let p = 0; p < numParts; p++) {
        const startIdx = parts[p];
        const endIdx = p + 1 < numParts ? parts[p + 1] - 1 : numPoints - 1;
        const points = [];
        for (let i = startIdx; i <= endIdx; i++) {
          const [lat, lng] = inverseTM(rawPts[i][0], rawPts[i][1]);
          points.push([Math.round(lat * 1e7) / 1e7, Math.round(lng * 1e7) / 1e7]);
        }
        lines.push({ name: roadNames[recIdx] || '', points });
      }
    }
    recIdx++;
    pos = contentStart + contentWords * 2;
  }
  return lines;
}

function bboxOf(lines) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  lines.forEach(l => l.points.forEach(([lat, lng]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }));
  return { minLat, maxLat, minLng, maxLng };
}

function run(job) {
  const shpPath = path.join(HDMAP_DIR, job.shp);
  const dbfPath = path.join(HDMAP_DIR, job.shp.replace(/\.shp$/, '.dbf'));
  console.log(`[${job.globalVar}] ${job.shp} 파싱 중...`);
  const lines = convertShapefile(shpPath, dbfPath);
  const bbox = bboxOf(lines);
  console.log(`  ${lines.length}개 line, bbox: lat ${bbox.minLat.toFixed(4)}~${bbox.maxLat.toFixed(4)}, lng ${bbox.minLng.toFixed(4)}~${bbox.maxLng.toFixed(4)}`);

  const out = {
    source: `[산자부E2E][데이터협의체]HDMap_구축지역(강남)_세부구역_260209/${job.shp}`,
    crs: 'EPSG:5181 (KGD2002 Central Belt) -> WGS84',
    generatedAt: new Date().toISOString(),
    bbox,
    lines,
  };
  const json = JSON.stringify(out);

  const outJsonPath = path.join(OUT_DIR, job.outJson);
  fs.writeFileSync(outJsonPath, json, 'utf8');
  console.log(`  완료: ${outJsonPath} (${(fs.statSync(outJsonPath).size / 1024).toFixed(1)} KB)`);

  const outJsPath = path.join(OUT_DIR, job.outJs);
  const jsContent = `// 자동 생성 파일 — tools/convert-hdmap-shapefile.js 로 다시 만든다. 직접 고치지 말 것.\nwindow.${job.globalVar} = ${json};\n`;
  fs.writeFileSync(outJsPath, jsContent, 'utf8');
  console.log(`  완료: ${outJsPath} (${(fs.statSync(outJsPath).size / 1024).toFixed(1)} KB)`);
}

const JOBS = [
  {
    shp: '강남구_전체도로_편도_1차선_이상.shp',
    outJson: 'hdmap_gangnam_roads.json',
    outJs: 'hdmap_gangnam_roads.js',
    globalVar: 'HDMAP_GANGNAM_ROADS',
  },
  {
    shp: '서초구_전체도로+편도_2차선_이상_OR_고속_도시고속_도로.shp',
    outJson: 'hdmap_seocho_roads.json',
    outJs: 'hdmap_seocho_roads.js',
    globalVar: 'HDMAP_SEOCHO_ROADS',
  },
];

JOBS.forEach(run);
