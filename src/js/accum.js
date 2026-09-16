// ══════════════════════════════════════════════════════════
//  accum — 누적 지도 · 구역 경계 · 커버리지 갭
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  누적 지도 — 지금까지 불러온 모든 날짜의 기록을 한 지도에 합쳐서
//  "과거부터 지금까지 어디를 돌았는지" 한눈에 보여준다.
//  + 구역(강남/판교/시흥) 필터, + 마우스 호버 시 근처 기록을 즉석 툴팁으로 표시.
// ══════════════════════════════════════════════════════════
// 예전엔 여기 강남/판교/시흥이 하드코딩돼 있었다(요구사항 13,15).
// 이제 [설정] 탭의 지역 관리(zones 테이블)에서 채워지는 캐시다 —
// 앱 시작 시, 그리고 설정 화면에서 저장할 때마다 refreshZoneCache()로 다시 채운다.
// ZONE_CENTERS/ZONE_COLORS 는 비활성 지역도 포함(과거 기록 색상 표시용),
// ACTIVE_ZONE_NAMES 는 필터 버튼에 보여줄 활성 지역만 담는다.
let ZONE_CENTERS={};
let ZONE_COLORS={};
let ACTIVE_ZONE_NAMES=[];

async function refreshZoneCache(){
  let zones=[];
  try{ zones=await RouteDB.listZones(); }
  catch(err){ console.warn('[경로뷰어] 지역 설정 불러오기 실패:',err); zones=[]; }
  ZONE_CENTERS={}; ZONE_COLORS={}; ACTIVE_ZONE_NAMES=[];
  zones.forEach(z=>{
    if(z.centerLat!=null&&z.centerLng!=null) ZONE_CENTERS[z.name]=[z.centerLat,z.centerLng];
    if(z.color) ZONE_COLORS[z.name]=z.color;
    if(z.active) ACTIVE_ZONE_NAMES.push(z.name);
  });
  return zones;
}

// 구역 필터 버튼 그룹(누적 지도 탭 / 통계 탭 둘 다 공용)의 active 스타일을
// 선택된 구역 색으로 입혀준다. "전체"일 땐 기본 틸 색(CSS 기본값)으로 되돌림.
function styleZoneButtons(containerId,zone){
  document.querySelectorAll('#'+containerId+' .zone-btn').forEach(b=>{
    const isActive=b.dataset.zone===zone;
    b.classList.toggle('active',isActive);
    if(isActive&&zone!=='all'&&ZONE_COLORS[zone]){
      const c=ZONE_COLORS[zone];
      b.style.background=c; b.style.borderColor=c; b.style.color='#0a0e16';
    }else{
      b.style.background=''; b.style.borderColor=''; b.style.color='';
    }
  });
}
// 이슈로 표시한 파일에서 온 기록이 섞인 칸 색 — 누적 지도와 통계 막대가 같은 색을 쓴다
const ISSUE_CELL_COLOR='#7d8798';

// 누적 지도 아래 "회색 = 이슈 데이터" 안내 — 이슈 칸이 하나도 없으면 숨긴다
function updateAccumIssueLegend(issueCells,totalCells){
  const el=document.getElementById('accum-issue-legend');
  if(!el) return;
  if(!issueCells){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='flex';
  el.innerHTML=`<span class="aleg-dot" style="background:${ISSUE_CELL_COLOR}"></span>`
    +`<span>회색 점 ${fmtNum(issueCells)}칸 — 이슈로 표시한 파일에서 온 기록이 섞인 자리예요`
    +`(전체 ${fmtNum(totalCells)}칸). 구역 색 점 위에 이슈 몫만큼만 겹쳐 그려서, 같은 자리에 문제 없는 날과`
    +` 문제 있는 날이 겹치면 두 색이 함께 보여요. '이슈 없음'으로 보면 그 기록을 뺀 지도가 나와요.</span>`;
}

const HOVER_MAX_DIST_M=90; // 커서가 셀 중심에서 이만큼(m) 이내일 때만 그 점의 정보를 보여줌

let accumMap=null, accumDensityLayer=null, coverageLayer=null, manualCellsLayer=null, vehicleStorageLayer=null;
let accumTileLayer=null; // 배경 지도 타일 — 캡처 전에 타일 로딩이 끝났는지(isLoading) 확인용
let showCoverageGaps=false;
// 커버리지 격자 한 칸 크기(m) — 화면·SQLite·IndexedDB 공통 단일 기준(coverage-grid.js의
// DEFAULT_CELL_SIZE_M = 20, 건물을 더 정확히 빼려고 50m에서 줄였다). 사용자 설정값이 아니다.
// 테스트는 accum.js를 CoverageGrid 없이 단독 로드하기도 해서 같은 값을 폴백으로 둔다.
const GAP_CELL_SIZE_M=(typeof CoverageGrid!=='undefined'&&CoverageGrid.DEFAULT_CELL_SIZE_M)||20;
let accumDateFrom='';
let accumDateTo='';
let coverageCellLayers=new Map(); // 현재 화면에 그려진 커버리지 셀 layer — 수동 선택 중 즉시 숨김/복원용

// ══════════════════════════════════════════════════════════
//  구역 경계(섹터) — nav-app의 "섹터 그리기"와 같은 방식.
//  원으로 근사하지 않고, 지도를 클릭해서 실제 모양대로 직접 그린다.
//  그린 경계는 이제 DB(SQLite zone_polygons / IndexedDB meta)에 저장되고,
//  백업 파일에도 함께 들어간다.
// ══════════════════════════════════════════════════════════
let ZONE_POLYGONS={};

async function loadZonePolygonsFromDb(){
  try{
    ZONE_POLYGONS=await RouteDB.getZonePolygons()||{};
  }catch(err){
    console.warn('[경로뷰어] 구역 경계 불러오기 실패:',err);
    ZONE_POLYGONS={};
  }
  return ZONE_POLYGONS;
}

function saveZonePolygonsToStorage(){
  RouteDB.saveZonePolygons(ZONE_POLYGONS).catch(err=>{
    console.warn('[경로뷰어] 구역 경계 저장 실패:',err);
    showError('구역 경계를 저장하지 못했어요. ('+err.message+')');
  });
}

// 레이 캐스팅으로 점이 다각형 안에 있는지 판정 (nav-app pointInPolygon과 동일한 로직)
function pointInPolygon(lat,lng,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const yi=poly[i][0], xi=poly[i][1], yj=poly[j][0], xj=poly[j][1];
    const denom=(yj-yi)||1e-12;
    const intersect=((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/denom+xi);
    if(intersect) inside=!inside;
  }
  return inside;
}

// ── "칸 중심에서 도로/건물 geometry까지 실제 거리(m)" 공통 계산 ──────────
// 진짜 polygon buffer 라이브러리 없이도, 도로 대각선 교차부 틈/건물·아파트
// 제외를 전부 이 하나의 원리로 처리한다: refLat 기준 등장방형 근사로 lat/lng를
// 평면 미터 좌표로 바꾼 뒤 점-선분 최단거리를 잰다. 구역 하나 스케일(수 km
// 이내)에서는 이 근사 오차가 무시할 만하다.
function mPerDegAt(refLat){
  return { mLat:111320, mLng:111320*Math.cos(refLat*Math.PI/180) };
}

function distPointToSegmentM(lat,lng,aLat,aLng,bLat,bLng,refLat){
  const {mLat,mLng}=mPerDegAt(refLat);
  const px=(lng-aLng)*mLng, py=(lat-aLat)*mLat;
  const dx=(bLng-aLng)*mLng, dy=(bLat-aLat)*mLat;
  const lenSq=dx*dx+dy*dy;
  const t=lenSq>0 ? Math.max(0,Math.min(1,(px*dx+py*dy)/lenSq)) : 0;
  return Math.hypot(px-dx*t, py-dy*t);
}

// 점이 폴리곤 안이면 0, 아니면 가장 가까운 변까지의 거리(m).
function polygonDistanceM(lat,lng,poly,refLat){
  if(pointInPolygon(lat,lng,poly)) return 0;
  let best=Infinity;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const d=distPointToSegmentM(lat,lng,poly[j][0],poly[j][1],poly[i][0],poly[i][1],refLat);
    if(d<best) best=d;
  }
  return best;
}

// 두 폴리곤 사이 최단거리(m) — 한쪽 꼭짓점들을 다른 쪽 폴리곤까지 거리로 재는
// 근사(볼록에 가까운 건물 footprint끼리는 충분히 정확하다).
function polygonToPolygonDistanceM(polyA,polyB,refLat){
  let best=Infinity;
  for(const [lat,lng] of polyA){
    const d=polygonDistanceM(lat,lng,polyB,refLat);
    if(d<best) best=d;
    if(best===0) return 0;
  }
  for(const [lat,lng] of polyB){
    const d=polygonDistanceM(lat,lng,polyA,refLat);
    if(d<best) best=d;
    if(best===0) return 0;
  }
  return best;
}

// 폴리곤 면적(m²) — Shoelace, refLat 기준 평면 근사(구역 하나 스케일에서 충분).
function polygonAreaM2(poly,refLat){
  const {mLat,mLng}=mPerDegAt(refLat);
  let area=0;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][1]*mLng, yi=poly[i][0]*mLat;
    const xj=poly[j][1]*mLng, yj=poly[j][0]*mLat;
    area+=xj*yi-xi*yj;
  }
  return Math.abs(area)/2;
}

function polygonCentroid(poly){
  let sLat=0,sLng=0;
  poly.forEach(([lat,lng])=>{ sLat+=lat; sLng+=lng; });
  return [sLat/poly.length, sLng/poly.length];
}

// ── 아파트 "단지 전체 영역" 추정 ─────────────────────────────────────
// 1순위: landuse=residential + residential=apartments 조합(매퍼가 직접
// 그린 단지 부지 경계) — 있으면 그대로 쓴다. 사람이 그린 경계가 추정보다
// 항상 정확하다. (신현대아파트로 실측 확인: way 436407134가 정확히 이
// 조합, 18개 꼭짓점의 실제 단지 경계 — 예전엔 이 태그를 아예 안 받아와서
// 통째로 놓쳤었다.)
// 2순위(이 태그가 없는 단지를 위한 폴백): 동 하나하나를 원형 버퍼로
// 부풀려 옆 동과 겹치길 바라는 방식은, 동 사이 간격이 buffer×2보다 넓은
// 대단지에서 안쪽 내부도로가 안 잘린다. 대신 같은 단지에 속하는 동들을
// 먼저 묶고(union-find, linkM 이내면 같은 단지), 그 동들 footprint 전체의
// 볼록껍질(convex hull)을 단지 영역으로 쓴다.
// landuse=residential "전체"는 절대 신호로 안 쓴다(일반 주거지역까지
// 지워짐) — residential=apartments가 붙은 것만 명시적 경계로 인정한다.
const APARTMENT_CLUSTER_LINK_M=80; // 이 이내면 "같은 단지"로 묶음(동 사이 내부도로/광장 스케일)
const APARTMENT_COMPLEX_BUFFER_M=15; // hull(추정 경계) 가장자리 여유
const APARTMENT_EXPLICIT_BUFFER_M=5; // 명시적 경계는 이미 정확해서 여유를 작게만 준다

function clusterApartmentBuildings(apartmentPolygons,refLat,linkM){
  const n=apartmentPolygons.length;
  const parent=Array.from({length:n},(_,i)=>i);
  function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
  function union(a,b){ const ra=find(a),rb=find(b); if(ra!==rb) parent[ra]=rb; }

  const bboxes=apartmentPolygons.map(poly=>{
    const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
    return {minLat:Math.min(...lats),maxLat:Math.max(...lats),minLng:Math.min(...lngs),maxLng:Math.max(...lngs)};
  });
  const {mLat,mLng}=mPerDegAt(refLat);
  const marginLat=linkM/mLat, marginLng=linkM/mLng;

  for(let i=0;i<n;i++){
    for(let j=i+1;j<n;j++){
      if(find(i)===find(j)) continue;
      const bi=bboxes[i], bj=bboxes[j];
      // bbox(+여유)가 안 겹치면 확실히 linkM보다 멀다 — 정밀 거리 계산을 건너뛰는 사전 필터
      const overlap=bi.minLat-marginLat<=bj.maxLat+marginLat && bi.maxLat+marginLat>=bj.minLat-marginLat
        && bi.minLng-marginLng<=bj.maxLng+marginLng && bi.maxLng+marginLng>=bj.minLng-marginLng;
      if(!overlap) continue;
      if(polygonToPolygonDistanceM(apartmentPolygons[i],apartmentPolygons[j],refLat)<=linkM) union(i,j);
    }
  }
  const groups=new Map();
  for(let i=0;i<n;i++){
    const r=find(i);
    if(!groups.has(r)) groups.set(r,[]);
    groups.get(r).push(apartmentPolygons[i]);
  }
  return [...groups.values()];
}

