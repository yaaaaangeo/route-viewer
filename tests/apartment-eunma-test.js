// ══════════════════════════════════════════════════════════
//  apartment-eunma-test.js — 은마아파트(대치동, OSM 정식 명칭 "한보은마
//  아파트") 실측 데이터로 고정한 회귀 테스트.
//
//  이번 조사에서 처음엔 Nominatim에서 "은마아파트"로 검색해도 landuse
//  폴리곤이 안 나와서 "이 단지는 명시적 경계가 없나?" 오판할 뻔했다 —
//  실제로는 OSM 공식 이름이 "한보은마아파트"라서 이름 검색만으로는 못
//  찾았을 뿐, Overpass에서 landuse=residential + name~"은마" 정규식으로
//  직접 조회하니 way 379530474가 정확히 나왔다:
//    landuse=residential, residential=apartments, name=한보은마아파트
//  → 신현대아파트와 완전히 같은 태그 조합. 즉 이 두 단지는 "명시적 경계가
//  있는 케이스"이고, 실패했다면 원인은 지오메트리 로직이 아니라 그 시점에
//  fetch가 실패했거나(이 작업 중에도 Overpass 미러가 전부 죽어있던 적이
//  있었다) 캐시가 갱신되지 않았을 가능성이 더 크다 — 그래서 이 세션에서
//  fetch 실패 시 v4 캐시로 폴백하는 로직도 같이 추가했다.
//
//  실행:  node tests/apartment-eunma-test.js
// ══════════════════════════════════════════════════════════
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? '  — ' + detail : ''}`); }
}
function section(title) { console.log(`\n\x1b[36m${title}\x1b[0m`); }

const accumSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'accum.js'), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(accumSrc, context, { filename: 'accum.js' });
const lib = vm.runInContext(`({
  pointInPolygon, polygonAreaM2, isExplicitApartmentComplexTags,
  buildApartmentComplexPolygons, buildExcludedCellSet, buildRoadCellSet, findRoadBridges,
  GAP_CELL_SIZE_M, APARTMENT_EXPLICIT_BUFFER_M,
})`, context);

const REF_LAT = 37.4975; // way 379530474 대략 중심

// way 379530474 — 한보은마아파트(=은마아파트) landuse=residential+residential=apartments 경계
const EUNMA_COMPLEX_POLYGON = [
  [37.4983435, 127.0614482], [37.4999968, 127.0666937], [37.4984091, 127.0681860],
  [37.4976872, 127.0686780], [37.4973935, 127.0688782], [37.4966651, 127.0694436],
  [37.4965366, 127.0693791], [37.4952261, 127.0649745], [37.4952199, 127.0648605],
  [37.4960052, 127.0645024], [37.4963349, 127.0642305], [37.4963882, 127.0639642],
  [37.4959709, 127.0626356],
];
const EUNMA_TAGS = { landuse: 'residential', residential: 'apartments', name: '한보은마아파트' };

// 단지 내부도로(합성). way 243515807(실측 parking_aisle)을 처음 썼는데,
// pointInPolygon으로 검증해보니 실제로는 이 폴리곤 밖(93m)이었다 — 같은
// 대치동 블록의 다른 단지(대치우성/한신 등) 것이었던 듯. 그래서 폴리곤
// 안쪽인지 직접 검증한 합성 좌표를 쓴다.
const INTERNAL_ROAD = [
  [37.4970, 127.0650], [37.4975, 127.0660],
];

// way 218971531 — 삼성로(단지 서쪽 경계를 따라가는 구간), highway=secondary
const SAMSEONG_RO_WEST = [
  [37.4945554, 127.0632487], [37.4951536, 127.0629679], [37.4957831, 127.0626182],
  [37.4969515, 127.0620004], [37.4983606, 127.0612742], [37.4989265, 127.0609727],
];

function main() {
  section('은마아파트(한보은마아파트) — OSM 태그 검증');
  check('landuse=residential + residential=apartments → 명시적 단지 경계로 인정',
    lib.isExplicitApartmentComplexTags(EUNMA_TAGS));

  section('은마아파트 — 단지 영역 검출');
  const complex = lib.buildApartmentComplexPolygons([], [EUNMA_COMPLEX_POLYGON], REF_LAT);
  check('명시적 단지 경계 1개를 그대로 사용', complex.explicit.length === 1, `${complex.explicit.length}개`);
  const areaM2 = lib.polygonAreaM2(EUNMA_COMPLEX_POLYGON, REF_LAT);
  check('단지 면적이 실제 대단지 규모(3만~40만 m²)에 부합', areaM2 > 30000 && areaM2 < 400000,
    `${Math.round(areaM2).toLocaleString()} m²`);

  section('은마아파트 — Final Coverage (Road − Apartment Exclusion)');
  const latDeg = lib.GAP_CELL_SIZE_M / 111320;
  const lngDeg = lib.GAP_CELL_SIZE_M / (111320 * Math.cos(REF_LAT * Math.PI / 180));
  const apartmentExcluded = lib.buildExcludedCellSet(
    complex.explicit, latDeg, lngDeg, REF_LAT, lib.APARTMENT_EXPLICIT_BUFFER_M);

  const roadLines = [INTERNAL_ROAD, SAMSEONG_RO_WEST];
  const bridges = lib.findRoadBridges(roadLines, REF_LAT, complex.explicit);
  const roadCells = lib.buildRoadCellSet(
    bridges.length ? roadLines.concat(bridges) : roadLines, latDeg, lngDeg, REF_LAT);

  function cellKeysOfLine(line) {
    const keys = new Set();
    line.forEach(([lat, lng]) => keys.add(Math.floor(lat / latDeg) + '_' + Math.floor(lng / lngDeg)));
    return [...keys];
  }

  const internalKeys = cellKeysOfLine(INTERNAL_ROAD);
  const internalRoadCellsFound = internalKeys.filter(k => roadCells.has(k));
  const internalFinalCells = internalRoadCellsFound.filter(k => !apartmentExcluded.has(k));
  check('단지 내부도로가 raw road coverage로는 잡힌다(exclusion 전)',
    internalRoadCellsFound.length > 0, `${internalRoadCellsFound.length}칸`);
  check('단지 내부도로는 exclusion 후 Final Coverage에 하나도 안 남는다',
    internalFinalCells.length === 0, `남은 칸=${internalFinalCells.length}`);

  const westKeys = cellKeysOfLine(SAMSEONG_RO_WEST);
  const westFinalCells = westKeys.filter(k => roadCells.has(k) && !apartmentExcluded.has(k));
  check('단지 서쪽 경계를 따라가는 삼성로는 Final Coverage에 그대로 남는다(단지 밖 공공도로)',
    westFinalCells.length > 0, `${westFinalCells.length}칸`);

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
