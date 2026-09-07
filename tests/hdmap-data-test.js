// ══════════════════════════════════════════════════════════
//  hdmap-data-test.js — src/data/hdmap_*_roads.json 구조/좌표 정합성 검증.
//
//  이 파일들은 tools/convert-hdmap-shapefile.js가 shapefile(표준노드링크,
//  EPSG:5181)을 WGS84로 좌표변환해서 만든다 — 사람이 다시 만들 때마다
//  (raw shapefile이 갱신될 때 등) 좌표변환이 깨지지 않았는지 이 테스트로
//  확인한다. accum.js는 "강남"/"서초" 구역에서 이 파일에 있는 도로만
//  도로로 인정하므로(Overpass 완전 우회), 이 데이터 자체가 깨지면 그
//  구역의 커버리지 전체가 깨진다.
//
//  실행:  node tests/hdmap-data-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

// 각 구의 실제 대략적 범위(여유를 넉넉히 둠) — 이 밖 좌표가 나오면
// 좌표변환(투영법 파라미터)이 잘못됐다는 뜻이다.
const DATASETS = [
  {
    file: 'hdmap_gangnam_roads.json', zone: '강남', minLines: 1000, minPoints: 5000,
    bounds: { minLat: 37.40, maxLat: 37.60, minLng: 126.95, maxLng: 127.15 },
  },
  {
    file: 'hdmap_seocho_roads.json', zone: '서초', minLines: 300, minPoints: 1000,
    bounds: { minLat: 37.40, maxLat: 37.60, minLng: 126.90, maxLng: 127.10 },
  },
];

function checkDataset(ds) {
  section(`${ds.zone} (${ds.file})`);
  const filePath = path.join(__dirname, '..', 'src', 'data', ds.file);

  check(`${ds.file}이 존재한다`, fs.existsSync(filePath), filePath);
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, 'utf8');
  check('BOM 없이 저장됨(JSON.parse가 일부 환경에서 BOM에 실패할 수 있음)',
    raw.charCodeAt(0) !== 0xFEFF);

  let data;
  try { data = JSON.parse(raw); check('유효한 JSON', true); }
  catch (err) { check('유효한 JSON', false, err.message); return; }

  check('lines 배열 존재', Array.isArray(data.lines));
  if (!Array.isArray(data.lines)) return;
  check(`도로 line이 최소 ${ds.minLines}개 이상`, data.lines.length >= ds.minLines, `${data.lines.length}개`);
  check('bbox 메타데이터 존재', data.bbox && typeof data.bbox.minLat === 'number');

  let badPoints = 0, totalPoints = 0;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  data.lines.forEach(line => {
    (line.points || []).forEach(([lat, lng]) => {
      totalPoints++;
      if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
        badPoints++;
        return;
      }
      if (lat < ds.bounds.minLat || lat > ds.bounds.maxLat || lng < ds.bounds.minLng || lng > ds.bounds.maxLng) {
        badPoints++;
      }
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    });
  });
  check(`포인트가 최소 ${ds.minPoints}개 이상`, totalPoints >= ds.minPoints, `${totalPoints}개`);
  check(`모든 좌표가 ${ds.zone} 대략 범위 안(투영 파라미터가 맞다는 증거)`,
    badPoints === 0, `범위 밖/NaN ${badPoints}/${totalPoints}`);
  check('실제 변환 결과 bbox가 좁고 합리적임(도시 하나 스케일)',
    (maxLat - minLat) < 0.3 && (maxLng - minLng) < 0.3,
    `lat span=${(maxLat - minLat).toFixed(4)}° lng span=${(maxLng - minLng).toFixed(4)}°`);

  // 이 .js가 실제로 window.<globalVar>에 데이터를 담는지도 확인(정적 스크립트 로드 경로)
  const jsFile = ds.file.replace(/\.json$/, '.js');
  const jsPath = path.join(__dirname, '..', 'src', 'data', jsFile);
  check(`${jsFile}(<script> 로드용)도 같이 존재한다`, fs.existsSync(jsPath));
  if (fs.existsSync(jsPath)) {
    const jsRaw = fs.readFileSync(jsPath, 'utf8');
    check(`${jsFile}가 window.HDMAP_*_ROADS 전역에 할당하는 형태다`,
      /^window\.HDMAP_\w+_ROADS\s*=/m.test(jsRaw));
  }
}

function checkAccumSourceConfig() {
  section('accum.js HD map source routing');
  const accumPath = path.join(__dirname, '..', 'src', 'js', 'accum.js');
  check('accum.js exists', fs.existsSync(accumPath), accumPath);
  if (!fs.existsSync(accumPath)) return;
  const raw = fs.readFileSync(accumPath, 'utf8');
  check('Gangnam coverage loads Gangnam + Seocho HD map together',
    /'강남'\s*:\s*\[\s*'HDMAP_GANGNAM_ROADS'\s*,\s*'HDMAP_SEOCHO_ROADS'\s*\]/.test(raw));
  check('HD map loader supports multiple source globals',
    /function\s+hdmapGlobalNamesFor/.test(raw) && /forEach\(globalName=>/.test(raw));
}

function main() {
  DATASETS.forEach(checkDataset);
  checkAccumSourceConfig();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed) {
    console.log('\n  실패 항목:');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(`${'─'.repeat(60)}\n`);
  process.exit(failed ? 1 : 0);
}

main();