// Andrew's monotone chain — lat/lng를 그냥 평면 좌표처럼 써도, 이 스케일(zone
// 하나)에서 볼록껍질의 위상(어느 점이 껍질 위인지)은 그대로 성립한다.
function convexHull(points){
  const pts=[...points].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(pts.length<3) return pts;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lower=[];
  for(const p of pts){
    while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for(let i=pts.length-1;i>=0;i--){
    const p=pts[i];
    while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// 아파트 동 + 명시적 단지 경계 → 최종 "단지 전체 영역" 폴리곤들.
// 어느 explicit 경계 안에 이미 들어있는 동은 hull 클러스터링에서 빼서
// (같은 단지를 두 번 겹쳐 계산하지 않게) explicit과 hull-추정을 분리해
// 반환한다 — 디버그 시각화·로그에서 "명시적 경계로 잡았는지 추정으로
// 잡았는지"를 구분해서 보여주기 위함이기도 하다.
function buildApartmentComplexPolygons(apartmentPolygons,explicitComplexPolygons,refLat){
  const explicit=(explicitComplexPolygons||[]).filter(p=>p.length>=3);
  const uncovered=(apartmentPolygons||[]).filter(bldg=>{
    const [cLat,cLng]=polygonCentroid(bldg);
    return !explicit.some(poly=>pointInPolygon(cLat,cLng,poly));
  });
  const clusters=uncovered.length?clusterApartmentBuildings(uncovered,refLat,APARTMENT_CLUSTER_LINK_M):[];
  const hullEstimated=clusters.map(cluster=>convexHull(cluster.flat())).filter(h=>h.length>=3);
  return {explicit,hullEstimated};
}

// ── 경계 그리기 상태 (nav-app sectorDrawMode/sectorDraftPts와 같은 구조) ──
let boundaryDrawMode=false, boundaryDrawZone=null;
let boundaryDraftPts=[], boundaryDraftLayer=null, boundaryDraftMarkers=[];
// "수정" 버튼을 눌러야만 다시 그리기/경계 지우기 버튼이 펼쳐진다(기본은 접힘)
let boundaryEditOpen=false;

function toggleBoundaryEdit(){
  boundaryEditOpen=!boundaryEditOpen;
  if(!boundaryEditOpen){ cellEditMode=null; exitVertexEditMode(); }
  updateBoundaryUI();
}

// 도로였지만 건물/아파트 제외 마스크에 걸려 빠진 칸을 색으로 보여주는 디버그
// 토글 — 건물=회색, 아파트=보라. paintZoneGapGrid가 실제로 색을 칠한다.
let showExclusionDebug=false;

function toggleExclusionDebug(){
  showExclusionDebug=!showExclusionDebug;
  renderAccumView();
}

// ══════════════════════════════════════════════════════════
//  수동 셀 오버라이드 — "이 칸은 애초에 도로가 아니다(제외)" /
//  "이 칸은 방문한 걸로 친다(방문)" / "GPS가 지나갔어도 미방문으로 친다(미방문)"를
//  사용자가 직접 지정. ⚙️(수정) 패널이 열려있을 때 지도를 클릭해서 칸을 고른다.
//  칸은 gy/gx가 아니라 칸 중심 위경도로 저장해서(DB), 매 렌더링 시점의 격자
//  기준(GAP_CELL_SIZE_M + 그 구역 refLat)으로 다시 gy/gx를 계산한다 — 그래서 구역
//  경계를 다시 그려도(=refLat이 살짝 바뀌어도) 저장된 칸이 어긋나지 않는다.
//
//  상태는 두 층으로 분리한다.
//   · 확정 상태 committedManualCellsByZone — 구역별 DB 저장본
//     {excluded:[], visited:[], unvisited:[]}. 칸을 클릭해도 절대 직접 바뀌지 않고,
//     "선택 적용"의 DB 저장이 성공했을 때만 교체된다.
//   · 현재 편집 pendingManualEdits — 아직 "선택 적용"을 누르지 않은 이번 선택.
//     cellKey -> {lat, lng, targetState}  (targetState: exclude | visited | unvisited | none)
//     지도에는 확정 상태 위에 pending을 미리보기로 겹쳐 그린다.
//
//  한 칸은 excluded / visited / unvisited 중 하나의 수동 상태만 갖는다.
//  Coverage 방문 횟수 우선순위:
//    excluded  → Coverage 대상(전체 유효 Cell)에서 제외
//    unvisited → 유효 셀이지만 방문 0회 (실제 GPS 기록은 지우지 않는다)
//    visited   → 유효 셀이며 최소 방문 1회
//    그 외     → 실제 GPS 방문 횟수
// ══════════════════════════════════════════════════════════
let cellEditMode=null; // null | 'exclude' | 'visit' | 'unvisit'
const CELL_EDIT_TARGET={exclude:'exclude',visit:'visited',unvisit:'unvisited'};
const MANUAL_STATE_LIST={exclude:'excluded',visited:'visited',unvisited:'unvisited'};
const MANUAL_LIST_STATE={excluded:'exclude',visited:'visited',unvisited:'unvisited'};
const MANUAL_LIST_PRIORITY=['excluded','unvisited','visited']; // 한 칸이 여러 목록에 있으면 앞쪽이 이긴다
const committedManualCellsByZone=new Map(); // zone -> {excluded,visited,unvisited} (DB 저장본)
let pendingManualEdits=new Map();            // cellKey -> {lat,lng,targetState}
let pendingManualEditsZone=null;             // pendingManualEdits가 어느 구역 선택인지
let manualApplyInFlight=false;

function emptyManualCells(){ return {excluded:[],visited:[],unvisited:[]}; }

function cellKeyOf(lat,lng,latDeg,lngDeg){
  return Math.floor(lat/latDeg)+'_'+Math.floor(lng/lngDeg);
}

// 구역 하나의 Coverage 격자 기준 — 계산·칸 선택·미리보기가 모두 이 값을 쓴다.
function zoneGrid(zoneName){
  const poly=ZONE_POLYGONS[zoneName];
  if(!poly||poly.length<3) return null;
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);
  const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
  const refLat=(minLat+maxLat)/2;
  const cellSizeM=coverageCellSizeM();
  return {
    poly,minLat,maxLat,minLng,maxLng,refLat,cellSizeM,
    latDeg:cellSizeM/111320,
    lngDeg:cellSizeM/(111320*Math.cos(refLat*Math.PI/180)),
  };
}

// 확정 상태 한 구역치를 불러온다(구역별 메모리 캐시). 실패하면 빈 상태를 돌려주되
// 캐시하지 않는다 — 그걸로 계산한 Coverage 결과도 캐시되지 않는다(cacheable=false).
async function loadCommittedManualCells(zoneName){
  if(committedManualCellsByZone.has(zoneName)) return committedManualCellsByZone.get(zoneName);
  try{
    const cells=CoverageGrid.normalizeManualCells(await RouteDB.getZoneManualCells(zoneName));
    committedManualCellsByZone.set(zoneName,cells);
    return cells;
  }catch(err){
    console.warn('[경로뷰어] '+zoneName+' 수동 셀 오버라이드를 불러오지 못했어요:',err);
    return emptyManualCells();
  }
}

// 위경도 점들을 "지금 이 순간의" 격자 기준으로 gy_gx Set으로 바꾼다.
function manualCellKeySet(points,latDeg,lngDeg){
  const set=new Set();
  (points||[]).forEach(([lat,lng])=>set.add(cellKeyOf(lat,lng,latDeg,lngDeg)));
  return set;
}

// 격자 기준으로 정리 — 같은 칸이 여러 목록에 있으면(구버전 데이터·동기화 병합 등)
// 우선순위가 가장 높은 목록 하나에만 남기고, 같은 목록 안의 중복도 없앤다.
function normalizeManualCellsForGrid(cells,latDeg,lngDeg){
  const n=CoverageGrid.normalizeManualCells(cells);
  const seen=new Set();
  const out=emptyManualCells();
  MANUAL_LIST_PRIORITY.forEach(name=>{
    n[name].forEach(p=>{
      const key=cellKeyOf(p[0],p[1],latDeg,lngDeg);
      if(seen.has(key)) return;
      seen.add(key);
      out[name].push(p);
    });
  });
  return out;
}

// cellKey -> 'exclude' | 'visited' | 'unvisited'
function manualStateMap(cells,latDeg,lngDeg){
  const map=new Map();
  const n=normalizeManualCellsForGrid(cells,latDeg,lngDeg);
  MANUAL_LIST_PRIORITY.forEach(name=>{
    n[name].forEach(p=>map.set(cellKeyOf(p[0],p[1],latDeg,lngDeg),MANUAL_LIST_STATE[name]));
  });
  return map;
}

// Coverage 방문 횟수 — excluded 칸은 이 함수에 오기 전에 Coverage 대상에서 빠진다.
function effectiveCellVisits(rawVisits,manualState){
  const raw=rawVisits||0;
  if(manualState==='unvisited') return 0;
  if(manualState==='visited') return Math.max(1,raw);
  return raw;
}

// 확정 상태 복사본 + pending 변경 → 새 확정 상태 (입력은 건드리지 않는 순수 함수).
// pending에 있는 칸은 세 목록에서 모두 뺀 뒤 targetState 목록에만 다시 넣는다(none이면 해제).
function mergeManualCellEdits(committed,pending,latDeg,lngDeg){
  const base=normalizeManualCellsForGrid(committed,latDeg,lngDeg);
  const edits=new Map();
  (pending||new Map()).forEach(edit=>edits.set(cellKeyOf(edit.lat,edit.lng,latDeg,lngDeg),edit));
  const out=emptyManualCells();
  MANUAL_LIST_PRIORITY.forEach(name=>{
    base[name].forEach(p=>{
      if(!edits.has(cellKeyOf(p[0],p[1],latDeg,lngDeg))) out[name].push([p[0],p[1]]);
    });
  });
  edits.forEach(edit=>{
    const list=MANUAL_STATE_LIST[edit.targetState];
    if(list) out[list].push([edit.lat,edit.lng]);
  });
  return out;
}

function defaultCoverageHint(){
  return '실선/점선 도형 = 직접 그린 구역 경계 · 빨간 칸 = 아직 한 번도 지나가지 않은 곳';
}

function pendingManualEditCount(){
  return pendingManualEditsZone===accumZoneFilter?pendingManualEdits.size:0;
}

function updateCellEditHint(){
  const hintEl=document.getElementById('accum-hint');
  if(!hintEl) return;
  const n=pendingManualEditCount();
  const pendingText=n?` · 지금 ${n}칸 선택됨`:'';
  const label={exclude:'제외할',visit:'방문 처리할',unvisit:'미방문으로 표시할'}[cellEditMode];
  if(label){
    hintEl.textContent=`${accumZoneFilter}에서 ${label} 칸을 지도에서 클릭하세요(다시 누르면 취소). 여러 칸을 찍은 뒤 선택 적용을 누르세요${pendingText}.`;
  }else if(showCoverageGaps){
    hintEl.textContent=n
      ? `선택 적용을 누르면 이번에 찍은 ${n}칸만 저장하고 커버리지를 다시 계산해요.`
      : defaultCoverageHint();
  }
}

function setCellEditMode(mode){
  if(!showCoverageGaps) return;
  if(accumZoneFilter==='all'||!ZONE_POLYGONS[accumZoneFilter]||ZONE_POLYGONS[accumZoneFilter].length<3){
    cellEditMode=null;
    updateBoundaryUI();
    const hintEl=document.getElementById('accum-hint');
    if(hintEl) hintEl.textContent='먼저 구역을 선택하고 경계를 그려주세요.';
    return;
  }
  cellEditMode=(cellEditMode===mode)?null:mode; // 같은 버튼 다시 누르면 끔
  if(cellEditMode) exitVertexEditMode(); // 꼭짓점 드래그 모드와 동시에 안 켜지게
  updateBoundaryUI();
  updateCellEditHint();
}

// "선택 적용" — 이번에 찍은 pending 칸만 확정 상태에 반영한다.
async function applyManualCellEdits(){
  const zone=accumZoneFilter;
  if(zone==='all'||manualApplyInFlight||!pendingManualEdits.size||pendingManualEditsZone!==zone) return false;
  const grid=zoneGrid(zone);
  if(!grid) return false;
  const committed=await loadCommittedManualCells(zone);
  const next=mergeManualCellEdits(committed,pendingManualEdits,grid.latDeg,grid.lngDeg);
  const count=pendingManualEdits.size;
  manualApplyInFlight=true;
  updateBoundaryUI();
  let saved;
  try{
    saved=await RouteDB.saveZoneManualCells(zone,next); // DB 저장은 한 번만
  }catch(err){
    // 실패하면 확정 상태도 이번 선택(pending)도 그대로 둔다 — 다시 적용할 수 있게
    console.warn('[경로뷰어] 수동 셀 오버라이드 저장 실패:',err);
    showError('선택 셀을 저장하지 못했어요. 선택은 그대로 남아있으니 다시 적용해 주세요. ('+err.message+')');
    return false;
  }finally{
    manualApplyInFlight=false;
    updateBoundaryUI();
  }
  // 저장에 성공한 뒤에만 메모리의 확정 상태를 교체한다
  committedManualCellsByZone.set(zone,CoverageGrid.normalizeManualCells(saved||next));
  pendingManualEdits=new Map();
  pendingManualEditsZone=null;
  cellEditMode=null;
  invalidateCoverage('manual-cells',zone); // 이 구역 Coverage만 다시 계산
  updateBoundaryUI();
  if(typeof showToast==='function') showToast(`${zone} 선택 셀 ${count}칸을 적용했어요.`);
  await renderAccumView();
  return true;
}

// "현재 구역 선택 초기화" — 아직 적용하지 않은 이번 선택(미리보기)만 지운다.
// DB 저장도, 확정 상태 변경도, Coverage 재계산도 하지 않는다.
function clearPendingManualCellSelection(){
  pendingManualEdits=new Map();
  pendingManualEditsZone=null;
  renderPendingManualPreview();
  updateBoundaryUI();
  updateCellEditHint();
}

// 지도 클릭 한 번 = pending 한 칸 토글. 확정 상태는 읽기만 한다(DB 저장 없음).
async function toggleManualCellAt(lat,lng){
  if(!cellEditMode||accumZoneFilter==='all'||manualApplyInFlight) return false;
  const zone=accumZoneFilter;
  const target=CELL_EDIT_TARGET[cellEditMode];
  const grid=zoneGrid(zone);
  if(!target||!grid) return false;
  if(!pointInPolygon(lat,lng,grid.poly)) return false; // 구역 경계 밖 클릭은 무시

  const gy=Math.floor(lat/grid.latDeg), gx=Math.floor(lng/grid.lngDeg);
  const key=gy+'_'+gx;
  const committed=await loadCommittedManualCells(zone);
  if(zone!==accumZoneFilter||!cellEditMode) return false; // 기다리는 사이 구역/모드가 바뀜

  if(pendingManualEditsZone!==zone){ pendingManualEdits=new Map(); pendingManualEditsZone=zone; }
  const committedState=manualStateMap(committed,grid.latDeg,grid.lngDeg).get(key)||'none';
  const current=pendingManualEdits.has(key)?pendingManualEdits.get(key).targetState:committedState;
  const desired=(current===target)?'none':target; // 같은 모드로 다시 누르면 그 상태를 해제
  if(desired===committedState) pendingManualEdits.delete(key); // 확정 상태와 같아지면 변경 없음
  else pendingManualEdits.set(key,{lat:(gy+0.5)*grid.latDeg,lng:(gx+0.5)*grid.lngDeg,targetState:desired});
  if(!pendingManualEdits.size) pendingManualEditsZone=null;

  renderPendingManualPreview();
  updateBoundaryUI();
  updateCellEditHint();
  return true;
}

// ── 구역 경계 꼭짓점 드래그 편집 ──────────────────────────────────
// ⚙️ 패널이 열려있을 때 구역 경계선을 클릭하면(요구사항 12) 꼭짓점마다
// 드래그 가능한 핸들을 띄운다. L.circleMarker/L.polygon은 코어 Leaflet에서
// 드래그를 지원하지 않아서(플러그인 필요), 대신 draggable 옵션을 기본
// 지원하는 L.marker(divIcon)를 꼭짓점 핸들로 쓴다.
let vertexEditActive=false;
let vertexEditZone=null;
let vertexEditLayers=[];

function clearVertexEditLayers(){
  vertexEditLayers.forEach(l=>accumMap.removeLayer(l));
  vertexEditLayers=[];
}

function exitVertexEditMode(){
  if(!vertexEditActive) return;
  vertexEditActive=false;
  vertexEditZone=null;
  clearVertexEditLayers();
}

function renderVertexEditHandles(zone){
  clearVertexEditLayers();
  const poly=ZONE_POLYGONS[zone];
  if(!poly||poly.length<3) return;
  const liveOutline=L.polygon(poly,{color:'#f59e0b',weight:3,dashArray:'6,6',fillOpacity:.08,interactive:false}).addTo(accumMap);
  vertexEditLayers.push(liveOutline);
  poly.forEach((pt,idx)=>{
    const marker=L.marker(pt,{
      draggable:true,
      icon:L.divIcon({className:'vertex-handle',iconSize:[16,16],iconAnchor:[8,8]}),
    }).addTo(accumMap);
    marker.on('drag',()=>{
      const ll=marker.getLatLng();
      poly[idx]=[ll.lat,ll.lng];
      liveOutline.setLatLngs(poly);
    });
    marker.on('dragend',()=>{
      saveZonePolygonsToStorage();
      // 건물/아파트/도로 캐시는 경계 bbox가 바뀌면 다시 받아와야 하니 무효화한다
      delete loadZoneBuildingsCache()[zone];
      delete loadZoneRoadsCache()[zone];
      saveZoneBuildingsCache();
      saveZoneRoadsCache();
      invalidateCoverage('boundary',zone);
      if(showCoverageGaps) renderAccumView();
    });
    vertexEditLayers.push(marker);
  });
}

function toggleVertexEditMode(zone){
  if(!boundaryEditOpen) return; // ⚙️ 패널이 열려있을 때만 허용
  if(vertexEditActive&&vertexEditZone===zone){
    exitVertexEditMode();
    document.getElementById('accum-hint').textContent=defaultCoverageHint();
    return;
  }
  cellEditMode=null; // 칸 편집 모드와 동시에 안 켜지게
  updateBoundaryUI();
  vertexEditActive=true;
  vertexEditZone=zone;
  renderVertexEditHandles(zone);
  document.getElementById('accum-hint').textContent=`${zone} 경계 꼭짓점을 드래그해서 모양을 바꿀 수 있어요. 마치려면 경계선을 다시 누르세요.`;
}

function startBoundaryDraw(){
  if(accumZoneFilter==='all'){
    const hintEl=document.getElementById('accum-hint');
    if(hintEl) hintEl.textContent='커버리지 갭을 보려면 먼저 강남, 판교, 시흥 중 하나를 선택하세요.';
    return;
  }
  initAccumMap();
  cellEditMode=null;
  exitVertexEditMode();
  boundaryDrawMode=true;
  boundaryDrawZone=accumZoneFilter;
  boundaryDraftPts=[];
  clearBoundaryDraft();
  coverageLayer.clearLayers();
  accumDensityLayer.clearLayers();
  accumCells=[];
  coverageDirty=true; // 그려둔 지도를 비웠으니 다음에 누적 지도에 들어오면 다시 그린다
  if(ZONE_CENTERS[accumZoneFilter]){
    accumMap.setView(ZONE_CENTERS[accumZoneFilter],13);
  }
  document.getElementById('accum-hint').textContent=`${accumZoneFilter} 경계를 그리는 중입니다. 지도 위를 클릭해서 꼭짓점을 찍고 완료를 누르세요.`;
  document.getElementById('boundary-draw-bar').classList.add('show');
}

function onBoundaryMapClick(e){
  if(boundaryDrawMode){
    boundaryDraftPts.push([e.latlng.lat,e.latlng.lng]);
    drawBoundaryDraft();
    return;
  }
  if(cellEditMode&&showCoverageGaps){
    toggleManualCellAt(e.latlng.lat,e.latlng.lng);
  }
}

function drawBoundaryDraft(){
  if(boundaryDraftLayer){ accumMap.removeLayer(boundaryDraftLayer); boundaryDraftLayer=null; }
  boundaryDraftMarkers.forEach(m=>accumMap.removeLayer(m)); boundaryDraftMarkers=[];
  if(boundaryDraftPts.length>=2){
    boundaryDraftLayer=(boundaryDraftPts.length>=3)
      ? L.polygon(boundaryDraftPts,{color:'#f59e0b',weight:3,fillOpacity:.12,dashArray:'6,6'}).addTo(accumMap)
      : L.polyline(boundaryDraftPts,{color:'#f59e0b',weight:3,dashArray:'6,6'}).addTo(accumMap);
  }
  boundaryDraftPts.forEach(p=>{
    boundaryDraftMarkers.push(
      L.circleMarker(p,{radius:6,color:'#fff',weight:2,fillColor:'#f59e0b',fillOpacity:1}).addTo(accumMap)
    );
  });
  const cnt=document.getElementById('boundary-pt-count');
  if(cnt) cnt.textContent=`꼭짓점 ${boundaryDraftPts.length}개`;
}

function clearBoundaryDraft(){
  if(boundaryDraftLayer){ accumMap.removeLayer(boundaryDraftLayer); boundaryDraftLayer=null; }
  boundaryDraftMarkers.forEach(m=>accumMap.removeLayer(m)); boundaryDraftMarkers=[];
  const cnt=document.getElementById('boundary-pt-count');
  if(cnt) cnt.textContent='꼭짓점 0개';
}

function undoBoundaryPoint(){
  boundaryDraftPts.pop();
  drawBoundaryDraft();
}

// skipRender: 바로 뒤에 호출부가 어차피 renderAccumView()를 부를 때
function cancelBoundaryDraw(skipRender){
  boundaryDrawMode=false;
  boundaryDraftPts=[];
  clearBoundaryDraft();
  document.getElementById('boundary-draw-bar').classList.remove('show');
  updateBoundaryUI();
  // 그리기를 시작할 때 비운 Coverage 레이어를 되살린다(바뀐 게 없으면 캐시로 바로 그려진다)
  if(!skipRender&&showCoverageGaps) renderAccumView();
}

function finishBoundaryDraw(){
  if(boundaryDraftPts.length<3){
    alert('꼭짓점을 3개 이상 찍어야 구역이 됩니다.');
    return;
  }
  ZONE_POLYGONS[boundaryDrawZone]=boundaryDraftPts.map(p=>[p[0],p[1]]);
  saveZonePolygonsToStorage();
  invalidateCoverage('boundary',boundaryDrawZone);
  boundaryDrawMode=false;
  boundaryDraftPts=[];
  clearBoundaryDraft();
  document.getElementById('boundary-draw-bar').classList.remove('show');
  updateBoundaryUI();
  if(showCoverageGaps) renderAccumView();
}

function clearZoneBoundary(){
  if(accumZoneFilter==='all'||!ZONE_POLYGONS[accumZoneFilter]) return;
  delete ZONE_POLYGONS[accumZoneFilter];
  invalidateCoverage('boundary',accumZoneFilter);
  delete loadZoneBuildingsCache()[accumZoneFilter];
  delete loadZoneRoadsCache()[accumZoneFilter];
  saveZoneBuildingsCache();
  saveZoneRoadsCache();
  saveZonePolygonsToStorage();
  updateBoundaryUI();
  if(showCoverageGaps) renderAccumView();
}

function updateBoundaryUI(){
  updateCaptureButton();
  const editBtn=document.getElementById('boundary-edit-toggle-btn');
  if(editBtn){
    editBtn.style.display=showCoverageGaps?'inline-flex':'none';
    editBtn.classList.toggle('active',boundaryEditOpen);
  }
  const controls=document.getElementById('boundary-controls');
  if(controls) controls.style.display=(showCoverageGaps&&boundaryEditOpen)?'flex':'none';

  const debugBtn=document.getElementById('exclusion-debug-toggle-btn');
  if(debugBtn){
    debugBtn.style.display=showCoverageGaps?'inline-flex':'none';
    debugBtn.classList.toggle('active',showExclusionDebug);
  }

  const excludeBtn=document.getElementById('cell-exclude-btn');
  if(excludeBtn) excludeBtn.classList.toggle('active',cellEditMode==='exclude');
  const visitBtn=document.getElementById('cell-visit-btn');
  if(visitBtn) visitBtn.classList.toggle('active',cellEditMode==='visit');
  const unvisitBtn=document.getElementById('cell-unvisit-btn');
  if(unvisitBtn) unvisitBtn.classList.toggle('active',cellEditMode==='unvisit');
  // N = 이번에 찍었지만 아직 적용하지 않은 칸 수(이미 적용된 누적 칸 수가 아님)
  const pendingCount=pendingManualEditCount();
  const applyBtn=document.getElementById('manual-apply-btn');
  if(applyBtn){
    applyBtn.disabled=!pendingCount||manualApplyInFlight;
    applyBtn.classList.toggle('active',pendingCount>0);
    applyBtn.textContent=manualApplyInFlight?'적용 중…':(pendingCount?`선택 적용 (${pendingCount})`:'선택 적용');
  }
  const clearSelBtn=document.getElementById('manual-clear-selection-btn');
  if(clearSelBtn) clearSelBtn.disabled=!pendingCount||manualApplyInFlight;
  const mapWrap=document.getElementById('accum-map-wrap');
  if(mapWrap) mapWrap.classList.toggle('cell-edit-mode',!!cellEditMode);

  const btn=document.getElementById('boundary-draw-btn');
  const clearBtn=document.getElementById('boundary-clear-btn');
  if(!btn) return;
  const noZone=accumZoneFilter==='all';
  const has=!noZone&&ZONE_POLYGONS[accumZoneFilter];
  btn.textContent=noZone?'강남/판교/시흥을 선택하세요':(has?`${accumZoneFilter} 경계 다시 그리기`:`${accumZoneFilter} 경계 그리기`);
  btn.disabled=noZone;
  if(clearBtn) clearBtn.style.display=has?'inline-flex':'none';
}

// ══════════════════════════════════════════════════════════
//  구역 건물 폴리곤(OSM) — 커버리지 계산에서 건물 위 칸을 뺀다.
//  거리를 다 돌아도 건물 내부까지 "미방문 칸"으로 잡히면 100%를 영원히
//  못 채우게 되므로, Overpass API로 구역 bbox 안 건물 외곽선을 받아와
//  그 위에 중심점이 있는 격자 칸은 total/visited 계산에서 아예 뺀다.
//  구역별로 localStorage에 캐싱하고, 구역 경계(bbox)가 바뀌기 전까지는
//  다시 받아오지 않는다. 오프라인 등으로 못 받아오면 예전 캐시(있으면)
//  또는 빈 목록(=건물 제외 없이 예전 방식)으로 조용히 넘어간다.
// ══════════════════════════════════════════════════════════
// v5 — amenity=parking(주차장)을 parkingPolygons로 추가했다(단지 밖 독립
// 주차장도 빼려고). 캐시 키를 매번 올리면, 마침 그때 Overpass가 죽어있으면
// (실제로 이 작업 중에도 미러 3개가 한꺼번에 다운돼 있었다) 새 버전 캐시가
// 텅 빈 채로 시작해서 오히려 제외가 하나도 안 되는 역효과가 난다 — v4
// 캐시가 있으면(주차장 제외만 빠진 채) 최소한 그걸로 우선 보여주고, 성공
// 하면 그때 v5로 갈아탄다.
const ZONE_BUILDINGS_LS_KEY='route_viewer_zone_buildings_v5';
const ZONE_BUILDINGS_LEGACY_LS_KEY='route_viewer_zone_buildings_v4';

function readLegacyBuildingsFallback(zoneName,bboxKey){
  try{
    const legacy=JSON.parse(localStorage.getItem(ZONE_BUILDINGS_LEGACY_LS_KEY)||'{}');
    const entry=legacy[zoneName];
    if(entry&&entry.bboxKey===bboxKey&&entry.buildings){
      console.warn('[경로뷰어] 최신 건물/주차장 데이터를 못 받아와서, 이전에 받아둔 데이터(주차장 제외는 없이)로 우선 보여줘요.');
      return {parkingPolygons:[], ...entry.buildings};
    }
  }catch(_){/* 무시 — 폴백 실패는 EMPTY_BUILDINGS로 이어진다 */}
  return null;
}
const ZONE_ROADS_LS_KEY='route_viewer_zone_roads_v1';
let zoneBuildingsCache=null;
let zoneBuildingsFetchPromise={};
let zoneRoadsCache=null;
let zoneRoadsFetchPromise={};
// 건물/도로 데이터를 못 받아서 예전 캐시·빈 목록으로 대신 쓴 구역 — 그렇게 계산한
// Coverage는 캐시하지 않는다(다음 진입 때 다시 받아와 본다).
const zoneMapDataDegraded={buildings:{},roads:{}};
function isZoneMapDataDegraded(zoneName){
  return !!(zoneMapDataDegraded.buildings[zoneName]||zoneMapDataDegraded.roads[zoneName]);
}

function loadZoneBuildingsCache(){
  if(zoneBuildingsCache) return zoneBuildingsCache;
  try{ zoneBuildingsCache=JSON.parse(localStorage.getItem(ZONE_BUILDINGS_LS_KEY)||'{}'); }
  catch(_){ zoneBuildingsCache={}; }
  return zoneBuildingsCache;
}

function saveZoneBuildingsCache(){
  try{ localStorage.setItem(ZONE_BUILDINGS_LS_KEY,JSON.stringify(zoneBuildingsCache)); }
  catch(err){ console.warn('[경로뷰어] 건물 캐시 저장 실패:',err); }
}

function loadZoneRoadsCache(){
  if(zoneRoadsCache) return zoneRoadsCache;
  try{ zoneRoadsCache=JSON.parse(localStorage.getItem(ZONE_ROADS_LS_KEY)||'{}'); }
  catch(_){ zoneRoadsCache={}; }
  return zoneRoadsCache;
}

function saveZoneRoadsCache(){
  try{ localStorage.setItem(ZONE_ROADS_LS_KEY,JSON.stringify(zoneRoadsCache)); }
  catch(err){ console.warn('[route-viewer] road cache save failed:',err); }
}

function bboxKeyFor(poly){
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  return [Math.min(...lats),Math.max(...lats),Math.min(...lngs),Math.max(...lngs)].map(n=>n.toFixed(5)).join(',');
}

// overpass-api.de 가 죽어있거나(무료 커뮤니티 서버라 종종 있음) 이 네트워크에서
// 막혀있으면 다음 미러로 넘어간다. 하나라도 성공하면 그 결과를 쓴다.
const OVERPASS_MIRRORS=[
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function runOverpassQuery(query){
  let lastErr=null;
  for(const url of OVERPASS_MIRRORS){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const res=await fetch(url,{
        method:'POST',
        headers:{'Content-Type':'text/plain'},
        body:query,
        signal:controller.signal,
      });
      if(!res.ok) throw new Error('overpass HTTP '+res.status+' ('+url+')');
      return await res.json();
    }catch(err){
      lastErr=err;
      console.warn('[route-viewer] overpass mirror failed, trying next:',url,err);
    }finally{
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 건물은 단순 way뿐 아니라, 아파트 단지처럼 안뜰이 있는 복잡한 모양은
// OSM에 relation(멀티폴리곤)으로 올라오는 경우가 흔하다(강남/판교의 대단지가
// 특히 그렇다). way만 받으면 그런 큰 단지들이 통째로 빠져서, 커버리지 갭
// 계산에서 건물 내부가 계속 "미방문 칸"으로 잘못 남는다 — relation도 같이 받는다.
//
// 아파트 동은 building/apartmentPolygons로 따로 모은다 — 한국 OSM 매핑
// 관례상 아파트 동은 building=apartments(또는 residential=apartments)로
// 구분되고, 단독주택 등은 다른 값을 쓴다.
function isApartmentBuildingTags(tags){
  if(!tags) return false;
  return tags.building==='apartments' || tags.residential==='apartments' || !!tags['building:flats'];
}

// landuse=residential "전체"는 절대 안 쓴다(일반 주거지역까지 통째로
// 지워짐) — 하지만 landuse=residential + residential=apartments 조합은
// 매퍼가 그 아파트 "단지 부지 하나"를 명시적으로 그려둔 것이라 신뢰할 수
// 있다(실측: 신현대아파트 = way 436407134, 정확히 이 태그 조합, 18개
// 꼭짓점의 실제 단지 경계). 이게 있으면 클러스터링/hull 추정 없이 그대로
// 쓴다 — 사람이 그린 경계가 추정보다 항상 정확하다.
function isExplicitApartmentComplexTags(tags){
  return !!tags && tags.landuse==='residential' && tags.residential==='apartments';
}

// 주차장(amenity=parking) — 아파트 단지 밖에 있는 독립 주차장(상가 주차장 등)은
// apartment/building 마스크로 안 잡히므로 따로 받는다. 단지 내부 주차장은
// 보통 별도 amenity=parking 폴리곤 없이 그냥 단지 부지 안에 있어서 이미
// apartment 마스크로 커버되지만, 밖에 있는 주차장은 이게 없으면 못 뺀다.
function isParkingTags(tags){
  return !!tags && tags.amenity==='parking';
}

async function fetchBuildingsForBbox(minLat,minLng,maxLat,maxLng){
  const bboxArg=`(${minLat},${minLng},${maxLat},${maxLng})`;
  const query=`[out:json][timeout:25];(`
    +`way["building"]${bboxArg};relation["building"]${bboxArg};`
    +`way["landuse"="residential"]["residential"="apartments"]${bboxArg};`
    +`relation["landuse"="residential"]["residential"="apartments"]${bboxArg};`
    +`way["amenity"="parking"]${bboxArg};relation["amenity"="parking"]${bboxArg};`
    +`);out geom;`;
  const data=await runOverpassQuery(query);
  const buildingPolygons=[];
  const apartmentPolygons=[];
  const explicitComplexPolygons=[];
  const parkingPolygons=[];
  (data.elements||[]).forEach(el=>{
    const target=isExplicitApartmentComplexTags(el.tags) ? explicitComplexPolygons
      : isParkingTags(el.tags) ? parkingPolygons
      : isApartmentBuildingTags(el.tags) ? apartmentPolygons
      : buildingPolygons;
    if(el.type==='way'&&Array.isArray(el.geometry)&&el.geometry.length>=3){
      target.push(el.geometry.map(pt=>[pt.lat,pt.lon]));
    }else if(el.type==='relation'&&Array.isArray(el.members)){
      // outer 링마다 하나의 폴리곤으로 취급(안뜰 구멍은 무시 — 칸을 좀 더
      // 넓게 빼는 쪽이, 큰 단지를 통째로 놓치는 것보다 낫다).
      el.members.forEach(m=>{
        if(m.role==='outer'&&Array.isArray(m.geometry)&&m.geometry.length>=3){
          target.push(m.geometry.map(pt=>[pt.lat,pt.lon]));
        }
      });
    }
  });
  return {buildingPolygons,apartmentPolygons,explicitComplexPolygons,parkingPolygons};
}

// zoneName의 건물 폴리곤 목록. 캐시가 있고 구역 경계가 그대로면 캐시를 쓰고,
// 없거나 경계가 바뀌었으면 Overpass에서 새로 받아온다.
async function fetchRoadsForBbox(minLat,minLng,maxLat,maxLng){
  const driveable='motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const query=`[out:json][timeout:25];way["highway"~"^(${driveable})$"](${minLat},${minLng},${maxLat},${maxLng});out geom;`;
  const data=await runOverpassQuery(query);
  const lines=[];
  (data.elements||[]).forEach(el=>{
    if(el.type==='way'&&Array.isArray(el.geometry)&&el.geometry.length>=2){
      lines.push(el.geometry.map(pt=>[pt.lat,pt.lon]));
    }
  });
  return lines;
}

const EMPTY_BUILDINGS={buildingPolygons:[],apartmentPolygons:[],explicitComplexPolygons:[],parkingPolygons:[]};

async function getZoneBuildingPolygons(zoneName){
  const poly=ZONE_POLYGONS[zoneName];
  if(!poly||poly.length<3) return EMPTY_BUILDINGS;
  const cache=loadZoneBuildingsCache();
  const key=bboxKeyFor(poly);
  const cached=cache[zoneName];
  if(cached&&cached.bboxKey===key){ delete zoneMapDataDegraded.buildings[zoneName]; return cached.buildings; }
  if(zoneBuildingsFetchPromise[zoneName]) return zoneBuildingsFetchPromise[zoneName];
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);
  const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
  const promise=fetchBuildingsForBbox(minLat,minLng,maxLat,maxLng).then(buildings=>{
    cache[zoneName]={bboxKey:key,buildings,fetchedAt:Date.now()};
    saveZoneBuildingsCache();
    delete zoneBuildingsFetchPromise[zoneName];
    delete zoneMapDataDegraded.buildings[zoneName];
    return buildings;
  }).catch(err=>{
    console.warn('[경로뷰어] '+zoneName+' 건물 데이터를 가져오지 못했어요(오프라인일 수 있음):',err);
    zoneMapDataDegraded.buildings[zoneName]=true;
    delete zoneBuildingsFetchPromise[zoneName];
    return cached?.buildings || readLegacyBuildingsFallback(zoneName,key) || EMPTY_BUILDINGS;
  });
  zoneBuildingsFetchPromise[zoneName]=promise;
  return promise;
}

// ── 강남권 HD map(산자부 E2E 데이터협의체 표준노드링크) ──────────────────
// [산자부E2E][데이터협의체]HDMap_구축지역(강남)_세부구역_260209 폴더의
// shapefile(강남구/서초구 도로)을
// tools/convert-hdmap-shapefile.ps1로 미리 WGS84 lat/lng로 변환해
// src/data/hdmap_*_roads.js에 넣어뒀다. "강남" 운영 구역은 실제로 옆 서초
// 경계까지 같이 그려 쓰므로, 강남 커버리지 계산에서는 강남+서초 HD map을
// 한 묶음으로 합쳐서 도로로 인정한다 — OSM/Overpass는 이 구역에서 아예 안 쓴다.
//
// 이 .js는 index.html이 <script src="data/hdmap_*_roads.js">로
// 로드해서 window.HDMAP_*_ROADS 전역에 데이터를 담아준다 — fetch()로
// 로컬 JSON을 읽는 방식은 안 쓴다. src/index.html을 file://로 그냥
// 더블클릭해서 열면 fetch()가 브라우저 CORS 정책에 막히지만(Failed to
// fetch), <script> 태그는 file:// 에서도 그대로 로드되기 때문이다 — 이
// 방식이면 file:// 직접 열기 / node server.js / Electron 세 가지 실행
// 방식이 전부 코드 한 줄 안 바꾸고 동일하게 동작한다.
const HDMAP_ZONE_GLOBALS={
  '강남':['HDMAP_GANGNAM_ROADS','HDMAP_SEOCHO_ROADS'],
  // 사용자가 별도 "서초" 구역을 직접 만들어 쓰는 경우만 지원한다. 기본 지역으로는 만들지 않는다.
  '서초':['HDMAP_SEOCHO_ROADS'],
};
let hdmapRoadsCache={};

function hdmapGlobalNamesFor(zoneName){
  const globals=HDMAP_ZONE_GLOBALS[zoneName];
  if(Array.isArray(globals)) return globals;
  return globals?[globals]:[];
}

function hdmapSourceLabel(zoneName){
  return hdmapGlobalNamesFor(zoneName).map(g=>'window.'+g).join(' + ');
}

function loadHdmapRoads(zoneName){
  const globalNames=hdmapGlobalNamesFor(zoneName);
  if(!globalNames.length) return [];
  if(hdmapRoadsCache[zoneName]) return hdmapRoadsCache[zoneName];
  const lines=[];
  const missing=[];
  globalNames.forEach(globalName=>{
    const data=window[globalName];
    if(!data){
      missing.push(globalName);
      return;
    }
    (data.lines||[]).map(l=>l.points)
      .filter(pts=>Array.isArray(pts)&&pts.length>=2)
      .forEach(pts=>lines.push(pts));
  });
  if(missing.length){
    console.warn('[경로뷰어] '+zoneName+' HD map 데이터('+missing.join(', ')+')가 없어요 — index.html에서 data/hdmap_gangnam_roads.js / data/hdmap_seocho_roads.js가 제대로 로드됐는지 확인해주세요.');
  }
  console.log('[경로뷰어] '+zoneName+' HD map 도로 '+lines.length+'개 로드 완료 ('+hdmapSourceLabel(zoneName)+')');
  hdmapRoadsCache[zoneName]=lines;
  return lines;
}

async function getZoneRoadPolylines(zoneName){
  if(hdmapGlobalNamesFor(zoneName).length) return loadHdmapRoads(zoneName);
  const poly=ZONE_POLYGONS[zoneName];
  if(!poly||poly.length<3) return [];
  const cache=loadZoneRoadsCache();
  const key=bboxKeyFor(poly);
  const cached=cache[zoneName];
  if(cached&&cached.bboxKey===key){ delete zoneMapDataDegraded.roads[zoneName]; return cached.lines; }
  if(zoneRoadsFetchPromise[zoneName]) return zoneRoadsFetchPromise[zoneName];
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);
  const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
  const promise=fetchRoadsForBbox(minLat,minLng,maxLat,maxLng).then(lines=>{
    cache[zoneName]={bboxKey:key,lines,fetchedAt:Date.now()};
    saveZoneRoadsCache();
    delete zoneRoadsFetchPromise[zoneName];
    delete zoneMapDataDegraded.roads[zoneName];
    return lines;
  }).catch(err=>{
    console.warn('[route-viewer] road data fetch failed for '+zoneName+':',err);
    zoneMapDataDegraded.roads[zoneName]=true;
    delete zoneRoadsFetchPromise[zoneName];
    return cached?cached.lines:[];
  });
  zoneRoadsFetchPromise[zoneName]=promise;
  return promise;
}

// polygons 각각의 경계에서 bufferM(미터) 이내인 칸을 전부 뺀다 — 실제 polygon
// buffer/union 없이, 폴리곤별로 자기 bbox(+buffer 여유)만 훑어서 칸 중심까지의
// 거리를 재는 방식이라 O(폴리곤별 지역 칸 수)로 끝난다.
// bufferM이 크면(아파트 단지) 옆 동 폴리곤의 buffer와 자연히 겹쳐서, 동 사이
// 내부도로·주차장까지 하나로 묶여 빠진다 — 별도 클러스터링/유니온 계산 없이도
// 같은 효과를 낸다.
function buildExcludedCellSet(polygons,latDeg,lngDeg,refLat,bufferM){
  const excluded=new Set();
  const {mLat,mLng}=mPerDegAt(refLat);
  const marginLatDeg=bufferM/mLat, marginLngDeg=bufferM/mLng;
  (polygons||[]).forEach(poly=>{
    const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
    const minLat=Math.min(...lats)-marginLatDeg, maxLat=Math.max(...lats)+marginLatDeg;
    const minLng=Math.min(...lngs)-marginLngDeg, maxLng=Math.max(...lngs)+marginLngDeg;
    const laStart=Math.floor(minLat/latDeg), laEnd=Math.ceil(maxLat/latDeg);
    const loStart=Math.floor(minLng/lngDeg), loEnd=Math.ceil(maxLng/lngDeg);
    for(let la=laStart;la<=laEnd;la++){
      for(let lo=loStart;lo<=loEnd;lo++){
        const key=la+'_'+lo;
        if(excluded.has(key)) continue;
        const cellLat=(la+0.5)*latDeg, cellLng=(lo+0.5)*lngDeg;
        if(polygonDistanceM(cellLat,cellLng,poly,refLat)<=bufferM) excluded.add(key);
      }
    }
  });
  return excluded;
}

// 커버리지 갭 격자 칠하기 — insideTest(lat,lng)가 true인 칸 중,
// 그동안 기록이 없던 칸만 빨갛게 칠한다. (다각형 경계 전용, 원 근사는 더 이상 없음)
//
// 예전에는 전체 포인트 배열을 받아 여기서 방문 칸을 계산했지만, 이제는
// "지나간 칸 목록"을 DB가 계산해서 넘겨준다(getVisitedCellKeys).
// 포인트가 수십만 개여도 화면으로 넘어오는 건 칸 목록뿐이다.
//
// 요구사항 12: GPS point 개수가 아니라 "방문 세션" 기준으로 센다 — 같은 칸에
// 연속으로 찍힌 점은 방문 1회로 묶고, 칸을 벗어났다가 다시 들어오거나 다른
// 날짜/차량이면 새 방문으로 센다. 이 계산은 DB(getCellVisitCounts)가 SQL
// 윈도우 함수로 해준다.
//
// showCoverageDepth 가 켜져 있으면 방문 횟수 등급(0/1/2~4/5+)별로 칸을 칠하고
// (요구사항 11), 꺼져 있으면 기존처럼 "미방문 칸만 빨갛게"(요구사항 9 이전 방식)를 유지한다.
//
// 예전엔 각 segment를 ~10m 간격으로 점을 찍어 "점이 지나간 칸"만 도로로 쳤다.
// 두 도로가 대각선으로 만나는 안쪽 쐐기는 어느 쪽 점도 정확히 지나가지 않아서
// 도로 칸으로 등록조차 안 됐다(대각선 교차부 삼각형 틈의 원인). 이제 칸 중심에서
// segment까지의 실제 최단거리를 재서 ROAD_HALF_WIDTH_M 반경 안이면 도로로 친다 —
// 두 segment가 실제로 만나거나 가까우면(끝점이 몇 m 어긋난 "사실상 같은 도로"
// 포함) 그 사이 칸은 항상 둘 중 하나의 반경 안에 들어오므로 쐐기 틈이 생길 수
// 없다. 관계없는 평행 도로는 2×ROAD_HALF_WIDTH_M보다 멀면 그대로 안 이어진다.
const ROAD_HALF_WIDTH_M=11;

function buildRoadCellSet(roadLines,latDeg,lngDeg,refLat){
  const cells=new Set();
  const {mLat,mLng}=mPerDegAt(refLat);
  const marginLatDeg=ROAD_HALF_WIDTH_M/mLat, marginLngDeg=ROAD_HALF_WIDTH_M/mLng;
  (roadLines||[]).forEach(line=>{
    for(let i=1;i<line.length;i++){
      const a=line[i-1], b=line[i];
      const minLat=Math.min(a[0],b[0])-marginLatDeg, maxLat=Math.max(a[0],b[0])+marginLatDeg;
      const minLng=Math.min(a[1],b[1])-marginLngDeg, maxLng=Math.max(a[1],b[1])+marginLngDeg;
      const laStart=Math.floor(minLat/latDeg), laEnd=Math.ceil(maxLat/latDeg);
      const loStart=Math.floor(minLng/lngDeg), loEnd=Math.ceil(maxLng/lngDeg);
      for(let la=laStart;la<=laEnd;la++){
        for(let lo=loStart;lo<=loEnd;lo++){
          const key=la+'_'+lo;
          if(cells.has(key)) continue;
          const cellLat=(la+0.5)*latDeg, cellLng=(lo+0.5)*lngDeg;
          if(distPointToSegmentM(cellLat,cellLng,a[0],a[1],b[0],b[1],refLat)<=ROAD_HALF_WIDTH_M){
            cells.add(key);
          }
        }
      }
    }
  });
  return cells;
}

function resetCoverageCellLayerCache(){
  coverageCellLayers=new Map();
}

function addCoverageCellLayer(key,layer){
  if(!key||!layer) return layer;
  coverageCellLayers.set(key,{layer,visible:true});
  return layer;
}

function setCoverageCellVisible(key,visible){
  const entry=coverageCellLayers.get(key);
  if(!entry||!coverageLayer) return;
  if(visible&& !entry.visible){
    entry.layer.addTo(coverageLayer);
    entry.visible=true;
  }else if(!visible&&entry.visible){
    coverageLayer.removeLayer(entry.layer);
    entry.visible=false;
  }
}

// ── 수동 셀 표시 ─────────────────────────────────────────────
// 확정 상태는 Coverage 계산 결과에 이미 반영돼 있다(제외 칸은 안 그려지고, 미방문
// 칸은 빨간색, 방문 칸은 빨갛지 않다). 디버그 보기에서만 확정 상태 외곽선을 따로 그린다.
// pending(아직 적용 안 한 선택)은 그 위에 미리보기로 겹쳐 그리고 밑의 Coverage 칸은
// 잠깐 숨긴다 — 선택을 지우면 원래대로 돌아온다. 이 과정에서 Coverage는 다시
// 계산하지 않는다.
const COMMITTED_MANUAL_STYLE={
  excluded:{color:'#dc2626',weight:2,dashArray:'4 3',fillColor:'#0a0e16',fillOpacity:.78},
  unvisited:{color:'#ff6b6b',weight:2,dashArray:'4 3',fillColor:'#ff6b6b',fillOpacity:.35},
  visited:{color:'#5fd88a',weight:2,dashArray:'4 3',fillColor:'#5fd88a',fillOpacity:.22},
};
const PENDING_PREVIEW_STYLE={
  exclude:{color:'#dc2626',weight:2,dashArray:'5 3',fillColor:'#0a0e16',fillOpacity:.6},
  visited:{color:'#16a34a',weight:2,dashArray:'5 3',fillColor:'#5fd88a',fillOpacity:.55},
  unvisited:{color:'#ff6b6b',weight:2,dashArray:'5 3',fillColor:'#ff6b6b',fillOpacity:.82},
  none:{color:'#94a3b8',weight:2,dashArray:'2 4',fillColor:'#94a3b8',fillOpacity:.15},
};
let pendingPreviewHiddenKeys=new Set();
let mapCaptureHidingPending=false; // 지도 캡처 중에는 적용 전 선택(pending) 미리보기를 빼고 그린다

function cellBounds(gy,gx,latDeg,lngDeg){
  return [[gy*latDeg,gx*lngDeg],[(gy+1)*latDeg,(gx+1)*lngDeg]];
}

function paintCommittedManualOverlay(zoneName){
  const grid=zoneGrid(zoneName);
  const cells=committedManualCellsByZone.get(zoneName);
  if(!grid||!cells||!manualCellsLayer) return;
  const n=normalizeManualCellsForGrid(cells,grid.latDeg,grid.lngDeg);
  MANUAL_LIST_PRIORITY.forEach(name=>{
    n[name].forEach(([lat,lng])=>{
      const gy=Math.floor(lat/grid.latDeg), gx=Math.floor(lng/grid.lngDeg);
      if(!pointInPolygon((gy+0.5)*grid.latDeg,(gx+0.5)*grid.lngDeg,grid.poly)) return;
      L.rectangle(cellBounds(gy,gx,grid.latDeg,grid.lngDeg),{...COMMITTED_MANUAL_STYLE[name],interactive:false})
        .addTo(manualCellsLayer).bringToFront();
    });
  });
}

function renderPendingManualPreview(){
  pendingPreviewHiddenKeys.forEach(k=>setCoverageCellVisible(k,true));
  pendingPreviewHiddenKeys=new Set();
  if(!manualCellsLayer) return;
  manualCellsLayer.clearLayers();
  if(!showCoverageGaps) return;
  if(showExclusionDebug) coverageZonesInView().forEach(paintCommittedManualOverlay);
  if(mapCaptureHidingPending) return; // 캡처에는 적용 완료된 상태만 — pending 칸 밑의 원래 칸도 위에서 되살렸다
  if(!pendingManualEditCount()) return;
  const grid=zoneGrid(accumZoneFilter);
  if(!grid) return;
  pendingManualEdits.forEach(edit=>{
    const gy=Math.floor(edit.lat/grid.latDeg), gx=Math.floor(edit.lng/grid.lngDeg);
    const key=gy+'_'+gx;
    setCoverageCellVisible(key,false);
    pendingPreviewHiddenKeys.add(key);
    L.rectangle(cellBounds(gy,gx,grid.latDeg,grid.lngDeg),{...PENDING_PREVIEW_STYLE[edit.targetState],interactive:false})
      .addTo(manualCellsLayer).bringToFront();
  });
}

// ── 인접 도로 자동 연결(Gap Healing) ─────────────────────────────────
// OSM에서 같은 도로가 여러 way로 쪼개지면서 끝점이 실제로 몇 m~수십 m
// 떨어져 있는 경우가 흔하다(편집 오차, 분리된 way 등). "OSM node가 실제로
// 연결돼 있어야 한다"는 엄격한 topology 조건은 쓰지 않는다 — 대신 서로
// 다른 두 도로의 끝점이 가깝고(거리) 방향이 합리적이면(둘 다 서로를 향해
// 뻗어나가는 모양 — T자/직교로 우연히 가까운 경우는 걸러진다) 그 사이를
// 잇는 가상의 segment(bridge)를 만든다. 이 bridge는 실제 도로 segment와
// 똑같이 buildRoadCellSet에 넣어 라스터화하므로, 별도의 polygon union/버퍼
// 로직이 필요 없다 — "도로 하나 더 있다고 치는" 것과 동일하게 처리된다.
// 교차로/대각선 접합부(끝점이 사실상 같은 지점)는 이미 ROAD_HALF_WIDTH_M
// 반경만으로 자연히 이어지므로 bridge가 필요 없다 — bridge는 그보다 먼
// "끊긴 것처럼 보이지만 사실 같은 도로" 구간만 대상으로 한다.
const ADJACENCY_FILL_ENABLED=true;
const BRIDGE_GAP_MAX_M=ROAD_HALF_WIDTH_M*3; // 이보다 멀면 관계없는 도로로 보고 안 잇는다(≈33m)
const BRIDGE_ANGLE_TOL_DEG=55; // 두 도로 끝의 "바깥쪽(끊긴 쪽)" 방향이 이 각도 이내로 서로를 향해야 연결

// 끝점에서 도로가 끊긴 방향(그대로 연장하면 향할 방향)의 단위벡터 — lat/lng 차이 그대로 반환(호출부에서 미터로 변환)
function lineEndpointTangentDeg(line,atStart){
  const a=atStart?line[0]:line[line.length-1];
  const b=atStart?line[1]:line[line.length-2];
  return [a[0]-b[0],a[1]-b[1]];
}

// forbiddenPolygons(아파트 단지·주차장)를 지나가는 bridge는 만들지 않는다 —
// "아파트/주차장 때문에 떨어져 있는 도로를 그 위로 잇지 말라"는 요구사항.
// bridge 위 몇 지점(1/3, 1/2, 2/3)만 검사하는 근사다: bridge 자체가 짧고
// (최대 33m) forbidden 영역은 보통 그보다 훨씬 커서 실용적으로 충분하다.
function bridgeCrossesForbidden(aLat,aLng,bLat,bLng,forbiddenPolygons){
  if(!forbiddenPolygons||!forbiddenPolygons.length) return false;
  return [0.25,0.5,0.75].some(t=>{
    const lat=aLat+(bLat-aLat)*t, lng=aLng+(bLng-aLng)*t;
    return forbiddenPolygons.some(poly=>pointInPolygon(lat,lng,poly));
  });
}

function findRoadBridges(roadLines,refLat,forbiddenPolygons){
  if(!ADJACENCY_FILL_ENABLED||!roadLines||roadLines.length<2) return [];
  const {mLat,mLng}=mPerDegAt(refLat);
  const toM=(dLat,dLng)=>[dLng*mLng,dLat*mLat];
  const norm=([x,y])=>{ const n=Math.hypot(x,y); return n>0?[x/n,y/n]:[0,0]; };

  const endpoints=[];
  roadLines.forEach((line,lineIdx)=>{
    if(line.length<2) return;
    [true,false].forEach(atStart=>{
      const pt=atStart?line[0]:line[line.length-1];
      endpoints.push({
        lineIdx, lat:pt[0], lng:pt[1],
        tangent:norm(toM(...lineEndpointTangentDeg(line,atStart))),
      });
    });
  });

  // 끝점을 공간 버킷에 넣어서, 후보를 근처 버킷만 비교한다(전체 O(n²) 방지)
  const bucketLatDeg=BRIDGE_GAP_MAX_M/mLat, bucketLngDeg=BRIDGE_GAP_MAX_M/mLng;
  const buckets=new Map();
  const bucketKey=(lat,lng)=>Math.floor(lat/bucketLatDeg)+'_'+Math.floor(lng/bucketLngDeg);
  endpoints.forEach((ep,idx)=>{
    const key=bucketKey(ep.lat,ep.lng);
    if(!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(idx);
  });

  const bridges=[];
  endpoints.forEach((epA,idxA)=>{
    const bLat=Math.floor(epA.lat/bucketLatDeg), bLng=Math.floor(epA.lng/bucketLngDeg);
    for(let dLa=-1;dLa<=1;dLa++){
      for(let dLo=-1;dLo<=1;dLo++){
        const cand=buckets.get((bLat+dLa)+'_'+(bLng+dLo));
        if(!cand) continue;
        for(const idxB of cand){
          if(idxB<=idxA) continue; // 각 쌍을 한 번만 처리
          const epB=endpoints[idxB];
          if(epB.lineIdx===epA.lineIdx) continue; // 같은 도로 자기 자신은 제외
          const [gx,gy]=toM(epB.lat-epA.lat,epB.lng-epA.lng);
          const gapM=Math.hypot(gx,gy);
          if(gapM>BRIDGE_GAP_MAX_M||gapM<=1e-6) continue;
          const dirAtoB=norm([gx,gy]);
          const angA=Math.acos(Math.max(-1,Math.min(1,epA.tangent[0]*dirAtoB[0]+epA.tangent[1]*dirAtoB[1])))*180/Math.PI;
          const angB=Math.acos(Math.max(-1,Math.min(1,epB.tangent[0]*(-dirAtoB[0])+epB.tangent[1]*(-dirAtoB[1]))))*180/Math.PI;
          if(angA<=BRIDGE_ANGLE_TOL_DEG&&angB<=BRIDGE_ANGLE_TOL_DEG
              &&!bridgeCrossesForbidden(epA.lat,epA.lng,epB.lat,epB.lng,forbiddenPolygons)){
            bridges.push([[epA.lat,epA.lng],[epB.lat,epB.lng]]);
          }
        }
      }
    }
  });
  return bridges;
}

// ══════════════════════════════════════════════════════════
//  Coverage 판정 철학 — "확실한 정상 도로만 칠한다"(whitelist), 아무 데나
//  칠하고 나쁜 곳을 나중에 지우는 게(blacklist) 아니다.
//
//  실제로는 두 whitelist의 AND다: (1) roadLines 자체가 이미 whitelist다
//  — fetchRoadsForBbox가 처음부터 motorway~residential 등 차량 주행도로
//  highway 태그만 받아온다(footway/cycleway/path/parking_aisle이 whitelist
//  에 없으니 애초에 안 들어옴). (2) 그렇게 whitelist로 뽑은 도로 중에서도
//  "차가 물리적으로 지나갈 수 있다"만으로는 안 되는 영역 — 아파트 단지,
//  주차장, 건물 — 은 태그와 무관하게 통째로 제외한다(같은 highway=service
//  라도 아파트 단지 안이면 무조건 제외, 밖이면 인정).
//    valid_road_coverage = road_cells ∩ ¬(apartment_mask ∪ parking_mask ∪ building_mask)
//  건물은 칸 경계 오차 정도만(2m) 버퍼. 아파트 단지는 명시적 경계(explicit,
//  5m 여유) 또는 hull 추정(15m 여유) 전체에 여유를 줘서, 동 사이 간격이
//  얼마든 상관없이 단지 안쪽이 통째로 빠진다. 주차장(amenity=parking)은
//  경계가 보통 정확히 그려져 있어 여유를 작게(3m) 준다.
//  road_cells는 딱 한 번만 만들고, 이 뒤로는(exclusion 단계에서도) 다시
//  채우거나 넓히지 않는다 — exclusion은 오직 뺄셈만 한다.
// ══════════════════════════════════════════════════════════
const BUILDING_BUFFER_M=2;
const PARKING_BUFFER_M=3;

// ══════════════════════════════════════════════════════════
//  Coverage 계산 — 구역 하나의 모든 도로 칸을 판정한다(지도 그리기와 분리).
//  결과는 순수 데이터라 캐시해서 다시 그리기(Depth/디버그 토글, 탭 복귀, 구역을
//  갔다가 돌아오기)에 그대로 재사용한다. 예전에는 지도 칠하기(paintZoneGapGrid)와
//  수치 계산(computeZoneCoverage)이 같은 판정을 매번 두 번씩 따로 했다.
//
//  cells[] 한 칸 = {key, la, lo, state, manualState, rawVisits, visits}
//   state: valid | manual_exclude | apartment | parking | building
//   visits: valid 칸의 최종 방문 횟수(수동 미방문/방문 반영, effectiveCellVisits)
// ══════════════════════════════════════════════════════════
// ── 날짜와 무관한 정적 Geometry ─────────────────────────────────────
// 구역 polygon 안의 주행 도로 칸(gap healing 포함)과 그 칸의 아파트/주차장/건물 제외
// 사유. 날짜·GPS 기록·수동 셀과 무관해서 날짜를 바꿔도 그대로 재사용한다
// (getZoneCoverageGeometry 캐시). 가장 비싼 계산이 여기에 몰려 있다.
async function buildZoneCoverageGeometry(zoneName){
  const grid=zoneGrid(zoneName);
  if(!grid) return null; // 경계 미설정
  const {poly,minLat,maxLat,minLng,maxLng,refLat,latDeg,lngDeg}=grid;
  const [buildings,roadLines]=await Promise.all([
    getZoneBuildingPolygons(zoneName),
    getZoneRoadPolylines(zoneName),
  ]);
  const complex=buildApartmentComplexPolygons(buildings.apartmentPolygons,buildings.explicitComplexPolygons,refLat);
  const allComplexPolygons=complex.explicit.concat(complex.hullEstimated);
  const buildingExcluded=buildExcludedCellSet(buildings.buildingPolygons,latDeg,lngDeg,refLat,BUILDING_BUFFER_M);
  const apartmentExcluded=buildExcludedCellSet(complex.explicit,latDeg,lngDeg,refLat,APARTMENT_EXPLICIT_BUFFER_M);
  buildExcludedCellSet(complex.hullEstimated,latDeg,lngDeg,refLat,APARTMENT_COMPLEX_BUFFER_M)
    .forEach(k=>apartmentExcluded.add(k));
  const parkingExcluded=buildExcludedCellSet(buildings.parkingPolygons,latDeg,lngDeg,refLat,PARKING_BUFFER_M);
  // 아파트/주차장 위로는 bridge(자동 도로 연결)를 안 만든다 — 그 사이를
  // 이어버리면 결국 아래 exclusion에서 다시 잘리긴 하지만, "왜 안 이어졌지"
  // 디버그가 혼란스러워지고, 순수하게 낭비 계산이라 아예 후보에서 뺀다.
  const forbiddenForBridging=allComplexPolygons.concat(buildings.parkingPolygons);
  const bridges=findRoadBridges(roadLines,refLat,forbiddenForBridging);
  // road_cells는 여기서 한 번만 만든다 — 이 뒤로는(아래 exclusion 단계에서도)
  // 다시 채우거나(gap healing) 넓히지(buffer) 않는다. exclusion은 오직 뺄셈만 한다.
  const roadCells=buildRoadCellSet(bridges.length?roadLines.concat(bridges):roadLines,latDeg,lngDeg,refLat);

  // 구역 경계 안의 도로 칸 + 정적 제외 사유(mask: apartment | parking | building | null)
  const cells=[];
  const latStart=Math.floor(minLat/latDeg), latEnd=Math.ceil(maxLat/latDeg);
  const lngStart=Math.floor(minLng/lngDeg), lngEnd=Math.ceil(maxLng/lngDeg);
  for(let la=latStart;la<=latEnd;la++){
    for(let lo=lngStart;lo<=lngEnd;lo++){
      const key=la+'_'+lo;
      if(!roadCells.has(key)) continue;
      if(!pointInPolygon((la+0.5)*latDeg,(lo+0.5)*lngDeg,poly)) continue;
      const mask=apartmentExcluded.has(key)?'apartment'
        :parkingExcluded.has(key)?'parking'
        :buildingExcluded.has(key)?'building'
        :null;
      cells.push({key,la,lo,mask});
    }
  }
  return {
    zone:zoneName,
    grid,
    cells,
    // 건물/도로 데이터를 못 받아 예전 캐시·빈 목록으로 대신 만든 임시 Geometry인지
    degraded:isZoneMapDataDegraded(zoneName),
    debug:{roadLines,buildings,complex,allComplexPolygons,roadCells,apartmentExcluded,parkingExcluded},
  };
}

// 정적 Geometry 캐시 — 키(coverageGeometryKey): 구역·경계 polygon 해시·Cell 크기·경계/지도
// 데이터 revision. 날짜·GPS 기록·수동 셀이 바뀌어도 그대로 쓴다.
async function getZoneCoverageGeometry(zoneName){
  const key=coverageGeometryKey(zoneName);
  const hit=coverageGeometryCache.get(key);
  if(hit){
    coverageStats.geometryHits++;
    coverageGeometryCache.delete(key); coverageGeometryCache.set(key,hit); // LRU
    return hit.geometry;
  }
  if(coverageGeometryInFlight.has(key)) return coverageGeometryInFlight.get(key);
  const promise=(async()=>{
    coverageStats.geometryBuilds++;
    const geometry=await buildZoneCoverageGeometry(zoneName);
    if(geometry&&coverageGeometryKey(zoneName)===key){
      coverageGeometryCache.set(key,{zone:zoneName,geometry});
      while(coverageGeometryCache.size>COVERAGE_GEOMETRY_CACHE_MAX) coverageGeometryCache.delete(coverageGeometryCache.keys().next().value);
    }
    return geometry;
  })();
  coverageGeometryInFlight.set(key,promise);
  try{ return await promise; }
  finally{ if(coverageGeometryInFlight.get(key)===promise) coverageGeometryInFlight.delete(key); }
}

// ── 날짜에 따라 달라지는 동적 부분 ─────────────────────────────────
// 정적 Geometry(캐시) 위에 선택 기간의 방문 집계(getCellVisitCounts — fromDate/toDate
// 조건 포함)와 수동 셀 상태를 얹어 칸마다 최종 판정·방문 횟수를 낸다.
async function computeZoneCoverageCells(zoneName){
  const grid=zoneGrid(zoneName);
  if(!grid) return null; // 경계 미설정
  const {minLat,maxLat,minLng,maxLng,refLat,latDeg,lngDeg,cellSizeM}=grid;
  const dateFilter=accumDateFilter();
  const [geometry,visitRows,manualCells]=await Promise.all([
    getZoneCoverageGeometry(zoneName),
    RouteDB.getCellVisitCounts({minLat,maxLat,minLng,maxLng,refLat,lngDeg,...dateFilter},cellSizeM),
    loadCommittedManualCells(zoneName),
  ]);
  if(!geometry) return null;
  const visitMap=new Map(visitRows.map(r=>[r.gy+'_'+r.gx,r.visits]));
  const manualStates=manualStateMap(manualCells,latDeg,lngDeg);
  const cells=geometry.cells.map(({key,la,lo,mask})=>{
    const manualState=manualStates.get(key)||null;
    // 사용자가 직접 뺀 칸이 최우선, 그다음 아파트/주차장/건물 forbidden mask
    const state=manualState==='exclude'?'manual_exclude':(mask||'valid');
    const rawVisits=visitMap.get(key)||0;
    return {key,la,lo,state,manualState,rawVisits,visits:state==='valid'?effectiveCellVisits(rawVisits,manualState):0};
  });
  return {
    zone:zoneName,
    grid:geometry.grid,
    cells,
    dateFrom:dateFilter.fromDate||'',
    dateTo:dateFilter.toDate||'',
    // 지도 데이터(건물/도로)를 못 받아 대체값으로 만든 Geometry였거나 수동 셀을 못 읽었으면
    // 임시 결과다 — 다음에 누적 지도에 들어올 때 버리고 다시 계산한다.
    cacheable:!geometry.degraded&&committedManualCellsByZone.has(zoneName),
    debug:geometry.debug,
  };
}

// 디버그 보기에서만 필요한 "bridge 없이도 도로였을 칸" — 정적 Geometry마다 한 번만 계산해 둔다.
function coverageDebugRawRoadCells(result){
  const debug=result.debug;
  if(!debug.rawRoadCells){
    const {latDeg,lngDeg,refLat}=result.grid;
    debug.rawRoadCells=buildRoadCellSet(debug.roadLines,latDeg,lngDeg,refLat);
  }
  return debug.rawRoadCells;
}

function paintCoverageDebugOverlays(result){
  const zoneName=result.zone;
  const {refLat}=result.grid;
  const {roadLines,buildings,complex,allComplexPolygons,roadCells,apartmentExcluded,parkingExcluded}=result.debug;
  const insideApartmentRoadCells=[...roadCells].filter(k=>apartmentExcluded.has(k));
  const insideParkingRoadCells=[...roadCells].filter(k=>parkingExcluded.has(k));
  console.log(`[ApartmentDebug] zone=${zoneName}`,{
    road_source: hdmapGlobalNamesFor(zoneName).length?'HD map ('+hdmapSourceLabel(zoneName)+')':'OSM/Overpass',
    road_lines: roadLines.length,
    apartment_buildings: buildings.apartmentPolygons.length,
    explicit_complex_polygon: complex.explicit.length>0,
    explicit_complex_count: complex.explicit.length,
    detected_cluster_count: complex.hullEstimated.length,
    complex_polygon_area_m2: Math.round(allComplexPolygons.reduce((s,p)=>s+polygonAreaM2(p,refLat),0)),
    parking_lots: buildings.parkingPolygons.length,
    internal_roads_found: roadLines.filter(line=>line.some(([lat,lng])=>allComplexPolygons.some(poly=>pointInPolygon(lat,lng,poly)))).length,
    coverage_before_exclusion_cells: roadCells.size,
    coverage_inside_apartment_before_cells: insideApartmentRoadCells.length,
    coverage_inside_parking_before_cells: insideParkingRoadCells.length,
    // apartment/parking/building 마스크에 걸린 칸은 state가 valid가 아니라
    // final coverage로는 절대 안 넘어간다 — 구조적으로 항상 0이어야 한다.
    coverage_inside_apartment_after_cells: 0,
    coverage_inside_parking_after_cells: 0,
  });

  // RED = 탐지된 단지 영역(실선=명시적 landuse 경계, 점선=hull 추정)
  complex.explicit.forEach(poly=>{
    L.polygon(poly,{color:'#ef4444',weight:2,fill:false,opacity:.95,interactive:false})
      .bindTooltip('REJECTED reason=inside_apartment (명시적 landuse=residential+residential=apartments)',{sticky:true}).addTo(coverageLayer);
  });
  complex.hullEstimated.forEach(hull=>{
    L.polygon(hull,{color:'#ef4444',weight:2,dashArray:'5 4',fill:false,opacity:.95,interactive:false})
      .bindTooltip('REJECTED reason=inside_apartment (hull 추정 — 명시적 경계 태그 없음)',{sticky:true}).addTo(coverageLayer);
  });
  // BROWN = 주차장(amenity=parking) 영역
  buildings.parkingPolygons.forEach(poly=>{
    L.polygon(poly,{color:'#b45309',weight:2,fill:true,fillColor:'#b45309',fillOpacity:.15,opacity:.9,interactive:false})
      .bindTooltip('REJECTED reason=parking (amenity=parking)',{sticky:true}).addTo(coverageLayer);
  });
  // BLUE = 아파트 동 개별 footprint
  buildings.apartmentPolygons.forEach(poly=>{
    L.polygon(poly,{color:'#3b82f6',weight:1,fill:false,opacity:.6,interactive:false}).addTo(coverageLayer);
  });
  // YELLOW = 단지 영역 안을 지나는 도로(내부도로/driveway/service 등, 태그 무관)
  roadLines.forEach(line=>{
    if(line.some(([lat,lng])=>allComplexPolygons.some(poly=>pointInPolygon(lat,lng,poly)))){
      L.polyline(line,{color:'#eab308',weight:2,opacity:.85,interactive:false})
        .bindTooltip('REJECTED reason=inside_apartment (내부도로/driveway/service — highway 태그와 무관)',{sticky:true}).addTo(coverageLayer);
    }
  });
}

// RED(직접 제외)/BLACK(아파트)/BROWN(주차장)/GRAY(건물) = 빠진 칸
const EXCLUDED_CELL_DEBUG_STYLE={
  manual_exclude:['#dc2626','manual_exclude'],
  apartment:['#111827','inside_apartment'],
  parking:['#b45309','parking'],
  building:['#64748b','inside_building'],
};

// 계산 결과 하나를 지도에 그린다 — 계산은 하지 않는다.
// showCoverageDepth 가 켜져 있으면 방문 횟수 등급(0/1/2~4/5+)별로 칸을 칠하고,
// 꺼져 있으면 "미방문 칸만 빨갛게"를 유지한다. 디버그 보기는 왜 빠졌는지 색으로 보여준다.
// 구역 경계선 — 계산(도로/건물 데이터 받기)을 기다리는 동안에도 먼저 보이게 따로 그린다
function paintZoneOutline(zone){
  const poly=ZONE_POLYGONS[zone];
  if(!coverageLayer||!poly||poly.length<3) return;
  const color=ZONE_COLORS[zone]||'#4fd8c7';
  L.polygon(poly,{color,weight:2,dashArray:'6 5',fill:false,opacity:.9})
    .bindTooltip(boundaryEditOpen?`${zone} 경계 클릭 — 꼭짓점 드래그로 모양 바꾸기`:`${zone} 운영 구역(직접 그린 경계)`,{sticky:true})
    .on('click',()=>toggleVertexEditMode(zone))
    .addTo(coverageLayer);
}

function paintCoverageResult(result){
  const {zone,grid,cells}=result;
  const {latDeg,lngDeg}=grid;
  paintZoneOutline(zone);
  if(showExclusionDebug) paintCoverageDebugOverlays(result);
  const rawRoadCells=showExclusionDebug?coverageDebugRawRoadCells(result):null;

  cells.forEach(c=>{
    const bounds=cellBounds(c.la,c.lo,latDeg,lngDeg);
    if(c.state!=='valid'){
      // 원래는 whitelist(도로)를 통과했지만 사용자가 직접 뺐거나 아파트/주차장/건물
      // mask에 걸린 칸 — 디버그 보기일 때만 이유를 색으로 보여주고 평소엔 안 그린다.
      if(showExclusionDebug){
        const [fill,reason]=EXCLUDED_CELL_DEBUG_STYLE[c.state];
        L.rectangle(bounds,{stroke:false,fillColor:fill,fillOpacity:.55,interactive:false})
          .bindTooltip(`REJECTED reason=${reason}`,{sticky:true}).addTo(coverageLayer);
      }
      return;
    }
    if(showExclusionDebug){
      if(rawRoadCells&&!rawRoadCells.has(c.key)){
        // GREEN = bridge가 없었으면 도로 칸이 아니었을, 자동으로 메워진 칸
        L.rectangle(bounds,{stroke:false,fillColor:'#22c55e',fillOpacity:.5,interactive:false})
          .bindTooltip('ACCEPTED — gap healing으로 자동 연결됨',{sticky:true}).addTo(coverageLayer);
      }else{
        // MAGENTA = whitelist 통과 + forbidden mask 없음 → 그대로 accepted
        L.rectangle(bounds,{stroke:false,fillColor:'#ec4899',fillOpacity:.42,interactive:false})
          .bindTooltip('ACCEPTED — 정상 주행도로',{sticky:true}).addTo(coverageLayer);
      }
      return;
    }
    if(showCoverageDepth){
      const tier=tierForCountJS(depthTiers,c.visits);
      addCoverageCellLayer(c.key,L.rectangle(bounds,{stroke:false,fillColor:tier.color,fillOpacity:.88,interactive:false}).addTo(coverageLayer));
    }else if(c.visits===0){
      addCoverageCellLayer(c.key,L.rectangle(bounds,{stroke:false,fillColor:'#ff6b6b',fillOpacity:.82,interactive:false}).addTo(coverageLayer));
    }
  });
}

// 이미 계산된 결과들로만 Coverage 레이어를 다시 그린다(동기 — 중간에 다른 렌더가 끼어들 틈이 없다).
function renderCachedCoverage(results){
  if(!coverageLayer) return;
  coverageLayer.clearLayers();
  resetCoverageCellLayerCache();
  pendingPreviewHiddenKeys=new Set();
  (results||[]).forEach(r=>{ if(r) paintCoverageResult(r); });
  renderPendingManualPreview();
}

// ══════════════════════════════════════════════════════════
//  Coverage % · Coverage Depth (요구사항 9~12)
//
//  "빨간 칸 = 미방문"만으로는 정량적으로 판단하기 어려워서, paintZoneGapGrid와
//  똑같은 격자·폴리곤 규칙으로 Coverage %와 등급별 칸 수를 계산해서 보여준다.
//  구역 polygon 밖의 칸은 계산에 포함하지 않는다(요구사항 9).
// ══════════════════════════════════════════════════════════
let showCoverageDepth=false;
const DEFAULT_DEPTH_TIERS_JS=[
  {threshold:0,label:'미수집',color:'#ff6b6b'},
  {threshold:1,label:'부족',color:'#f5a623'},
  {threshold:2,label:'보통',color:'#f5d90a'},
  {threshold:5,label:'충분',color:'#5fd88a'},
];
let depthTiers=DEFAULT_DEPTH_TIERS_JS;

async function refreshSettingsCache(){
  try{
    const s=await RouteDB.getSettings();
    depthTiers=(s.coverageDepthTiers&&s.coverageDepthTiers.length)?s.coverageDepthTiers:DEFAULT_DEPTH_TIERS_JS;
    // 교통 시간대·조도 분류 기준(달력·통계·재생 화면이 표시에 쓴다 — core.js currentClassificationConfig)
    if(typeof TimeConditions!=='undefined') window.classificationConfigCache=TimeConditions.classificationConfig(s);
  }catch(err){
    console.warn('[경로뷰어] 설정 불러오기 실패:',err);
    depthTiers=DEFAULT_DEPTH_TIERS_JS;
  }
  return depthTiers;
}

function tierForCountJS(tiers,count){
  const sorted=[...(tiers&&tiers.length?tiers:DEFAULT_DEPTH_TIERS_JS)].sort((a,b)=>a.threshold-b.threshold);
  let best=sorted[0];
  for(const t of sorted) if(count>=t.threshold) best=t;
  return best;
}

// 계산 결과 → Coverage %·Cell 수·등급별 분포. 등급 기준(depthTiers)만 바뀌면 이것만 다시 한다.
function summarizeCoverage(result,tiers){
  const sorted=[...(tiers&&tiers.length?tiers:DEFAULT_DEPTH_TIERS_JS)].sort((a,b)=>a.threshold-b.threshold);
  let total=0;
  const tierCounts={};
  result.cells.forEach(c=>{
    if(c.state!=='valid') return;
    total++;
    const tier=tierForCountJS(sorted,c.visits);
    tierCounts[tier.label]=(tierCounts[tier.label]||0)+1;
  });
  const zeroTier=sorted[0];
  const unvisited=zeroTier?(tierCounts[zeroTier.label]||0):0;
  const visited=total-unvisited;
  return { zone:result.zone, total, visited, unvisited, coveragePct: total?(visited/total*100):0, tierCounts };
}

// zoneName 하나의 Coverage — 전체 유효 Cell(폴리곤 안) / 방문 Cell / 등급별 분포 (캐시를 거친다)
async function computeZoneCoverage(zoneName){
  const result=await calculateCoverage(zoneName);
  return result?summarizeCoverage(result,depthTiers):null;
}

// ══════════════════════════════════════════════════════════
//  Coverage 캐시
//
//  탭을 왔다 갔다 하는 것만으로는 Coverage를 다시 계산하지도, 다시 그리지도 않는다.
//  계산 결과는 coverageCalcKey(zone)로 캐시한다 — 키에는 결과에 실제로 영향을 주는
//  값만 넣는다: 구역, 경계 polygon 해시, 날짜 필터, Cell 크기, 데이터 revision,
//  그 구역의 수동 셀/경계 revision, Coverage 설정 revision.
//
//  무효화(invalidateCoverage)는 이때만 한다.
//    · 주행기록 import / 날짜·전체 삭제 / 백업 복원 / 서버 동기화 → 모든 구역
//      (RouteDB.onChange 알림 또는 sync.js의 notifyChange('sync'))
//    · 수동 셀 "선택 적용" / 경계 추가·수정·삭제 → 그 구역만
//    · Coverage 설정 변경 → 모든 구역
//  선택 구역·날짜 필터·경계 모양은 키 자체에 들어가 있어서, 바뀌면 자연히 새로 계산된다.
//  (지도 판정 데이터 — 건물/도로 — 를 못 받아와 대체값으로 계산한 결과는 "임시"다. 같은 화면
//   안의 다시 그리기에는 쓰지만, 다음에 누적 지도 탭에 들어올 때 버리고 다시 받아서 계산한다)
// ══════════════════════════════════════════════════════════
let accumViewInitialized=false; // 누적 지도를 한 번이라도 끝까지 그렸는지
let coverageDirty=true;         // 지금 지도에 그려진 게 최신 상태가 아닐 수 있음
let coverageCacheKey=null;      // 지금 지도에 그려진 화면의 키(accumViewKey)
const coverageCache=new Map();  // coverageCalcKey → {zone, result}  (LRU)
const coverageInFlight=new Map(); // coverageCalcKey → 진행 중 계산 Promise (같은 계산을 두 번 안 돌림)
const COVERAGE_CACHE_MAX=8;
// 정적 Geometry(도로 칸·건물/아파트/주차장 제외·gap healing)는 날짜와 무관해서 따로 캐시한다 —
// 날짜를 바꾸면 위의 동적 결과만 새로 계산하고 Geometry는 재사용한다.
const coverageGeometryCache=new Map();     // coverageGeometryKey → {zone, geometry}  (LRU)
const coverageGeometryInFlight=new Map();
const COVERAGE_GEOMETRY_CACHE_MAX=6;
const coverageGeometryRevisions={};        // 구역 → 경계/지도 데이터 revision
let coverageDataRevision=0;
let coverageSettingsRevision=0;
const coverageZoneRevisions={};
const coverageStats={calculations:0,cacheHits:0,renders:0,reuses:0,geometryBuilds:0,geometryHits:0};
let lastCoverageInvalidation=null;

function coverageCellSizeM(){ return GAP_CELL_SIZE_M; }

function hashString(s){
  let h=0x811c9dc5;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193); }
  return (h>>>0).toString(36);
}

function polygonRevision(poly){
  if(!poly||poly.length<3) return 'none';
  return poly.length+':'+hashString(poly.map(([la,lo])=>Number(la).toFixed(7)+','+Number(lo).toFixed(7)).join(';'));
}

function depthTierSignature(){
  return JSON.stringify((depthTiers||[]).map(t=>[t.threshold,t.label,t.color]));
}

// 동적(날짜별) Coverage 결과 키 — 정규화된 날짜 범위가 들어 있어서 "전체 기간"과
// "2026-09-01 ~ 2026-09-05"는 서로 다른 캐시다.
function coverageCalcKey(zoneName){
  return JSON.stringify({
    zone:zoneName,
    dateFrom:normalizeAccumDate(accumDateFrom),
    dateTo:normalizeAccumDate(accumDateTo),
    polygonRevision:polygonRevision(ZONE_POLYGONS[zoneName]),
    dataRevision:coverageDataRevision,
    manualOverrideRevision:coverageZoneRevisions[zoneName]||0,
    cellSizeM:coverageCellSizeM(),
    coverageSettingsRevision,
    // 데이터 상태 필터가 다르면 방문한 칸도 달라진다 — 키에 넣지 않으면 "이슈만" 화면에
    // 전체 데이터로 계산한 Coverage 가 그대로 남는다
    issueFilter:currentIssueFilter(),
  });
}

// 정적 Geometry 키 — 날짜·GPS 기록·수동 셀과 무관하다
function coverageGeometryKey(zoneName){
  return JSON.stringify({
    zone:zoneName,
    polygonRevision:polygonRevision(ZONE_POLYGONS[zoneName]),
    geometryRevision:coverageGeometryRevisions[zoneName]||0,
    cellSizeM:coverageCellSizeM(),
  });
}

function coverageZonesInView(){
  const zones=accumZoneFilter==='all'?ACTIVE_ZONE_NAMES:[accumZoneFilter];
  return zones.filter(z=>ZONE_POLYGONS[z]&&ZONE_POLYGONS[z].length>=3);
}

// 지금 누적 지도에 "무엇이 그려져 있어야 하는지"를 나타내는 키
function accumViewKey(){
  const base=[showCoverageGaps?'coverage':'density',accumZoneFilter,accumDateFrom,accumDateTo,coverageDataRevision,ACTIVE_ZONE_NAMES.join('|'),currentIssueFilter()];
  if(!showCoverageGaps) return JSON.stringify(base);
  return JSON.stringify(base.concat([showCoverageDepth,showExclusionDebug,depthTierSignature(),coverageZonesInView().map(coverageCalcKey)]));
}

// reason: import/delete/restore/sync/manual-cells/boundary/map-data/settings ...
// zone을 주면 그 구역만, 안 주면 모든 구역을 무효화한다.
function invalidateCoverage(reason,zone){
  lastCoverageInvalidation={reason:reason||'unknown',zone:zone||null};
  if(zone) coverageZoneRevisions[zone]=(coverageZoneRevisions[zone]||0)+1;
  else if(reason==='settings') coverageSettingsRevision++;
  else coverageDataRevision++;
  for(const [key,entry] of coverageCache){
    if(!zone||entry.zone===zone) coverageCache.delete(key);
  }
  // 경계 모양·지도 판정 데이터가 바뀐 경우에만 정적 Geometry도 버린다 — import/삭제/복원/
  // 동기화/수동 셀/날짜 변경은 방문 집계만 바뀌므로 Geometry는 그대로 재사용한다.
  if(zone&&(reason==='boundary'||reason==='map-data')){
    coverageGeometryRevisions[zone]=(coverageGeometryRevisions[zone]||0)+1;
    for(const [key,entry] of coverageGeometryCache){
      if(entry.zone===zone) coverageGeometryCache.delete(key);
    }
  }
  coverageDirty=true;
}

// 대체값으로 계산한 임시 결과를 버린다 — 누적 지도 탭에 다시 들어와서 새로 그릴 때 부른다
function dropProvisionalCoverage(){
  for(const [key,entry] of coverageCache){
    if(entry.result&&!entry.result.cacheable) coverageCache.delete(key);
  }
  for(const [key,entry] of coverageGeometryCache){
    if(entry.geometry&&entry.geometry.degraded) coverageGeometryCache.delete(key);
  }
}

// 구역 하나의 Coverage 계산 결과 — 캐시에 있으면 그대로, 같은 계산이 진행 중이면 그 Promise를 돌려준다.
async function calculateCoverage(zoneName){
  const key=coverageCalcKey(zoneName);
  const hit=coverageCache.get(key);
  if(hit){
    coverageStats.cacheHits++;
    coverageCache.delete(key); coverageCache.set(key,hit); // LRU: 최근 사용으로
    return hit.result;
  }
  if(coverageInFlight.has(key)) return coverageInFlight.get(key);
  const promise=(async()=>{
    coverageStats.calculations++;
    const result=await computeZoneCoverageCells(zoneName);
    // cacheable=false 인 임시 결과도 넣어 둔다 — Depth/디버그 토글 같은 다시 그리기가 매번
    // 지도 데이터를 다시 받지 않게. 탭으로 다시 들어올 때 dropProvisionalCoverage()가 버린다.
    if(result&&coverageCalcKey(zoneName)===key){
      coverageCache.set(key,{zone:zoneName,result});
      while(coverageCache.size>COVERAGE_CACHE_MAX) coverageCache.delete(coverageCache.keys().next().value);
      saveCoverageSnapshotFor(zoneName,result);
    }
    return result;
  })();
  coverageInFlight.set(key,promise);
  try{ return await promise; }
  finally{ if(coverageInFlight.get(key)===promise) coverageInFlight.delete(key); }
}

// 추천 주행(recommend-view.js)이 쓰는 구역별 Coverage 요약을 저장한다. 전체 기간으로 계산한 결과만 —
// 날짜 필터가 걸린 계산은 그 구역의 전체 Coverage 가 아니다. 도로·건물 데이터나 수동 셀을 못 읽은 임시
// 결과(cacheable=false)는 provisional 로 표시해서 저장한다(추천 신뢰도에서 낮춤).
// 저장소가 저장 시점의 데이터·경계·수동 셀 지문을 같이 적어서, 그 뒤 무엇이 바뀌면 추천에서 "오래됨"으로 뺀다.
function saveCoverageSnapshotFor(zoneName,result){
  if(!result||result.dateFrom||result.dateTo||!Array.isArray(result.cells)) return;
  if(typeof RouteDB==='undefined'||typeof RouteDB.saveCoverageSnapshot!=='function') return;
  let total=0,visited=0;
  result.cells.forEach(c=>{ if(c.state!=='valid') return; total++; if(c.visits>0) visited++; });
  // 어떤 데이터 상태 필터로 계산한 Coverage 인지도 남긴다 — 추천 화면이 자기 기준과 다르면 그렇게 밝힌다
  Promise.resolve(RouteDB.saveCoverageSnapshot(zoneName,{total,visited,provisional:!result.cacheable,cellSizeM:coverageCellSizeM(),issueFilter:currentIssueFilter(),computedAt:new Date().toISOString()}))
    .catch(err=>console.warn('[경로뷰어] Coverage 스냅샷 저장 실패:',err));
}

// 저장소에서 데이터가 바뀌었다는 알림(storage.js RouteDB.onChange) → 해당 캐시 무효화
function onRouteDataChanged(evt){
  const method=evt&&evt.method;
  const args=(evt&&evt.args)||[];
  if(method==='importRecords'||method==='deleteDate'||method==='deleteAll'){
    invalidateCoverage(method);
  }else if(method==='updateImportIssue'||method==='restoreImports'){
    // 이슈 상태가 바뀌면 같은 기록이라도 데이터 상태 필터에 걸리고 안 걸리고가 달라진다
    invalidateCoverage('issue');
  }else if(method==='restoreBackupPayload'||method==='sync'){
    committedManualCellsByZone.clear(); // 백업/서버에서 수동 셀이 병합됐을 수 있다
    invalidateCoverage(method==='sync'?'sync':'restore');
  }else if(method==='saveZoneManualCells'){
    committedManualCellsByZone.delete(args[0]);
    invalidateCoverage('manual-cells',args[0]);
  }else if(method==='setSettings'){
    // 교통 시간대·일출/일몰 범위만 바꾼 저장은 Coverage 와 무관하다 — 무거운 재계산을 일으키지 않는다
    if(!(typeof TimeConditions!=='undefined'&&TimeConditions.isClassificationOnlyPatch(args[0]))) invalidateCoverage('settings');
  }
  // saveZonePolygons/saveZone/setZoneActive 는 따로 무효화하지 않는다 — 경계 모양(polygon
  // 해시)과 활성 구역 목록이 이미 캐시 키/화면 키에 들어 있어서 바뀐 구역만 새로 계산된다.
}
if(typeof RouteDB!=='undefined'&&RouteDB&&typeof RouteDB.onChange==='function') RouteDB.onChange(onRouteDataChanged);

// 선택된 지역 하나의 상세 Coverage % + Cell 수 + Depth 분포(요구사항 9, 11)
// results: renderCoverageGapLayer가 이미 계산해 둔 결과 — 여기서는 다시 계산하지 않는다.
function renderCoverageDetailPanel(results){
  const el=document.getElementById('coverage-detail');
  if(!el) return;
  if(!showCoverageGaps||accumZoneFilter==='all'){ el.style.display='none'; el.innerHTML=''; return; }
  const result=(results||[]).find(r=>r&&r.zone===accumZoneFilter);
  const cov=result?summarizeCoverage(result,depthTiers):null;
  if(!cov){
    el.style.display='flex';
    el.innerHTML=`<div class="cov-detail-empty">${escapeHtml(accumZoneFilter)} 구역은 아직 경계가 설정되지 않았어요. 위 "경계 그리기"로 먼저 그려보세요.</div>`;
    return;
  }
  el.style.display='flex';
  if(!cov.total){
    const emptyMsg=hdmapGlobalNamesFor(accumZoneFilter).length
      ? `${escapeHtml(accumZoneFilter)} 구역의 HD map 도로 데이터를 못 불러왔어요. index.html에 data/hdmap_gangnam_roads.js / data/hdmap_seocho_roads.js가 &lt;script&gt;로 로드돼 있는지, 콘솔(개발자 도구)에서 [경로뷰어] HD map 관련 로그를 확인해주세요.`
      : `${escapeHtml(accumZoneFilter)} 구역 안의 주행 가능 도로 데이터를 아직 가져오지 못했어요. 인터넷 연결 후 다시 열면 API 키 없이 OSM 도로 데이터를 받아와 계산해요.`;
    el.innerHTML=`<div class="cov-detail-empty">${emptyMsg}</div>`;
    return;
  }
  const pct=cov.coveragePct.toFixed(1);
  const color=ZONE_COLORS[accumZoneFilter]||'#4fd8c7';
  const tierRows=[...depthTiers].sort((a,b)=>a.threshold-b.threshold).map(t=>{
    const n=cov.tierCounts[t.label]||0;
    const barPct=cov.total?Math.round(n/cov.total*100):0;
    return `<div class="depth-row">
        <span class="depth-swatch" style="background:${escapeHtml(t.color)}"></span>
        <span class="depth-label">${escapeHtml(t.label)}</span>
        <span class="depth-bar-wrap"><span class="depth-bar" style="width:${barPct}%;background:${escapeHtml(t.color)};"></span></span>
        <span class="depth-count mono">${fmtNum(n)}칸</span>
      </div>`;
  }).join('');
  el.innerHTML=`
    <div class="cov-detail-head">
      <div class="cov-detail-title">${escapeHtml(accumZoneFilter)} Coverage</div>
      <div class="cov-detail-pct mono">${pct}%</div>
    </div>
    <div class="cov-bar-wrap"><div class="cov-bar" style="width:${Math.min(100,cov.coveragePct)}%;background:${escapeHtml(color)};"></div></div>
    <div class="cov-detail-nums mono">
      <span>전체 Cell <b>${fmtNum(cov.total)}</b></span>
      <span>방문 Cell <b>${fmtNum(cov.visited)}</b></span>
      <span>미방문 Cell <b>${fmtNum(cov.unvisited)}</b></span>
    </div>
    <button type="button" class="btn ghost cov-depth-btn${showCoverageDepth?' active':''}" onclick="toggleCoverageDepth()">
      ${showCoverageDepth?'Depth 숨기기':'Coverage Depth 보기'}
    </button>
    ${showCoverageDepth?`<div class="depth-list">${tierRows}</div>`:''}
  `;
}

function toggleCoverageDepth(){
  if(!showCoverageGaps) return;
  showCoverageDepth=!showCoverageDepth;
  renderAccumView();
}

// 커버리지 갭 계산(도로/건물 데이터 fetch)이 얼마나 걸릴지 알 수 없어서,
// 화면이 멈춘 것처럼 보이지 않게 양이 지나가는 로딩 표시를 띄운다.
function showCoverageLoading(){
  const el=document.getElementById('coverage-loading');
  if(el) el.classList.add('show');
}
function hideCoverageLoading(){
  const el=document.getElementById('coverage-loading');
  if(el) el.classList.remove('show');
}

function hideCoveragePanels(){
  const b=document.getElementById('coverage-detail');
  if(b){ b.style.display='none'; b.innerHTML=''; }
}


// 구역 필터(전체/강남/판교/시흥) 전환
let accumZoneFilter='all';
let accumCells=[]; // renderAccumView가 만든 격자 셀 목록 — 원 그리기와 호버 툴팁이 "같은" 이 데이터를 공유한다

// 현재 구역 필터를 DB 조회 조건으로
function accumFilter(){
  const filter=accumZoneFilter==='all' ? {} : {zone:accumZoneFilter};
  if(accumDateFrom) filter.fromDate=accumDateFrom;
  if(accumDateTo) filter.toDate=accumDateTo;
  if(issueFilterActive()) filter.issueFilter=currentIssueFilter();
  return filter;
}

// Coverage 방문 집계용 — 구역은 폴리곤으로 따로 자르므로 날짜와 데이터 상태만 넘긴다
function accumDateFilter(){
  const filter={};
  if(accumDateFrom) filter.fromDate=accumDateFrom;
  if(accumDateTo) filter.toDate=accumDateTo;
  if(issueFilterActive()) filter.issueFilter=currentIssueFilter();
  return filter;
}

// ══════════════════════════════════════════════════════════
//  누적 지도 날짜 필터
//   날짜칸 change / "날짜 적용" 버튼 / Enter → applyAccumDateInputs → setAccumDateRange
//   → accumDateFrom/To → accumFilter()(밀도 지도·통계·지도 범위) · accumDateFilter()(Coverage
//   방문 집계) → RouteDB 조회 조건 fromDate/toDate(양 끝 포함, 'YYYY-MM-DD' 날짜만)
//   → coverageCalcKey(정규화된 날짜 포함) → renderAccumView(token으로 늦은 결과 차단)
// ══════════════════════════════════════════════════════════

// 'YYYY-MM-DD'이면서 실제로 있는 날짜만 받는다 — 그 외는 ''(= 그쪽 끝 제한 없음)
function normalizeAccumDate(value){
  const s=String(value||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y,m,d]=s.split('-').map(Number);
  const dt=new Date(Date.UTC(y,m-1,d));
  return (dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d)?s:'';
}

function describeAccumDateRange(from,to){
  if(from&&to) return from===to?from:`${from} ~ ${to}`;
  if(from) return `${from} ~ (최신)`;
  if(to) return `(처음) ~ ${to}`;
  return '전체 기간';
}

function setAccumDateNotice(text){
  const el=document.getElementById('accum-date-notice');
  if(!el) return;
  el.textContent=text||'';
  el.style.display=text?'inline':'none';
}

function isDateInputPartial(el){
  return !!(el&&el.validity&&el.validity.badInput);
}

function updateAccumDateFilterUI(){
  const fromEl=document.getElementById('accum-date-from');
  const toEl=document.getElementById('accum-date-to');
  // 덜 입력 중인 칸(badInput)이나 지금 입력 중인(포커스) 칸은 덮어쓰지 않는다 — 값을 다시
  // 넣으면 날짜칸의 입력 위치가 초기화돼서 이어 치던 숫자가 엉뚱한 칸으로 간다
  const keep=el=>!el||isDateInputPartial(el)||document.activeElement===el;
  if(!keep(fromEl)&&fromEl.value!==accumDateFrom) fromEl.value=accumDateFrom;
  if(!keep(toEl)&&toEl.value!==accumDateTo) toEl.value=accumDateTo;
  const label=document.getElementById('accum-date-label');
  if(label) label.textContent=`표시 기간: ${describeAccumDateRange(accumDateFrom,accumDateTo)}`;
}

// 날짜 범위를 바꾼다. 정규화한 범위가 지금과 같으면 다시 계산하지 않고 false를 돌려준다.
// 범위가 바뀌면 날짜가 Coverage 캐시 키에 들어 있어서 새 범위로 새로 계산되고(정적 Geometry는
// 재사용), 이전 범위로 진행 중이던 렌더는 accumRenderToken으로 버려진다.
function setAccumDateRange(from,to){
  cancelAccumDateInputTimer(); // 기다리던 날짜칸 자동 적용은 이 호출로 대신한다
  let nextFrom=normalizeAccumDate(from);
  let nextTo=normalizeAccumDate(to);
  let swapped=false;
  if(nextFrom&&nextTo&&nextFrom>nextTo){ [nextFrom,nextTo]=[nextTo,nextFrom]; swapped=true; }
  setAccumDateNotice(swapped?'시작일이 종료일보다 늦어서 서로 바꿔 적용했어요.':'');
  if(nextFrom===accumDateFrom&&nextTo===accumDateTo){
    updateAccumDateFilterUI();
    return false;
  }
  accumDateFrom=nextFrom;
  accumDateTo=nextTo;
  updateAccumDateFilterUI();
  renderAccumView();
  return true;
}

// 날짜칸 change는 입력 도중에도 여러 번 온다(예: 24일을 치면 "2"를 친 순간 2일로) —
// 그때마다 다시 계산하면 계산하는 동안 이어 치던 숫자가 엉뚱하게 들어간다. 마지막 변경 뒤
// 잠깐 기다렸다가 한 번만 적용한다. Enter·"날짜 적용" 버튼은 바로 적용한다.
const ACCUM_DATE_INPUT_DEBOUNCE_MS=600;
let accumDateInputTimer=null;

function cancelAccumDateInputTimer(){
  if(accumDateInputTimer){ clearTimeout(accumDateInputTimer); accumDateInputTimer=null; }
}

function scheduleAccumDateInputApply(){
  cancelAccumDateInputTimer();
  accumDateInputTimer=setTimeout(()=>{ accumDateInputTimer=null; applyAccumDateInputs('debounce'); },ACCUM_DATE_INPUT_DEBOUNCE_MS);
}

// 날짜칸 두 개의 지금 값을 읽어 적용한다. 덜 입력된 칸(예: 연도만 입력)은 적용하지 않고
// 지금 적용된 값을 유지한다 — 버튼/Enter로 적용했을 때는 안내하고, 자동 적용(debounce)
// 때 그 칸을 아직 입력 중(포커스)이면 안내하지 않는다.
function applyAccumDateInputs(trigger){
  cancelAccumDateInputTimer();
  const fromEl=document.getElementById('accum-date-from');
  const toEl=document.getElementById('accum-date-to');
  const partialEls=[fromEl,toEl].filter(isDateInputPartial);
  const from=fromEl&&!isDateInputPartial(fromEl)?fromEl.value:accumDateFrom;
  const to=toEl&&!isDateInputPartial(toEl)?toEl.value:accumDateTo;
  const changed=setAccumDateRange(from,to);
  const stillTyping=trigger==='debounce'&&partialEls.some(el=>document.activeElement===el);
  if(partialEls.length&&!stillTyping) setAccumDateNotice('날짜를 연·월·일까지 끝까지 입력해 주세요(예: 2026-09-01). 덜 입력된 칸은 적용하지 않았어요.');
  return changed;
}

function onAccumDateInputChange(){
  scheduleAccumDateInputApply();
}

// Enter → 바로 적용. 그 밖의 키를 치는 동안에는(다른 날짜칸으로 넘어가 치는 중 포함) 자동 적용을 미룬다.
function onAccumDateInputKeydown(event){
  if(event&&event.key==='Enter'){ applyAccumDateInputs('enter'); return; }
  if(accumDateInputTimer) scheduleAccumDateInputApply();
}

function clearAccumDateFilter(){
  ['accum-date-from','accum-date-to'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  return setAccumDateRange('','');
}

function setAccumLastMonth(){
  const now=new Date();
  const first=new Date(now.getFullYear(),now.getMonth()-1,1);
  const last=new Date(now.getFullYear(),now.getMonth(),0);
  return setAccumDateRange(dstr(first),dstr(last));
}

// ══════════════════════════════════════════════════════════
//  📷 현재 지도 캡처
//
//  · 데스크톱 앱: Electron 메인 프로세스가 webContents.capturePage(지도 영역)로 화면에
//    실제 그려진 픽셀을 찍는다. 화면(renderer)은 지도 영역 좌표와 기본 파일명만 넘기고,
//    저장 위치 선택·파일 쓰기는 메인 프로세스가 한다(preload의 captureMap 하나만 노출).
//  · 브라우저 모드: 지도 DOM의 배경 타일 <img>(CORS로 받음)와 Leaflet Canvas Layer
//    (preferCanvas라 칸·원·경계선이 모두 여기 있다)를 쌓임 순서대로 캔버스에 합성해 PNG로
//    만든다. 저장은 파일 저장 창(showSaveFilePicker)을 지원하면 그걸로, 아니면 다운로드로.
//
//  캡처에는 "적용 완료된" 현재 지도만 들어간다. 적용 전 선택(pending) 미리보기, 확대/축소
//  버튼, 로딩 표시, 호버 툴팁, 꼭짓점 핸들은 잠깐 숨기고 finally에서 반드시 되돌린다.
//  지도를 그리는 중(날짜 변경 직후 포함)에는 버튼이 비활성이라 이전 지도를 찍지 않는다.
// ══════════════════════════════════════════════════════════
let accumRendering=false;
let mapCaptureInFlight=false;
const MAP_CAPTURE_HIDE_SELECTOR='#accum-map .leaflet-control-zoom, #accum-tooltip, #coverage-loading, #accum-map .vertex-handle';
const MAP_CAPTURE_TILE_WAIT_MS=8000;

// 'desktop' = Electron capturePage(IPC) · 'browser' = 화면에서 캔버스 합성 · null = 이 환경은 불가
function mapCaptureMode(){
  if(window.routeAPI&&window.routeAPI.isDesktop&&typeof window.routeAPI.captureMap==='function') return 'desktop';
  try{
    const c=document.createElement('canvas');
    if(c&&typeof c.getContext==='function'&&typeof c.toBlob==='function') return 'browser';
  }catch(_){ /* 캔버스를 만들 수 없는 환경 */ }
  return null;
}

function mapCaptureSupported(){
  return !!mapCaptureMode();
}

// 최신 상태로 다 그려져 있어서 지금 찍어도 되는지
// (이미 버려진 이전 날짜의 계산이 뒤에서 아직 돌고 있어도, 최신 렌더가 끝났으면 찍을 수 있다)
function isAccumMapSettled(){
  return !!accumMap&&accumViewInitialized&&!accumRendering&&!boundaryDrawMode
    &&coverageCacheKey===accumViewKey();
}

function updateCaptureButton(){
  const btn=document.getElementById('accum-capture-btn');
  if(!btn) return;
  const supported=mapCaptureSupported();
  const ready=isAccumMapSettled();
  btn.disabled=!supported||!ready||mapCaptureInFlight;
  btn.textContent=mapCaptureInFlight?'📷 캡처 중…':'📷 현재 지도 캡처';
  btn.title=!supported?'이 환경에서는 지도 캡처를 지원하지 않아요(캔버스 PNG 저장 불가)'
    :mapCaptureInFlight?'캡처하는 중이에요'
    :!ready?'지도 계산이 끝나면 캡처할 수 있어요'
    :'지금 보이는 누적 지도를 PNG로 저장';
}

function accumMapModeLabel(){
  return showCoverageGaps?(showCoverageDepth?'CoverageDepth':'Coverage'):'Density';
}

function buildMapCaptureFileName(now){
  return MapCapture.buildCaptureFileName({
    zone:accumZoneFilter==='all'?'전체구역':accumZoneFilter,
    dateFrom:accumDateFrom,
    dateTo:accumDateTo,
    mode:accumMapModeLabel(),
  },now||new Date());
}

// 지도 DOM의 화면 좌표(CSS px) — 메인 프로세스가 페이지 확대 배율을 반영해 DIP로 바꾼다
function mapCaptureRect(){
  const r=document.getElementById('accum-map').getBoundingClientRect();
  return {x:r.left,y:r.top,width:r.width,height:r.height};
}

const waitMs=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const nextPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));

// 줌/이동 애니메이션과 배경 타일 로딩이 끝날 때까지(최대 timeoutMs) 기다린다
async function waitForAccumMapIdle(timeoutMs){
  const t0=Date.now();
  const busy=()=>({
    animating:!!(accumMap&&(accumMap._animatingZoom||(accumMap._panAnim&&accumMap._panAnim._inProgress))),
    tilesLoading:!!(accumTileLayer&&typeof accumTileLayer.isLoading==='function'&&accumTileLayer.isLoading()),
  });
  let state=busy();
  while((state.animating||state.tilesLoading)&&Date.now()-t0<timeoutMs){
    await waitMs(100);
    state=busy();
  }
  return {tilesLoaded:!state.tilesLoading,animating:state.animating};
}

// 캡처 동안 숨길 화면 요소들을 숨기고, 되돌리는 함수 목록을 돌려준다
function hideUiForMapCapture(){
  const restores=[];
  hideAccumTooltip();
  mapCaptureHidingPending=true;
  renderPendingManualPreview();
  restores.push(()=>{ mapCaptureHidingPending=false; renderPendingManualPreview(); });
  document.querySelectorAll(MAP_CAPTURE_HIDE_SELECTOR).forEach(el=>{
    const prev=el.style.visibility;
    el.style.visibility='hidden';
    restores.push(()=>{ el.style.visibility=prev; });
  });
  return restores;
}

// capturePage는 창에 실제로 보이는 픽셀만 찍는다 — 지도가 스크롤 아래로 걸쳐 있으면 캡처
// 동안 지도를 화면 안으로 스크롤하고, 끝나면 원래 스크롤 위치로 되돌린다.
function scrollMapIntoViewForCapture(){
  const mapEl=document.getElementById('accum-map');
  if(!mapEl||typeof mapEl.scrollIntoView!=='function') return [];
  const saved=[];
  for(let el=mapEl.parentElement;el;el=el.parentElement) saved.push([el,el.scrollTop,el.scrollLeft]);
  const root=document.scrollingElement;
  if(root&&!saved.some(([el])=>el===root)) saved.push([root,root.scrollTop,root.scrollLeft]);
  mapEl.scrollIntoView({block:'nearest',inline:'nearest'});
  return [()=>saved.forEach(([el,top,left])=>{ el.scrollTop=top; el.scrollLeft=left; })];
}

// 지도가 창보다 커서 스크롤해도 다 안 보이면 true — 보이는 부분만 저장된다
function mapRectClipped(rect){
  const vw=window.innerWidth, vh=window.innerHeight;
  if(!(vw>0&&vh>0)) return false;
  return rect.x<0||rect.y<0||rect.x+rect.width>vw+1||rect.y+rect.height>vh+1;
}

// ── 브라우저 모드 캡처(캔버스 합성) ─────────────────────────────────
// 지도 DOM에서 그릴 것을 화면 쌓임 순서대로 모은다(좌표는 지도 왼쪽 위 기준 CSS px).
//  1) 배경 타일: 줌 단계별 타일 묶음(.leaflet-tile-container)을 z-index 오름차순으로. Leaflet은 줌을
//     바꾼 뒤에도 이전 단계 타일을 잠시 남겨 두는데(확대된 채 z-index가 더 낮음), 문서 순서대로 그리면
//     그 흐릿하게 확대된 타일이 지금 타일 위에 겹친다. 타일마다의 페이드인 투명도는 쓰지 않고(로딩이
//     끝난 타일만 그림) 타일 묶음·지도 창의 투명도만 쓴다.
//  2) Leaflet Canvas Layer(<canvas>) — 칸·원·경계선, 문서 순서대로 타일 위에.
// 호버 툴팁·확대/축소 버튼·꼭짓점 핸들 같은 DOM 요소는 애초에 그리지 않는다.
function collectMapDrawItems(mapEl){
  const base=mapEl.getBoundingClientRect();
  const right=base.left+base.width, bottom=base.top+base.height;
  const items=[];
  const visible=el=>{ const s=getComputedStyle(el); return s.visibility!=='hidden'&&s.display!=='none'; };
  const push=(el,opacity,filter)=>{
    const r=el.getBoundingClientRect();
    if(!(r.width>0&&r.height>0)) return;
    if(r.left+r.width<=base.left||r.top+r.height<=base.top||r.left>=right||r.top>=bottom) return; // 지도 밖
    items.push({el,x:r.left-base.left,y:r.top-base.top,width:r.width,height:r.height,opacity,filter:filter||'none'});
  };
  const containers=[...mapEl.querySelectorAll('.leaflet-tile-container')]
    .map((el,i)=>({el,i,z:parseInt(el.style&&el.style.zIndex,10)||0}))
    .sort((a,b)=>a.z-b.z||a.i-b.i);
  containers.forEach(({el:container})=>{
    if(!visible(container)) return;
    const opacity=effectiveOpacity(container,mapEl);
    // 화면의 배경 지도는 CSS filter(흑백·밝기, style.css의 .leaflet-tile-pane)가 걸려 있다 —
    // 캔버스에도 같은 filter를 걸어 화면과 같은 색으로 그린다
    const pane=typeof container.closest==='function'?container.closest('.leaflet-tile-pane'):null;
    const filter=pane?getComputedStyle(pane).filter:'none';
    container.querySelectorAll('img.leaflet-tile').forEach(img=>{
      if(!(img.complete&&img.naturalWidth>0)||!visible(img)) return; // 아직 못 받은 타일
      push(img,opacity,filter);
    });
  });
  mapEl.querySelectorAll('.leaflet-pane canvas').forEach(el=>{
    if(visible(el)) push(el,effectiveOpacity(el,mapEl));
  });
  return {width:base.width,height:base.height,items};
}

function effectiveOpacity(el,stopEl){
  let opacity=1;
  for(let node=el;node&&node!==stopEl;node=node.parentElement){
    const v=parseFloat(getComputedStyle(node).opacity);
    if(Number.isFinite(v)) opacity*=v;
  }
  return opacity;
}

// 지도 저작권 표시(OSM attribution)는 DOM이라 캔버스에 글자로 다시 쓴다
function drawMapAttribution(ctx,mapEl,width,height){
  const el=mapEl.querySelector('.leaflet-control-attribution');
  const text=el?String(el.textContent||'').replace(/\s+/g,' ').trim():'';
  if(!text) return;
  ctx.font='11px sans-serif';
  const w=ctx.measureText(text).width+10, h=16;
  ctx.fillStyle='rgba(255,255,255,0.8)';
  ctx.fillRect(width-w,height-h,w,h);
  ctx.fillStyle='#333';
  ctx.textBaseline='middle';
  ctx.fillText(text,width-w+5,height-h/2);
}

function renderAccumMapToCanvas(){
  const mapEl=document.getElementById('accum-map');
  const {width,height,items}=collectMapDrawItems(mapEl);
  const scale=Math.max(1,Number(window.devicePixelRatio)||1); // 화면 배율만큼 선명하게
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(width*scale);
  canvas.height=Math.round(height*scale);
  const ctx=canvas.getContext('2d');
  ctx.scale(scale,scale);
  const bg=getComputedStyle(mapEl).backgroundColor;
  ctx.fillStyle=bg&&!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)?bg:'#dddddd';
  ctx.fillRect(0,0,width,height);
  items.forEach(it=>{
    ctx.globalAlpha=it.opacity;
    ctx.filter=it.filter||'none'; // ctx.filter를 모르는 브라우저(Safari)는 원본 색으로 그려진다
    ctx.drawImage(it.el,it.x,it.y,it.width,it.height);
  });
  ctx.globalAlpha=1;
  ctx.filter='none';
  drawMapAttribution(ctx,mapEl,width,height);
  return {
    canvas,
    tiles:items.filter(it=>it.el.tagName==='IMG').length,
    layers:items.filter(it=>it.el.tagName==='CANVAS').length,
  };
}

