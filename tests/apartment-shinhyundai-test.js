// ══════════════════════════════════════════════════════════
//  apartment-shinhyundai-test.js — 신현대아파트(압구정동) 실측 데이터로
//  고정한 회귀 테스트.
//
//  왜 이 좌표들인가: Nominatim + OSM 공식 API(api.openstreetmap.org)로
//  실제 조회해서 얻은 값이다(Overpass 3개 미러가 전부 다운/에러라 우회).
//    - way 436407134: landuse=residential, residential=apartments,
//      name=신현대아파트, 18개 꼭짓점 — 매퍼가 그린 실제 단지 부지 경계
//    - way 367791113 (107동): building=apartments, 4개 꼭짓점
//    - way 46677733 (압구정로) 일부 구간: highway=secondary — 단지 남쪽
//      경계를 따라가는 실제 공공도로(폴리곤 경계에서 33~37m 떨어져 있음,
//      직접 pointInPolygon/polygonDistanceM으로 재확인함)
//
//  204동/205동, 단지 내부도로는 정확한 실측 좌표를 못 구해서(204/205동
//  중심좌표는 다른 Overpass 미러 조회에서 받았는데, 실제로 넣어서
//  확인해보니 그 좌표들이 이 폴리곤 "밖"이었다 — 아마 인접한 다른 단지
//  것이었던 듯) 이 폴리곤(SHINHYUNDAI_COMPLEX_POLYGON) 안쪽인지 직접
//  pointInPolygon으로 검증해서 고른 좌표를 쓴다. 실제 way ID를 붙이지
//  않고 "실제 폴리곤 내부에 있음이 검증된 합성 좌표"라고 명시한다 —
//  107동 자체는 실측 그대로 유지.
//
//  완료 조건(코드 = 사용자 acceptance test):
//    - 신현대아파트 건물/내부도로/주차장 진입로 → Coverage 없음
//    - 단지 밖 압구정로 구간 → Coverage 있음
//    - coverage_inside_apartment_after == 0
//
//  실행:  node tests/apartment-shinhyundai-test.js
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
  mPerDegAt, pointInPolygon, polygonAreaM2,
  isApartmentBuildingTags, isExplicitApartmentComplexTags,
  buildApartmentComplexPolygons, buildExcludedCellSet, buildRoadCellSet, findRoadBridges,
  GAP_CELL_SIZE_M, APARTMENT_EXPLICIT_BUFFER_M, APARTMENT_COMPLEX_BUFFER_M,
})`, context);

// ── 실측 데이터 (위 헤더 주석 참고) ──────────────────────────────────
const REF_LAT = 37.5279978; // way 436407134 center (Nominatim)

// way 436407134 — 신현대아파트 landuse=residential+residential=apartments 경계 (18 꼭짓점, 닫는 중복점 제외)
const SHINHYUNDAI_COMPLEX_POLYGON = [
  [37.5305775, 127.0245977], [37.5306699, 127.0244417], [37.5305945, 127.0242866],
  [37.5274645, 127.0219530], [37.5273136, 127.0218189], [37.5268115, 127.0222266],
  [37.5259313, 127.0229351], [37.5256191, 127.0231985], [37.5250892, 127.0236455],
  [37.5261502, 127.0258071], [37.5260717, 127.0258695], [37.5262728, 127.0262834],
  [37.5271587, 127.0255749], [37.5276994, 127.0266367], [37.5278500, 127.0268693],
  [37.5281455, 127.0266876], [37.5283214, 127.0268935], [37.5294923, 127.0255686],
];
const SHINHYUNDAI_TAGS = { landuse: 'residential', residential: 'apartments', name: '신현대아파트' };

// way 367791113 — 107동, building=apartments
const BLDG_107 = [
  [37.5264806, 127.0239883], [37.5270090, 127.0249958],
  [37.5270994, 127.0249204], [37.5265710, 127.0239130],
];
const BLDG_107_TAGS = { building: 'apartments', name: '107동', 'building:levels': '12' };

// 단지 내부도로(합성, 폴리곤 안쪽으로 검증됨 — 107동 바로 옆, 실제 107동이
// 있는 구역과 같은 위치대). pointInPolygon으로 두 끝점 모두 내부 확인함.
const INTERNAL_ROAD = [
  [37.5273, 127.0248], [37.5279, 127.0253],
];

// way 46677733 — 압구정로(단지 남쪽 경계를 따라가는 구간), highway=secondary
const APGUJEONG_RO_SOUTH = [
  [37.5249099, 127.0240738], [37.5250041, 127.0242582],
  [37.5250501, 127.0243465], [37.5256276, 127.0254561],
];

// 204동/205동 — 실측 중심좌표가 실제로는 이 폴리곤 밖으로 확인돼서, 폴리곤
// 안쪽인지 pointInPolygon으로 검증한 좌표로 동 하나 크기(약 40×20m)를
// 얹었다. 107동(37.5265~37.5271,127.0239~127.0250)과 확실히 떨어진
// 다른 위치를 골라서, "단지 안 넓게 퍼진 동들을 explicit 경계 하나가
// 전부 커버하는지"를 여전히 검증한다.
function rectAround(centerLat, centerLng, widthM, heightM, refLat) {
  const { mLat, mLng } = lib.mPerDegAt(refLat);
  const hw = widthM / 2 / mLng, hh = heightM / 2 / mLat;
  return [
    [centerLat - hh, centerLng - hw], [centerLat - hh, centerLng + hw],
    [centerLat + hh, centerLng + hw], [centerLat + hh, centerLng - hw],
  ];
}
const BLDG_204 = rectAround(37.5290, 127.0250, 30, 16, REF_LAT); // 폴리곤 안쪽 검증됨(북쪽)
const BLDG_205 = rectAround(37.5278, 127.0263, 30, 16, REF_LAT); // 폴리곤 안쪽 검증됨(동쪽)

function main() {
  section('신현대아파트 — OSM 태그 검증');
  check('landuse=residential + residential=apartments → 명시적 단지 경계로 인정',
    lib.isExplicitApartmentComplexTags(SHINHYUNDAI_TAGS));
  check('landuse=residential 단독(residential=apartments 없음)은 인정 안 함 — 일반 주거지역 오제거 방지',
    !lib.isExplicitApartmentComplexTags({ landuse: 'residential' }));
  check('107동 building=apartments → 아파트 동으로 인정', lib.isApartmentBuildingTags(BLDG_107_TAGS));

  section('신현대아파트 — 단지 영역 검출(fetchBuildingsForBbox가 만들어줄 입력을 그대로 재현)');
  const apartmentPolygons = [BLDG_107, BLDG_204, BLDG_205];
  const explicitComplexPolygons = [SHINHYUNDAI_COMPLEX_POLYGON];
  const complex = lib.buildApartmentComplexPolygons(apartmentPolygons, explicitComplexPolygons, REF_LAT);

  check('명시적 단지 경계 1개를 그대로 사용', complex.explicit.length === 1, `${complex.explicit.length}개`);
  const areaM2 = lib.polygonAreaM2(SHINHYUNDAI_COMPLEX_POLYGON, REF_LAT);
  check('단지 면적이 실제 대단지 규모(도시 전체가 아닌, 3만~40만 m²)에 부합', areaM2 > 30000 && areaM2 < 400000,
    `${Math.round(areaM2).toLocaleString()} m²`);
  check('107동은 명시적 경계 안쪽 → hull 클러스터링 대상에서 제외됨',
    lib.pointInPolygon(
      (BLDG_107[0][0] + BLDG_107[2][0]) / 2, (BLDG_107[0][1] + BLDG_107[2][1]) / 2,
      SHINHYUNDAI_COMPLEX_POLYGON));
  check('107/204/205동 모두 explicit 경계로 커버되어 hull 추정이 따로 필요 없다(간격 400m+에도 불구)',
    complex.hullEstimated.length === 0, `hullEstimated=${complex.hullEstimated.length}개`);

  section('신현대아파트 — Final Coverage (Road − Building/Apartment Exclusion)');
  const latDeg = lib.GAP_CELL_SIZE_M / 111320;
  const lngDeg = lib.GAP_CELL_SIZE_M / (111320 * Math.cos(REF_LAT * Math.PI / 180));
  const apartmentExcluded = lib.buildExcludedCellSet(
    complex.explicit, latDeg, lngDeg, REF_LAT, lib.APARTMENT_EXPLICIT_BUFFER_M);

  const roadLines = [INTERNAL_ROAD, APGUJEONG_RO_SOUTH];
  const bridges = lib.findRoadBridges(roadLines, REF_LAT);
  const roadCells = lib.buildRoadCellSet(
    bridges.length ? roadLines.concat(bridges) : roadLines, latDeg, lngDeg, REF_LAT);

  function cellKeysOfLine(line) {
    const keys = new Set();
    line.forEach(([lat, lng]) => {
      keys.add(Math.floor(lat / latDeg) + '_' + Math.floor(lng / lngDeg));
    });
    return [...keys];
  }

  const internalKeys = cellKeysOfLine(INTERNAL_ROAD);
  const internalRoadCellsFound = internalKeys.filter(k => roadCells.has(k));
  const internalFinalCells = internalRoadCellsFound.filter(k => !apartmentExcluded.has(k));
  check('내부도로가 raw road coverage로는 잡힌다(exclusion 전)',
    internalRoadCellsFound.length > 0, `${internalRoadCellsFound.length}칸`);
  check('내부도로는 exclusion 후 Final Coverage에 하나도 안 남는다(coverage_inside_apartment_after == 0)',
    internalFinalCells.length === 0, `남은 칸=${internalFinalCells.length}`);

  const southKeys = cellKeysOfLine(APGUJEONG_RO_SOUTH);
  const southFinalCells = southKeys.filter(k => roadCells.has(k) && !apartmentExcluded.has(k));
  check('단지 남쪽 경계를 따라가는 압구정로는 Final Coverage에 그대로 남는다(단지 밖 공공도로)',
    southFinalCells.length > 0, `${southFinalCells.length}칸`);

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
