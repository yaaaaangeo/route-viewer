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
const HOVER_MAX_DIST_M=90; // 커서가 셀 중심에서 이만큼(m) 이내일 때만 그 점의 정보를 보여줌

let accumMap=null, accumDensityLayer=null, coverageLayer=null, vehicleStorageLayer=null;
let showCoverageGaps=false;
const GAP_CELL_SIZE_M=50; // 커버리지 격자 한 칸 크기

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

// ── 경계 그리기 상태 (nav-app sectorDrawMode/sectorDraftPts와 같은 구조) ──
let boundaryDrawMode=false, boundaryDrawZone=null;
let boundaryDraftPts=[], boundaryDraftLayer=null, boundaryDraftMarkers=[];

function startBoundaryDraw(){
  if(accumZoneFilter==='all'){
    const hintEl=document.getElementById('accum-hint');
    if(hintEl) hintEl.textContent='커버리지 갭을 보려면 먼저 강남, 판교, 시흥 중 하나를 선택하세요.';
    return;
  }
  initAccumMap();
  boundaryDrawMode=true;
  boundaryDrawZone=accumZoneFilter;
  boundaryDraftPts=[];
  clearBoundaryDraft();
  coverageLayer.clearLayers();
  accumDensityLayer.clearLayers();
  accumCells=[];
  if(ZONE_CENTERS[accumZoneFilter]){
    accumMap.setView(ZONE_CENTERS[accumZoneFilter],13);
  }
  document.getElementById('accum-hint').textContent=`${accumZoneFilter} 경계를 그리는 중입니다. 지도 위를 클릭해서 꼭짓점을 찍고 완료를 누르세요.`;
  document.getElementById('boundary-draw-bar').classList.add('show');
}

function onBoundaryMapClick(e){
  if(!boundaryDrawMode) return;
  boundaryDraftPts.push([e.latlng.lat,e.latlng.lng]);
  drawBoundaryDraft();
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

function cancelBoundaryDraw(){
  boundaryDrawMode=false;
  boundaryDraftPts=[];
  clearBoundaryDraft();
  document.getElementById('boundary-draw-bar').classList.remove('show');
  updateBoundaryUI();
}

function finishBoundaryDraw(){
  if(boundaryDraftPts.length<3){
    alert('꼭짓점을 3개 이상 찍어야 구역이 됩니다.');
    return;
  }
  ZONE_POLYGONS[boundaryDrawZone]=boundaryDraftPts.map(p=>[p[0],p[1]]);
  saveZonePolygonsToStorage();
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
  delete loadZoneBuildingsCache()[accumZoneFilter];
  saveZoneBuildingsCache();
  saveZonePolygonsToStorage();
  updateBoundaryUI();
  if(showCoverageGaps) renderAccumView();
}

function updateBoundaryUI(){
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
const ZONE_BUILDINGS_LS_KEY='route_viewer_zone_buildings_v1';
let zoneBuildingsCache=null;
let zoneBuildingsFetchPromise={};

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

function bboxKeyFor(poly){
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  return [Math.min(...lats),Math.max(...lats),Math.min(...lngs),Math.max(...lngs)].map(n=>n.toFixed(5)).join(',');
}

async function fetchBuildingsForBbox(minLat,minLng,maxLat,maxLng){
  const query=`[out:json][timeout:25];way["building"](${minLat},${minLng},${maxLat},${maxLng});out geom;`;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const res=await fetch('https://overpass-api.de/api/interpreter',{
      method:'POST',
      headers:{'Content-Type':'text/plain'},
      body:query,
      signal:controller.signal,
    });
    if(!res.ok) throw new Error('overpass HTTP '+res.status);
    const data=await res.json();
    const polygons=[];
    (data.elements||[]).forEach(el=>{
      if(el.type==='way'&&Array.isArray(el.geometry)&&el.geometry.length>=3){
        polygons.push(el.geometry.map(pt=>[pt.lat,pt.lon]));
      }
    });
    return polygons;
  }finally{
    clearTimeout(timer);
  }
}

// zoneName의 건물 폴리곤 목록. 캐시가 있고 구역 경계가 그대로면 캐시를 쓰고,
// 없거나 경계가 바뀌었으면 Overpass에서 새로 받아온다.
async function getZoneBuildingPolygons(zoneName){
  const poly=ZONE_POLYGONS[zoneName];
  if(!poly||poly.length<3) return [];
  const cache=loadZoneBuildingsCache();
  const key=bboxKeyFor(poly);
  const cached=cache[zoneName];
  if(cached&&cached.bboxKey===key) return cached.polygons;
  if(zoneBuildingsFetchPromise[zoneName]) return zoneBuildingsFetchPromise[zoneName];
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);
  const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
  const promise=fetchBuildingsForBbox(minLat,minLng,maxLat,maxLng).then(polygons=>{
    cache[zoneName]={bboxKey:key,polygons,fetchedAt:Date.now()};
    saveZoneBuildingsCache();
    delete zoneBuildingsFetchPromise[zoneName];
    return polygons;
  }).catch(err=>{
    console.warn('[경로뷰어] '+zoneName+' 건물 데이터를 가져오지 못했어요(오프라인일 수 있음):',err);
    delete zoneBuildingsFetchPromise[zoneName];
    return cached?cached.polygons:[];
  });
  zoneBuildingsFetchPromise[zoneName]=promise;
  return promise;
}