function canvasToPngBlob(canvas){
  return new Promise((resolve,reject)=>{
    try{
      canvas.toBlob(blob=>(blob?resolve(blob):reject(new Error('지도를 PNG로 바꾸지 못했어요.'))),'image/png');
    }catch(err){
      // CORS 허용 없이 받은 이미지가 섞이면 캔버스가 오염돼 내보낼 수 없다(SecurityError)
      reject(err&&err.name==='SecurityError'
        ?new Error('배경 지도 타일 서버가 CORS를 허용하지 않아 이미지를 만들 수 없어요.')
        :err);
    }
  });
}

function downloadBlob(blob,fileName){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=fileName;
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

// 저장 — 파일 저장 창(showSaveFilePicker)을 지원하면 위치·이름을 고르게 하고, 없거나 띄울 수
// 없으면(사용자 동작이 만료된 경우 등) 브라우저 다운로드로 저장한다. 저장 창에서 취소하면 canceled.
async function saveBrowserPng(blob,fileName){
  if(typeof window.showSaveFilePicker==='function'){
    let handle=null;
    try{
      handle=await window.showSaveFilePicker({
        suggestedName:fileName,
        types:[{description:'PNG 이미지',accept:{'image/png':['.png']}}],
      });
    }catch(err){
      if(err&&err.name==='AbortError') return {canceled:true};
      if(!(err&&(err.name==='SecurityError'||err.name==='NotAllowedError'))) throw err;
    }
    if(handle){
      const writable=await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {canceled:false,filePath:handle.name||fileName,bytes:blob.size,savedVia:'picker'};
    }
  }
  downloadBlob(blob,fileName);
  return {canceled:false,filePath:fileName,bytes:blob.size,savedVia:'download'};
}

async function captureAccumMapInBrowser(fileName){
  const {canvas,tiles,layers}=renderAccumMapToCanvas();
  const blob=await canvasToPngBlob(canvas);
  const saved=await saveBrowserPng(blob,fileName);
  return {...saved,width:canvas.width,height:canvas.height,tiles,layers};
}

// 반환: {status:'saved'|'canceled'|'error'|'not-ready'|'unsupported'|'busy', ...}
async function captureAccumMap(){
  if(mapCaptureInFlight) return {status:'busy'};
  if(!mapCaptureSupported()){
    showError('이 브라우저는 지도 캡처(캔버스 PNG 저장)를 지원하지 않아요. 운영체제 화면 캡처 기능을 사용해 주세요.');
    return {status:'unsupported'};
  }
  if(!isAccumMapSettled()){
    if(typeof showToast==='function') showToast('지도를 계산하는 중이에요. 다 그려진 뒤에 다시 눌러 주세요.');
    return {status:'not-ready'};
  }
  mapCaptureInFlight=true;
  updateCaptureButton();
  let restores=[];
  try{
    accumMap.invalidateSize();
    const idle=await waitForAccumMapIdle(MAP_CAPTURE_TILE_WAIT_MS);
    if(!isAccumMapSettled()){
      if(typeof showToast==='function') showToast('캡처를 준비하는 동안 지도가 다시 계산되기 시작했어요. 다 그려진 뒤에 다시 눌러 주세요.');
      return {status:'not-ready'};
    }
    const mode=mapCaptureMode();
    restores=hideUiForMapCapture(); // pending 미리보기를 빼고 Canvas Layer를 다시 그린다
    if(mode==='desktop') restores.push(...scrollMapIntoViewForCapture()); // capturePage는 창에 보이는 픽셀만 찍는다
    await nextPaint();
    const fileName=buildMapCaptureFileName();
    let res, clipped=false;
    if(mode==='desktop'){
      const rect=mapCaptureRect();
      clipped=mapRectClipped(rect);
      res=await window.routeAPI.captureMap(rect,fileName);
    }else{
      res=await captureAccumMapInBrowser(fileName);
    }
    if(!res||res.canceled){
      if(typeof showToast==='function') showToast('지도 캡처 저장을 취소했어요.');
      return {status:'canceled',mode,fileName};
    }
    const whereNote=res.savedVia==='download'?' (브라우저 다운로드 폴더)':'';
    const tileNote=idle.tilesLoaded?'':' (일부 배경 지도 타일이 아직 로딩 중이었어요)';
    const clipNote=clipped?' (지도가 창보다 커서 보이는 부분만 저장했어요)':'';
    if(typeof showToast==='function') showToast(`지도 캡처를 저장했어요: ${res.filePath}${whereNote}${tileNote}${clipNote}`);
    return {status:'saved',mode,fileName,tilesLoaded:idle.tilesLoaded,clipped,...res};
  }catch(err){
    console.warn('[경로뷰어] 지도 캡처 실패:',err);
    showError('지도를 캡처하지 못했어요. ('+err.message+')');
    return {status:'error',error:err.message};
  }finally{
    restores.reverse().forEach(fn=>{ try{ fn(); }catch(_){ /* 복원 실패는 무시 */ } });
    mapCaptureInFlight=false;
    updateCaptureButton();
  }
}

function setAccumZone(zone){
  if(pendingManualEditCount()&&zone!==accumZoneFilter){
    if(!confirm('아직 적용하지 않은 셀 선택이 있어요. 적용하지 않고 다른 구역으로 이동할까요?')) return;
    clearPendingManualCellSelection();
  }
  if(boundaryDrawMode) cancelBoundaryDraw(true);
  cellEditMode=null;
  exitVertexEditMode();
  accumZoneFilter=zone;
  styleZoneButtons('zone-filter-group',zone);
  updateBoundaryUI();
  renderAccumView();
  if(showCoverageGaps&&zone!=='all'&&!ZONE_POLYGONS[zone]){
    startBoundaryDraw();
  }
}

function initAccumMap(){
  if(accumMap) return;
  accumMap=L.map('accum-map',{zoomSnap:0.5,zoomDelta:0.5,preferCanvas:true}).setView([37.498,127.032],11);
  // crossOrigin: 브라우저 모드 지도 캡처가 타일을 캔버스에 합성할 수 있게 CORS로 받는다
  accumTileLayer=addNoKeyOsmTileLayer(accumMap,{crossOrigin:'anonymous'})||null;
  accumDensityLayer=L.layerGroup().addTo(accumMap);
  coverageLayer=L.layerGroup().addTo(accumMap);
  manualCellsLayer=L.layerGroup().addTo(accumMap);
  vehicleStorageLayer=L.layerGroup().addTo(accumMap);
  addVehicleStorageMarker(accumMap,vehicleStorageLayer);
  wireHoverTooltip();
  accumMap.on('movestart zoomstart',hideAccumTooltip);
  accumMap.on('click',onBoundaryMapClick);
}

function toggleCoverageGaps(){
  showCoverageGaps=!showCoverageGaps;
  if(!showCoverageGaps){ showCoverageDepth=false; boundaryEditOpen=false; cellEditMode=null; exitVertexEditMode(); }
  const btn=document.getElementById('coverage-toggle-btn');
  btn.classList.toggle('active',showCoverageGaps);
  btn.textContent=showCoverageGaps?'밀도 지도로 보기':'커버리지 갭 보기';
  document.getElementById('accum-hint').textContent=showCoverageGaps
    ?defaultCoverageHint()
    :'지도 위에 마우스를 가져다 대면 그 근처 기록이 바로 떠요';
  updateBoundaryUI();
  if(!showCoverageGaps&&boundaryDrawMode) cancelBoundaryDraw(true);
  if(!showCoverageGaps) hideCoveragePanels();
  renderAccumView();
  if(showCoverageGaps&&accumZoneFilter!=='all'&&!ZONE_POLYGONS[accumZoneFilter]){
    startBoundaryDraw();
  }
}

// 구역 경계원(근사치) 없이, 직접 그린 다각형만으로 갭을 표시한다.
// 아직 경계를 안 그린 구역은 건너뛰고, 하나도 없으면 안내 문구를 보여준다.
// 계산(calculateCoverage — 캐시)을 전부 끝낸 뒤 token을 확인하고 나서야 한 번에 그린다 —
// 느린 계산이 늦게 끝나도, 그 사이 시작된 더 새 렌더의 화면을 덮지 않는다.
async function renderCoverageGapLayer(token){
  if(!coverageLayer) return null;
  const drawnZones=coverageZonesInView();
  drawnZones.forEach(paintZoneOutline); // 계산이 오래 걸려도 경계선은 먼저 보인다
  const results=[];
  for(const zone of drawnZones){
    results.push(await calculateCoverage(zone));
    if(token!==accumRenderToken) return null;
  }
  renderCachedCoverage(results);

  const hintEl=document.getElementById('accum-hint');
  if(drawnZones.length===0){
    hintEl.textContent=accumZoneFilter==='all'
      ? '아직 그린 구역 경계가 없어요. 위에서 구역을 선택하고 "경계 그리기"로 먼저 만들어보세요.'
      : `아직 ${accumZoneFilter} 구역 경계가 없어요. 위 "경계 그리기" 버튼으로 지도를 클릭해서 그려보세요.`;
  }else{
    hintEl.textContent=defaultCoverageHint();
    updateCellEditHint();
  }

  // 화면 맞춤
  if(accumZoneFilter!=='all'&&ZONE_POLYGONS[accumZoneFilter]){
    accumMap.fitBounds(L.polygon(ZONE_POLYGONS[accumZoneFilter]).getBounds(),{padding:[20,20]});
  }else if(drawnZones.length){
    const allPts=drawnZones.flatMap(z=>ZONE_POLYGONS[z]);
    accumMap.fitBounds(L.latLngBounds(allPts),{padding:[40,40]});
  }else if(accumZoneFilter!=='all'&&ZONE_CENTERS[accumZoneFilter]){
    accumMap.setView(ZONE_CENTERS[accumZoneFilter],13);
  }
  return results;
}

// 누적 지도 다시 그리기.
// 포인트 원본은 화면으로 가져오지 않고, DB가 집계한 값(요약/격자/범위)만 받는다.
const ACCUM_CELL=0.0007; // 약 70~80m — 밀도 격자 한 칸

let accumRenderToken=0;

function normalizeAccumZoneFilter(){
  if(accumZoneFilter==='all'||!ACTIVE_ZONE_NAMES.includes(accumZoneFilter)){
    accumZoneFilter=ACTIVE_ZONE_NAMES[0]||'all';
  }
}

// 누적 지도의 버튼·필터·안내 문구만 현재 상태로 맞춘다 — DB 조회도 계산도 하지 않는다.
function refreshAccumUI(){
  normalizeAccumZoneFilter();
  renderFilterButtons('zone-filter-buttons',ACTIVE_ZONE_NAMES.map(z=>({value:z,label:z})),'zone',setAccumZone,false);
  styleZoneButtons('zone-filter-group',accumZoneFilter);
  renderIssueFilterButtons('accum-issue-filter');
  updateBoundaryUI();
  updateAccumDateFilterUI();
  updateCellEditHint();
}

// 누적 지도는 언제나 "전체 기간"으로 시작한다. 날짜칸은 브라우저가 새로고침 때 값을 되살리는
// 일이 있어서(Chromium 폼 복원), 첫 진입 때 화면 값까지 같이 비워 상태와 어긋나지 않게 한다.
let accumDateDefaultApplied=false;
function applyAccumDefaultDateRange(){
  if(accumDateDefaultApplied) return;
  accumDateDefaultApplied=true;
  accumDateFrom=''; accumDateTo='';
  ['accum-date-from','accum-date-to'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
  updateAccumDateFilterUI();
}

function ensureAccumView(){
  applyAccumDefaultDateRange();
  initAccumMap();
}

// 다른 탭에 가려져 있던 지도는 크기를 다시 재야 타일이 제대로 깔린다.
function scheduleAccumMapResize(){
  setTimeout(()=>{ if(accumMap) accumMap.invalidateSize(); },60);
}

// 탭 전환으로 누적 지도에 들어올 때(app.js switchTab) 부른다.
// 마지막으로 그린 뒤로 바뀐 게 없으면 기존 지도·Layer를 그대로 두고
// invalidateSize와 UI 표시만 갱신한다. 반환값: 다시 그렸으면 true.
function enterAccumView(){
  ensureAccumView();
  scheduleAccumMapResize();
  refreshAccumUI();
  if(accumViewInitialized&&!coverageDirty&&coverageCacheKey===accumViewKey()){
    coverageStats.reuses++;
    return Promise.resolve(false);
  }
  dropProvisionalCoverage(); // 지도 데이터를 못 받아 임시로 계산했던 구역은 이번에 다시 시도
  return renderAccumView().then(()=>true);
}

// 렌더가 (더 새 렌더에 밀리지 않고) 끝까지 그렸을 때 호출 — 이 화면을 재사용 가능으로 표시
function markAccumViewRendered(token,viewKey,complete){
  if(token!==accumRenderToken) return;
  accumViewInitialized=true;
  coverageCacheKey=viewKey;
  coverageDirty=!complete||accumViewKey()!==viewKey;
}

// 그리는 중(accumRendering)에는 지도 캡처 버튼을 막는다 — 날짜를 바꾼 직후 이전 지도를
// 찍지 않도록, 최신 렌더가 끝났을 때만 다시 연다.
async function renderAccumView(){
  const token=++accumRenderToken; // 빠르게 필터를 바꿔도 늦게 온 결과가 화면을 덮지 않게
  accumRendering=true;
  updateCaptureButton();
  try{
    await renderAccumViewInner(token);
  }finally{
    if(token===accumRenderToken){
      accumRendering=false;
      updateCaptureButton();
    }
  }
}

async function renderAccumViewInner(token){
  const statusEl=document.getElementById('accum-status');
  const statsEl=document.getElementById('accum-stats');

  refreshAccumUI();
  ensureAccumView();
  scheduleAccumMapResize();
  hideAccumTooltip();
  coverageStats.renders++;
  const viewKey=accumViewKey();

  let overview;
  try{
    overview=await RouteDB.getOverview(accumFilter());
  }catch(err){
    console.warn('[경로뷰어] 누적 지도 집계 실패:',err);
    showError('누적 지도를 계산하지 못했어요. ('+err.message+')');
    return;
  }
  if(token!==accumRenderToken) return;

  const totalStats=await RouteDB.stats();
  if(token!==accumRenderToken) return;

  if(!totalStats.points){
    statusEl.style.display='block';
    statusEl.innerHTML='아직 쌓인 기록이 없어요. <b>"파일 불러오기"</b> 탭에서 여러 날짜의 파일을 불러오면, 그동안 돌아다닌 곳이 전부 이 지도 위에 겹쳐 표시돼요.';
    statsEl.style.display='none';
    accumMap.setView([VEHICLE_STORAGE_PLACE.lat,VEHICLE_STORAGE_PLACE.lng],15);
    if(accumDensityLayer) accumDensityLayer.clearLayers();
    if(coverageLayer) coverageLayer.clearLayers();
    if(manualCellsLayer) manualCellsLayer.clearLayers();
    resetCoverageCellLayerCache();
    accumCells=[];
    hideCoveragePanels();
    markAccumViewRendered(token,viewKey,true);
    return;
  }
  statusEl.style.display='none';

  // 통계 (필터된 구역 기준)
  statsEl.style.display='grid';
  statsEl.innerHTML=`
    <div class="stat-cell"><div class="k">누적 일수</div><div class="v">${fmtNum(overview.days)}<small> 일</small></div></div>
    <div class="stat-cell"><div class="k">총 기록 지점</div><div class="v">${fmtNum(overview.points)}<small> 개</small></div></div>
    <div class="stat-cell"><div class="k">구역</div><div class="v" style="font-size:13px;">${overview.zones.map(([z,c])=>`${escapeHtml(z)} ${fmtNum(c)}`).join(' · ')||'—'}</div></div>
    <div class="stat-cell"><div class="k">차량</div><div class="v" style="font-size:13px;">${overview.vehicles.map(([v,c])=>`${escapeHtml(v)} ${fmtNum(c)}`).join(' · ')||'—'}</div></div>
  `;

  // 밀도 시각화 vs 커버리지 갭 — 토글 상태에 따라 둘 중 하나만 그린다.
  // 밀도 모드일 때 쓰는 셀 데이터(accumCells)는 호버 툴팁이 그대로 재사용하므로,
  // 갭 모드일 때는 비워둬서 호버 툴팁이 뜨지 않게 한다.
  accumDensityLayer.clearLayers();
  accumCells=[];

  if(showCoverageGaps){
    coverageLayer.clearLayers();
    if(manualCellsLayer) manualCellsLayer.clearLayers();
    resetCoverageCellLayerCache();
    pendingPreviewHiddenKeys=new Set();
    showCoverageLoading();
    let results=null;
    try{
      results=await renderCoverageGapLayer(token);
    }catch(err){
      console.warn('[경로뷰어] 커버리지 계산 실패:',err);
      if(token===accumRenderToken) showError('커버리지를 계산하지 못했어요. ('+err.message+')');
    }finally{
      if(token===accumRenderToken) hideCoverageLoading();
    }
    if(!results||token!==accumRenderToken) return;
    renderCoverageDetailPanel(results);
    markAccumViewRendered(token,viewKey,results.every(r=>!r||r.cacheable));
    return;
  }

  hideCoverageLoading();
  if(coverageLayer) coverageLayer.clearLayers();
  if(manualCellsLayer) manualCellsLayer.clearLayers();
  resetCoverageCellLayerCache();
  hideCoveragePanels();

  const cells=await RouteDB.getDensityCells(accumFilter(),ACCUM_CELL);
  if(token!==accumRenderToken) return;

  if(cells.length){
    const maxN=Math.max(...cells.map(c=>c.n),1);
    const dotColor=accumZoneFilter!=='all'&&ZONE_COLORS[accumZoneFilter] ? ZONE_COLORS[accumZoneFilter] : '#4fd8c7';
    let issueCells=0;
    const showIssueGray=currentIssueFilter()!=='clean';
    cells.forEach(c=>{
      const t=Math.min(1,c.n/maxN);
      const radius=4+t*8;
      // 구역 색 점은 언제나 그대로 그린다 — 이슈가 섞였다고 그 칸의 원래 색이 사라지면
      // "문제 없는 날도 여기서 달렸다"는 사실이 지도에서 보이지 않는다.
      L.circleMarker([c.lat,c.lng],{
        radius, weight:0, fillColor:dotColor, fillOpacity:0.6+t*0.4,
      }).addTo(accumDensityLayer);
      // 이슈 몫만 그 위에 회색으로 겹쳐 올린다. 크기는 그 칸에서 이슈 기록이 차지하는 비율이라,
      // 반반 섞인 칸은 색 테두리 + 회색 속으로 보이고, 전부 이슈인 칸만 완전히 회색이 된다.
      // '이슈 없음'을 보고 있을 때는 겹치지 않는다(그 화면에 남은 기록은 정상 파일에서도 나온 것들이다).
      const issueRatio=c.n?Math.min(1,(c.issueN||0)/c.n):0;
      if(showIssueGray&&issueRatio>0){
        issueCells++;
        L.circleMarker([c.lat,c.lng],{
          radius:Math.max(2,radius*Math.sqrt(issueRatio)), weight:0,
          fillColor:ISSUE_CELL_COLOR, fillOpacity:0.85,
        }).addTo(accumDensityLayer);
      }
      accumCells.push(c);
    });
    updateAccumIssueLegend(issueCells,cells.length);
  }else{
    updateAccumIssueLegend(0,0);
  }

  // 구역을 선택했으면 그 구역 중심으로, 아니면 필터된 전체 범위로 화면 맞춤
  const bounds=await RouteDB.getBounds(accumFilter());
  if(token!==accumRenderToken) return;
  if(bounds){
    accumMap.fitBounds(
      L.latLngBounds([[bounds.minLat,bounds.minLng],[bounds.maxLat,bounds.maxLng]]),
      {padding:[26,26]}
    );
  }else if(accumZoneFilter!=='all'&&ZONE_CENTERS[accumZoneFilter]){
    accumMap.setView(ZONE_CENTERS[accumZoneFilter],13);
  }
  markAccumViewRendered(token,viewKey,true);
}

// ── 마우스 호버 툴팁: 드래그/클릭 없이 그냥 지도 위에 커서를 올리면
//    가장 가까운 원(셀)의 정보가 커서 옆에 바로 뜬다. 원을 그릴 때 쓴
//    accumCells를 그대로 조회하므로 화면에 보이는 크기와 항상 일치한다. ──
let hoverPending=false, hoverPos=null, hoverLatLng=null;
let manualMapPointerDown=null, manualMapPointerDragged=false;
const MANUAL_CELL_DRAG_THRESHOLD_PX=8;

function wireHoverTooltip(){
  const mapEl=document.getElementById('accum-map');
  mapEl.addEventListener('pointerdown',e=>{
    manualMapPointerDown={x:e.clientX,y:e.clientY};
    manualMapPointerDragged=false;
  },true);
  mapEl.addEventListener('pointermove',e=>{
    if(!manualMapPointerDown) return;
    if(Math.hypot(e.clientX-manualMapPointerDown.x,e.clientY-manualMapPointerDown.y)>MANUAL_CELL_DRAG_THRESHOLD_PX){
      manualMapPointerDragged=true;
    }
  },true);
  mapEl.addEventListener('pointercancel',()=>{
    manualMapPointerDown=null;
    manualMapPointerDragged=false;
  },true);
  mapEl.addEventListener('mousemove',e=>{
    const rect=mapEl.getBoundingClientRect();
    hoverPos={x:e.clientX-rect.left,y:e.clientY-rect.top};
    hoverLatLng=accumMap.containerPointToLatLng([hoverPos.x,hoverPos.y]);
    if(!hoverPending){
      hoverPending=true;
      requestAnimationFrame(()=>{ hoverPending=false; updateAccumTooltip(); });
    }
  });
  mapEl.addEventListener('mouseleave',hideAccumTooltip);
  mapEl.addEventListener('click',e=>{
    if(!cellEditMode||!showCoverageGaps||boundaryDrawMode||!accumMap) return;
    const wasDrag=manualMapPointerDragged || (manualMapPointerDown&&Math.hypot(e.clientX-manualMapPointerDown.x,e.clientY-manualMapPointerDown.y)>MANUAL_CELL_DRAG_THRESHOLD_PX);
    manualMapPointerDown=null;
    manualMapPointerDragged=false;
    if(wasDrag){
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    const rect=mapEl.getBoundingClientRect();
    const ll=accumMap.containerPointToLatLng([e.clientX-rect.left,e.clientY-rect.top]);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    toggleManualCellAt(ll.lat,ll.lng);
  },true);
}

function hideAccumTooltip(){
  const tip=document.getElementById('accum-tooltip');
  if(tip) tip.style.display='none';
  hoverLatLng=null;
}

function updateAccumTooltip(){
  const tip=document.getElementById('accum-tooltip');
  if(!hoverLatLng||!hoverPos||!accumCells.length){ tip.style.display='none'; return; }

  // 마우스에서 가장 가까운 "원(셀)" 하나만 찾는다 — 여러 셀을 섞어 집계하지 않음
  let nearest=null, nearestDist=Infinity;
  for(const c of accumCells){
    const d=haversine(hoverLatLng.lat,hoverLatLng.lng,c.lat,c.lng);
    if(d<nearestDist){ nearestDist=d; nearest=c; }
  }
  if(!nearest||nearestDist>HOVER_MAX_DIST_M){ tip.style.display='none'; return; }

  const sortDesc=obj=>Object.entries(obj||{}).sort((a,b)=>b[1]-a[1]);
  const subParts=[`${fmtNum(nearest.n)}개 지점`];
  if(nearest.issueN>0) subParts.push(`이슈 데이터 ${fmtNum(nearest.issueN)}개`);
  if(accumZoneFilter==='all'){
    const zs=sortDesc(nearest.zones).slice(0,2).map(([z])=>z);
    if(zs.length) subParts.push(zs.join(', '));
  }
  const vs=sortDesc(nearest.vehicles).slice(0,2).map(([v])=>v);
  if(vs.length) subParts.push(vs.join(', '));

  // dateCount = 이 칸을 지나간 서로 다른 날짜 수 (DB가 COUNT(DISTINCT date)로 계산)
  tip.innerHTML=`<div class="at-days">${fmtNum(nearest.dateCount)}일 지나감</div><div class="at-sub${nearest.issueN>0?' issue':''}">${escapeHtml(subParts.join(' · '))}</div>`;
  tip.style.display='block';

  // 커서 근처에 배치하되, 컨테이너 밖으로 나가지 않도록 위치 보정
  const wrap=document.getElementById('accum-map-wrap');
  const tw=tip.offsetWidth||160, th=tip.offsetHeight||50;
  let x=hoverPos.x+16, y=hoverPos.y+16;
  if(x+tw>wrap.clientWidth) x=hoverPos.x-tw-16;
  if(y+th>wrap.clientHeight) y=hoverPos.y-th-16;
  tip.style.left=Math.max(4,x)+'px';
  tip.style.top=Math.max(4,y)+'px';
}