// 건물 폴리곤들이 덮는 격자 칸 key 집합. 건물 하나하나의 bbox 안 칸만 훑으므로
// (칸 수 × 전체 건물 수)가 아니라 (건물마다 자기 bbox 칸 수)로 끝난다.
function buildExcludedCellSet(buildingPolygons,latDeg,lngDeg){
  const excluded=new Set();
  buildingPolygons.forEach(poly=>{
    const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
    const minLat=Math.min(...lats), maxLat=Math.max(...lats);
    const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
    const laStart=Math.floor(minLat/latDeg), laEnd=Math.ceil(maxLat/latDeg);
    const loStart=Math.floor(minLng/lngDeg), loEnd=Math.ceil(maxLng/lngDeg);
    for(let la=laStart;la<=laEnd;la++){
      for(let lo=loStart;lo<=loEnd;lo++){
        const key=la+'_'+lo;
        if(excluded.has(key)) continue;
        const cellLat=(la+0.5)*latDeg, cellLng=(lo+0.5)*lngDeg;
        if(pointInPolygon(cellLat,cellLng,poly)) excluded.add(key);
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
async function paintZoneGapGrid(insideTest,minLat,maxLat,minLng,maxLng,refLat,zoneName){
  const latDeg=GAP_CELL_SIZE_M/111320;
  const lngDeg=GAP_CELL_SIZE_M/(111320*Math.cos(refLat*Math.PI/180));
  const marginLat=latDeg*2, marginLng=lngDeg*2;
  const [visitRows,buildingPolygons]=await Promise.all([
    RouteDB.getCellVisitCounts({
      minLat:minLat-marginLat, maxLat:maxLat+marginLat,
      minLng:minLng-marginLng, maxLng:maxLng+marginLng,
      refLat, lngDeg,
    },GAP_CELL_SIZE_M),
    zoneName?getZoneBuildingPolygons(zoneName):Promise.resolve([]),
  ]);
  const visitMap=new Map(visitRows.map(r=>[r.gy+'_'+r.gx,r.visits]));
  const excludedCells=buildExcludedCellSet(buildingPolygons,latDeg,lngDeg);

  const latStart=Math.floor(minLat/latDeg), latEnd=Math.ceil(maxLat/latDeg);
  const lngStart=Math.floor(minLng/lngDeg), lngEnd=Math.ceil(maxLng/lngDeg);
  for(let la=latStart;la<=latEnd;la++){
    for(let lo=lngStart;lo<=lngEnd;lo++){
      const cellLat=(la+0.5)*latDeg, cellLng=(lo+0.5)*lngDeg;
      if(!insideTest(cellLat,cellLng)) continue;
      if(excludedCells.has(la+'_'+lo)) continue;
      const visits=visitMap.get(la+'_'+lo)||0;
      const bounds=[[la*latDeg,lo*lngDeg],[(la+1)*latDeg,(lo+1)*lngDeg]];
      if(showCoverageDepth){
        const tier=tierForCountJS(depthTiers,visits);
        L.rectangle(bounds,{stroke:false,fillColor:tier.color,fillOpacity:.32,interactive:false}).addTo(coverageLayer);
      }else if(visits===0){
        L.rectangle(bounds,{stroke:false,fillColor:'#ff6b6b',fillOpacity:.24,interactive:false}).addTo(coverageLayer);
      }
    }
  }
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

// zoneName 하나의 Coverage — 전체 유효 Cell(폴리곤 안) / 방문 Cell / 등급별 분포
async function computeZoneCoverage(zoneName){
  const poly=ZONE_POLYGONS[zoneName];
  if(!poly||poly.length<3) return null; // 경계 미설정
  const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);
  const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
  const refLat=(minLat+maxLat)/2;
  const latDeg=GAP_CELL_SIZE_M/111320;
  const lngDeg=GAP_CELL_SIZE_M/(111320*Math.cos(refLat*Math.PI/180));

  const [visitRows,buildingPolygons]=await Promise.all([
    RouteDB.getCellVisitCounts({minLat,maxLat,minLng,maxLng,refLat,lngDeg},GAP_CELL_SIZE_M),
    getZoneBuildingPolygons(zoneName),
  ]);
  const visitMap=new Map(visitRows.map(r=>[r.gy+'_'+r.gx,r.visits]));
  const excludedCells=buildExcludedCellSet(buildingPolygons,latDeg,lngDeg);

  const latStart=Math.floor(minLat/latDeg), latEnd=Math.ceil(maxLat/latDeg);
  const lngStart=Math.floor(minLng/lngDeg), lngEnd=Math.ceil(maxLng/lngDeg);
  let total=0;
  const tierCounts={};
  for(let la=latStart;la<=latEnd;la++){
    for(let lo=lngStart;lo<=lngEnd;lo++){
      const cellLat=(la+0.5)*latDeg, cellLng=(lo+0.5)*lngDeg;
      if(!pointInPolygon(cellLat,cellLng,poly)) continue;
      if(excludedCells.has(la+'_'+lo)) continue;
      total++;
      const visits=visitMap.get(la+'_'+lo)||0;
      const tier=tierForCountJS(depthTiers,visits);
      tierCounts[tier.label]=(tierCounts[tier.label]||0)+1;
    }
  }
  const zeroTier=[...depthTiers].sort((a,b)=>a.threshold-b.threshold)[0];
  const unvisited=zeroTier?(tierCounts[zeroTier.label]||0):0;
  const visited=total-unvisited;
  return { zone:zoneName, total, visited, unvisited, coveragePct: total?(visited/total*100):0, tierCounts };
}

// 지역별 Coverage 요약 목록(요구사항 10) — 커버리지 갭 모드에서 전체 지역을 한눈에
async function renderCoverageSummaryList(){
  const el=document.getElementById('coverage-summary');
  if(!el) return;
  if(!showCoverageGaps||!ACTIVE_ZONE_NAMES.length){ el.style.display='none'; el.innerHTML=''; return; }
  const rows=await Promise.all(ACTIVE_ZONE_NAMES.map(async z=>({zone:z,cov:await computeZoneCoverage(z)})));
  el.style.display='flex';
  el.innerHTML=rows.map(({zone,cov})=>{
    const color=ZONE_COLORS[zone]||'#4fd8c7';
    const text=cov?`${cov.coveragePct.toFixed(1)}%`:'경계 미설정';
    return `<button type="button" class="cov-summary-row${accumZoneFilter===zone?' active':''}" data-zone="${escapeHtml(zone)}">
        <span class="cov-summary-dot" style="background:${color}"></span>
        <span class="cov-summary-zone">${escapeHtml(zone)}</span>
        <span class="cov-summary-pct${cov?'':' muted'}">${text}</span>
      </button>`;
  }).join('');
  el.querySelectorAll('.cov-summary-row').forEach(row=>{
    row.addEventListener('click',()=>setAccumZone(row.dataset.zone));
  });
}

// 선택된 지역 하나의 상세 Coverage % + Cell 수 + Depth 분포(요구사항 9, 11)
async function renderCoverageDetailPanel(){
  const el=document.getElementById('coverage-detail');
  if(!el) return;
  if(!showCoverageGaps||accumZoneFilter==='all'){ el.style.display='none'; el.innerHTML=''; return; }
  const cov=await computeZoneCoverage(accumZoneFilter);
  if(!cov){
    el.style.display='flex';
    el.innerHTML=`<div class="cov-detail-empty">${escapeHtml(accumZoneFilter)} 구역은 아직 경계가 설정되지 않았어요. 위 "경계 그리기"로 먼저 그려보세요.</div>`;
    return;
  }
  el.style.display='flex';
  const pct=cov.coveragePct.toFixed(1);
  const color=ZONE_COLORS[accumZoneFilter]||'#4fd8c7';
  const tierRows=[...depthTiers].sort((a,b)=>a.threshold-b.threshold).map(t=>{
    const n=cov.tierCounts[t.label]||0;
    const barPct=cov.total?Math.round(n/cov.total*100):0;
    return `<div class="depth-row">
        <span class="depth-swatch" style="background:${t.color}"></span>
        <span class="depth-label">${escapeHtml(t.label)}</span>
        <span class="depth-bar-wrap"><span class="depth-bar" style="width:${barPct}%;background:${t.color};"></span></span>
        <span class="depth-count mono">${fmtNum(n)}칸</span>
      </div>`;
  }).join('');
  el.innerHTML=`
    <div class="cov-detail-head">
      <div class="cov-detail-title">${escapeHtml(accumZoneFilter)} Coverage</div>
      <div class="cov-detail-pct mono">${pct}%</div>
    </div>
    <div class="cov-bar-wrap"><div class="cov-bar" style="width:${Math.min(100,cov.coveragePct)}%;background:${color};"></div></div>
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

function hideCoveragePanels(){
  const a=document.getElementById('coverage-summary');
  const b=document.getElementById('coverage-detail');
  if(a){ a.style.display='none'; a.innerHTML=''; }
  if(b){ b.style.display='none'; b.innerHTML=''; }
}


// 구역 필터(전체/강남/판교/시흥) 전환
let accumZoneFilter='all';
let accumCells=[]; // renderAccumView가 만든 격자 셀 목록 — 원 그리기와 호버 툴팁이 "같은" 이 데이터를 공유한다

// 현재 구역 필터를 DB 조회 조건으로
function accumFilter(){
  return accumZoneFilter==='all' ? {} : {zone:accumZoneFilter};
}

function setAccumZone(zone){
  if(boundaryDrawMode) cancelBoundaryDraw();
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
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',{
    subdomains:'abcd',maxZoom:20,attribution:'© OpenStreetMap © CARTO'
  }).addTo(accumMap);
  accumDensityLayer=L.layerGroup().addTo(accumMap);
  coverageLayer=L.layerGroup().addTo(accumMap);
  vehicleStorageLayer=L.layerGroup().addTo(accumMap);
  addVehicleStorageMarker(accumMap,vehicleStorageLayer);
  wireHoverTooltip();
  accumMap.on('movestart zoomstart',hideAccumTooltip);
  accumMap.on('click',onBoundaryMapClick);
}

function toggleCoverageGaps(){
  showCoverageGaps=!showCoverageGaps;
  if(!showCoverageGaps) showCoverageDepth=false;
  const btn=document.getElementById('coverage-toggle-btn');
  btn.classList.toggle('active',showCoverageGaps);
  btn.textContent=showCoverageGaps?'밀도 지도로 보기':'커버리지 갭 보기';
  document.getElementById('accum-hint').textContent=showCoverageGaps
    ?'실선/점선 도형 = 직접 그린 구역 경계 · 빨간 칸 = 아직 한 번도 지나가지 않은 곳'
    :'지도 위에 마우스를 가져다 대면 그 근처 기록이 바로 떠요';
  document.getElementById('boundary-controls').style.display=showCoverageGaps?'flex':'none';
  if(!showCoverageGaps&&boundaryDrawMode) cancelBoundaryDraw();
  if(showCoverageGaps) updateBoundaryUI();
  else hideCoveragePanels();
  renderAccumView();
  if(showCoverageGaps&&accumZoneFilter!=='all'&&!ZONE_POLYGONS[accumZoneFilter]){
    startBoundaryDraw();
  }
}

// 구역 경계원(근사치) 없이, 직접 그린 다각형만으로 갭을 표시한다.
// 아직 경계를 안 그린 구역은 건너뛰고, 하나도 없으면 안내 문구를 보여준다.
async function renderCoverageGapLayer(){
  if(!coverageLayer) return;
  coverageLayer.clearLayers();
  const zones=accumZoneFilter==='all' ? ACTIVE_ZONE_NAMES : [accumZoneFilter];
  const drawnZones=zones.filter(z=>ZONE_POLYGONS[z]&&ZONE_POLYGONS[z].length>=3);

  for(const zone of drawnZones){
    const color=ZONE_COLORS[zone]||'#4fd8c7';
    const poly=ZONE_POLYGONS[zone];
    L.polygon(poly,{color,weight:2,dashArray:'6 5',fill:false,opacity:.9})
      .bindTooltip(`${zone} 운영 구역(직접 그린 경계)`,{sticky:true})
      .on('click',()=>setAccumZone(zone))
      .addTo(coverageLayer);
    const lats=poly.map(p=>p[0]), lngs=poly.map(p=>p[1]);
    const minLat=Math.min(...lats), maxLat=Math.max(...lats);
    const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
    await paintZoneGapGrid((la,lo)=>pointInPolygon(la,lo,poly),
      minLat,maxLat,minLng,maxLng,(minLat+maxLat)/2,zone);
  }

  const hintEl=document.getElementById('accum-hint');
  if(drawnZones.length===0){
    hintEl.textContent=accumZoneFilter==='all'
      ? '아직 그린 구역 경계가 없어요. 위에서 구역을 선택하고 "경계 그리기"로 먼저 만들어보세요.'
      : `아직 ${accumZoneFilter} 구역 경계가 없어요. 위 "경계 그리기" 버튼으로 지도를 클릭해서 그려보세요.`;
  }else{
    hintEl.textContent='실선/점선 도형 = 직접 그린 구역 경계 · 빨간 칸 = 아직 한 번도 지나가지 않은 곳';
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
}

// 누적 지도 다시 그리기.
// 포인트 원본은 화면으로 가져오지 않고, DB가 집계한 값(요약/격자/범위)만 받는다.
const ACCUM_CELL=0.0007; // 약 70~80m — 밀도 격자 한 칸

let accumRenderToken=0;

async function renderAccumView(){
  const token=++accumRenderToken; // 빠르게 필터를 바꿔도 늦게 온 결과가 화면을 덮지 않게
  const statusEl=document.getElementById('accum-status');
  const statsEl=document.getElementById('accum-stats');

  renderFilterButtons('zone-filter-buttons',ACTIVE_ZONE_NAMES.map(z=>({value:z,label:z})),'zone',setAccumZone);
  styleZoneButtons('zone-filter-group',accumZoneFilter);

  initAccumMap();
  setTimeout(()=>accumMap.invalidateSize(),60);
  hideAccumTooltip();

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
    accumCells=[];
    hideCoveragePanels();
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
    await renderCoverageGapLayer();
    if(token!==accumRenderToken) return;
    await renderCoverageSummaryList();
    await renderCoverageDetailPanel();
    return;
  }

  if(coverageLayer) coverageLayer.clearLayers();
  hideCoveragePanels();

  const cells=await RouteDB.getDensityCells(accumFilter(),ACCUM_CELL);
  if(token!==accumRenderToken) return;

  if(cells.length){
    const maxN=Math.max(...cells.map(c=>c.n),1);
    const dotColor=accumZoneFilter!=='all'&&ZONE_COLORS[accumZoneFilter] ? ZONE_COLORS[accumZoneFilter] : '#4fd8c7';
    cells.forEach(c=>{
      const t=Math.min(1,c.n/maxN);
      L.circleMarker([c.lat,c.lng],{
        radius:4+t*8, weight:0, fillColor:dotColor,
        fillOpacity:0.15+t*0.65,
      }).addTo(accumDensityLayer);
      accumCells.push(c);
    });
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
}

// ── 마우스 호버 툴팁: 드래그/클릭 없이 그냥 지도 위에 커서를 올리면
//    가장 가까운 원(셀)의 정보가 커서 옆에 바로 뜬다. 원을 그릴 때 쓴
//    accumCells를 그대로 조회하므로 화면에 보이는 크기와 항상 일치한다. ──
let hoverPending=false, hoverPos=null, hoverLatLng=null;

function wireHoverTooltip(){
  const mapEl=document.getElementById('accum-map');
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
  if(accumZoneFilter==='all'){
    const zs=sortDesc(nearest.zones).slice(0,2).map(([z])=>z);
    if(zs.length) subParts.push(zs.join(', '));
  }
  const vs=sortDesc(nearest.vehicles).slice(0,2).map(([v])=>v);
  if(vs.length) subParts.push(vs.join(', '));

  // dateCount = 이 칸을 지나간 서로 다른 날짜 수 (DB가 COUNT(DISTINCT date)로 계산)
  tip.innerHTML=`<div class="at-days">${fmtNum(nearest.dateCount)}일 지나감</div><div class="at-sub">${escapeHtml(subParts.join(' · '))}</div>`;
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
