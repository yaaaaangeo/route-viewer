// ══════════════════════════════════════════════════════════
//  core — 버전 표시 · 시계 · 공통 유틸(거리/날짜/요약)
// ══════════════════════════════════════════════════════════
// ── 버전 표시 ────────────────────────────────────────
// 기능을 추가/수정할 때마다 이 값만 올려주면 화면 좌측 하단에 반영됨
// v3.0.0 — 저장소를 SQLite/IndexedDB로 바꾸고, 파일 불러오기를 "추가(merge)"로 변경
// v3.1.0 — 값 충돌 검사 · Import History 강화 · Coverage %/Depth · 설정(차량/지역)
// v3.1.1 — 비교 탭을 없애고, 그 정보(거리·기록수·주행시간·GPS공백/점프)를 달력 일자 요약에 통합
const APP_VERSION='v3.1.2';
document.getElementById('version-badge').textContent=APP_VERSION;

// 숫자에 천 단위 쉼표 — import 결과·통계 화면에서 공통으로 쓴다
function fmtNum(n){ return Number(n||0).toLocaleString('ko-KR'); }

// HTML로 넣는 문자열(파일명·장소 등)에 <,& 가 섞여도 깨지지 않게
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>(
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

// ── 실시간 시계 ───────────────────────────────────────
function tickClock(){
  const n=new Date(),p=x=>String(x).padStart(2,'0');
  document.getElementById('clock').textContent=`${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}
tickClock(); setInterval(tickClock,1000);

// ── 지도 ─────────────────────────────────────────────
let map=null, routeLayer=null, playheadMarker=null, points=[];
let playTimer=null;
let currentSource=null; // 'file' | 'day'
const VEHICLE_STORAGE_PLACE={
  name:'차량 보관 장소',
  address:'서울 강남구 테헤란로 207',
  lat:37.50167609739,
  lng:127.03873445954,
};

// 배경 타일은 OSM 공식 타일 서버를 쓴다. 단, 자원봉사 운영이라 타일 사용 정책
// (operations.osmfoundation.org/policies/tiles)이 "앱을 식별하는 User-Agent"를 요구하고,
// 그렇지 않은 클라이언트에는 타일 대신 "Access blocked" 403 이미지를 돌려준다(응답에
// `x-blocked: Access denied` 헤더). Electron 기본 UA가 딱 이 차단 대상이라, 데스크톱 앱은
// electron/osm-tile-ua.js 의 applyOsmTileUserAgent() 로 타일 요청 UA를 바꿔서 보낸다.
// 브라우저 모드(server.js 로 띄운 http 화면)는 OSM 에 직접 가지 않고 같은 서버의 타일 프록시
// (/tiles/z/x/y.png)로 받는다 — 브라우저가 직접 요청하면 그 브라우저의 Referer·프로필 상태에
// 따라 차단되는 일이 실제로 있었고(새 프로필 Edge 는 통과, 사용자 PC 의 Edge 는 차단), 프록시는
// 항상 앱 식별 UA 로 요청하고 캐시한다. 프록시가 그 칸을 못 주면 그 칸만 OSM 에서 직접 받는다.
//
// 지도가 노란 빗금 + Access blocked 타일로 덮이면: 데스크톱은 UA 주입, 브라우저 모드는
// server.js 창의 "[tiles] OSM 이 타일 … 를 거절" 로그부터 본다.
// 키가 필요한 상용 타일(CARTO 등)로 바꾸면 타일에 "API KEY REQUIRED" 워터마크가 찍힌다 —
// 둘 다 HTTP 200으로 오기 때문에 상태 코드만 봐서는 못 잡고, 타일 그림을 봐야 안다.
//
// extraOptions: 누적 지도는 {crossOrigin:'anonymous'}를 넘긴다 — OSM 타일 서버가
// Access-Control-Allow-Origin:* 를 보내므로, CORS로 받은 타일은 브라우저 모드 지도 캡처
// (캔버스 합성)에 그려도 캔버스가 오염되지 않는다.
const OSM_DIRECT_TILE_URL='https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

function osmTileUrlTemplate(){
  const loc=typeof location!=='undefined'?location:null;
  const desktop=typeof window!=='undefined'&&!!window.routeAPI;
  return loc&&/^https?:$/.test(loc.protocol)&&!desktop?'/tiles/{z}/{x}/{y}.png':OSM_DIRECT_TILE_URL;
}

function addNoKeyOsmTileLayer(targetMap,extraOptions){
  const url=osmTileUrlTemplate();
  const layer=L.tileLayer(url,{
    subdomains:'abc',
    maxZoom:19,
    attribution:'© OpenStreetMap contributors',
    ...(extraOptions||{}),
  }).addTo(targetMap);
  if(url!==OSM_DIRECT_TILE_URL){
    // 프록시가 없는 서버로 띄웠거나 프록시가 그 타일을 못 받았으면(502) 그 칸만 OSM 에서 직접 받는다
    layer.on('tileerror',e=>{
      const img=e.tile, c=e.coords;
      if(!img||!c||img.getAttribute('data-osm-direct')) return;
      img.setAttribute('data-osm-direct','1');
      img.src=L.Util.template(OSM_DIRECT_TILE_URL,{s:'abc'[Math.abs(c.x+c.y)%3],z:c.z,x:c.x,y:c.y});
    });
  }
  return layer;
}

function initMap(){
  if(map) return;
  map=L.map('map',{zoomSnap:0.5,zoomDelta:0.5}).setView([37.498,127.032],12);
  addNoKeyOsmTileLayer(map);
  routeLayer=L.layerGroup().addTo(map);
}

function addVehicleStorageMarker(targetMap,targetLayer){
  if(!targetMap) return null;
  const marker=L.circleMarker([VEHICLE_STORAGE_PLACE.lat,VEHICLE_STORAGE_PLACE.lng],{
    radius:8,
    color:'#ff6b6b',
    fillColor:'#ff2f2f',
    fillOpacity:.95,
    weight:2,
  }).bindPopup(`${VEHICLE_STORAGE_PLACE.name}<br/>${VEHICLE_STORAGE_PLACE.address}`);
  marker.addTo(targetLayer||targetMap);
  marker.bringToFront();
  return marker;
}

// ── haversine 거리(m) ─────────────────────────────────
function haversine(lat1,lng1,lat2,lng2){
  const R=6371000,d2r=Math.PI/180;
  const dLat=(lat2-lat1)*d2r, dLng=(lng2-lng1)*d2r;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function dstr(d){
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

// ── 차량별 파티션 ─────────────────────────────────────
// 하루치 기록은 시간순으로만 정렬돼 온다(getRecordsByDate). 그래서 차량이 두 대 이상
// 달린 날은 서로 다른 차량의 좌표가 번갈아 섞이고, 그걸 그대로 앞뒤로 이으면
// "0초 만에 몇 km 이동"이 되어 멀쩡한 기록이 좌표 점프로 잡힌다(거리·경로도 마찬가지).
// 앞뒤 점을 비교하는 계산은 전부 이 함수로 차량을 나눈 뒤에 해야 한다.
// 커버리지 계산은 예전부터 date+vehicle 로 나눠 쓰고 있다(coverage-grid.js) —
// 같은 규칙을 날짜 상세·품질 검사에도 쓰는 것이다.
// 반환: 차량마다 원본 배열의 인덱스 목록(입력 순서를 지키니 차량 안에서는 여전히 시간순)
function vehicleIndexPartitions(dayPoints){
  const byVehicle=new Map();
  (dayPoints||[]).forEach((p,i)=>{
    const v=String((p&&p.vehicle)||'');
    if(!byVehicle.has(v)) byVehicle.set(v,[]);
    byVehicle.get(v).push(i);
  });
  return [...byVehicle.values()];
}

// point 배열(zone/vehicle/time 포함) → 요약(구역별/차량별 카운트, 시간범위)
function summarizePoints(dayPoints){
  const zoneCount={}, vehicleCount={};
  let minTime=null, maxTime=null;
  for(const p of dayPoints){
    if(p.zone){ zoneCount[p.zone]=(zoneCount[p.zone]||0)+1; }
    if(p.vehicle){ vehicleCount[p.vehicle]=(vehicleCount[p.vehicle]||0)+1; }
    if(p.time){
      if(minTime===null||p.time<minTime) minTime=p.time;
      if(maxTime===null||p.time>maxTime) maxTime=p.time;
    }
  }
  const sortDesc=obj=>Object.entries(obj).sort((a,b)=>b[1]-a[1]);
  return{
    zones:sortDesc(zoneCount), vehicles:sortDesc(vehicleCount),
    startTime:minTime, endTime:maxTime, count:dayPoints.length,
  };
}

// 저장소(IndexedDB 백엔드)가 날짜 요약을 만들 때 쓰는 함수.
// SQLite 백엔드에서는 electron/database.js 의 buildDaySummary 가 같은 일을 한다.
// 두 곳의 결과 모양이 같아야 달력이 백엔드를 신경 쓰지 않는다.
// classification: TimeConditions.classificationConfig(설정) — 없으면 기본 분류 기준
window.buildDaySummaryFromPoints=function(sortedPoints,classification){
  const base=summarizePoints(sortedPoints);
  const q=analyzeDayQuality(sortedPoints);
  // 거리도 차량별로 — 섞인 채로 더하면 차량이 바뀔 때마다 두 차량 사이 직선거리가 얹힌다
  let distM=0;
  for(const part of vehicleIndexPartitions(sortedPoints)){
    for(let k=1;k<part.length;k++){
      const a=sortedPoints[part[k-1]], b=sortedPoints[part[k]];
      distM+=haversine(a.lat,a.lng,b.lat,b.lng);
    }
  }
  return {
    zones:base.zones, vehicles:base.vehicles,
    startTime:base.startTime, endTime:base.endTime,
    distanceKm:Math.round(distM/10)/100,
    quality:{gaps:q.gaps.length,teleports:q.teleports.length,total:q.total},
    // 유효 수집 시간(초) — database.js buildDaySummary와 같은 규칙(collection-stats.js)
    collectionSec:CollectionStats.validDurationSec(sortedPoints),
    // 주행 시간(초) — 차량별 첫 기록~마지막 기록(휴식·공백 포함)의 합
    driveSpanSec:CollectionStats.spanDurationSec(sortedPoints),
    // 조건 칸 + 분류 서명 — database.js buildDaySummary 와 같은 함수(condition-stats.js)
    ...ConditionStats.buildConditionSummary(sortedPoints,classification),
  };
};

// ── 조건 분류(교통 시간대·조도·요일·날씨) 화면 공용 ─────────────
// 판정 규칙은 time-conditions.js, 집계는 condition-stats.js — 화면은 다시 계산하지 않고 표시만 한다.
// classificationConfigCache 는 refreshSettingsCache()(accum.js)가 설정을 읽을 때 채운다.
function currentClassificationConfig(){
  return window.classificationConfigCache||TimeConditions.classificationConfig({});
}
function currentClassificationSignature(){
  return TimeConditions.classificationSignature(currentClassificationConfig());
}

// 축 하나(교통/조도/요일)의 분포 — rows 는 ConditionStats.aggregate(...).rows (그 축 하나로 묶은 것)
// 수집 시간 기준 막대 + "N분 · M개". 값이 있는 칸만, 정해진 순서로.
// issueSecByValue: 축 값 → 이슈 파일에서 온 수집 시간(초). 주면 그 몫을 막대 안에 회색으로 덧그린다
// (누적 지도의 회색 칸과 같은 색). 안 주면 예전처럼 한 가지 색 막대만 그린다.
function conditionDistRowsHTML(rows,dim,issueSecByValue,barColor){
  if(!rows.length) return '<div class="dc-empty">데이터 없음</div>';
  const maxSec=Math.max(1,...rows.map(r=>r.collectionSec));
  return rows.map(r=>{
    const label=ConditionStats.dimensionValueLabel(dim,r[dim]);
    const pct=Math.round(r.collectionSec/maxSec*100);
    const issueSec=Math.min(r.collectionSec,(issueSecByValue&&issueSecByValue.get(r[dim]))||0);
    const issuePct=r.collectionSec?Math.round(issueSec/r.collectionSec*100):0;
    return `<div class="dist-row cond-row" data-dim="${dim}" data-value="${escapeHtml(r[dim])}"${
      issueSec?` title="이슈 데이터 ${fmtNum(Math.round(issueSec/60))}분 포함"`:''}>
      <span class="dist-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="dist-bar-wrap"><span class="dist-bar" style="width:${pct}%;${barColor?`background:${barColor};`:''}">${
        issueSec?`<span class="dist-bar-issue" style="width:${issuePct}%"></span>`:''
      }</span></span>
      <span class="dist-count cond-count"><b>${fmtNum(r.collectionMinutes)}분</b> · ${fmtNum(r.recordCount)}개</span>
    </div>`;
  }).join('');
}

// 조건을 한 문자열에 섞지 않고 축별 배지로 — [교통: 퇴근 피크] [조도: 일몰 전후] [요일: 평일] [날씨: 비]
function conditionBadgesHTML(obj,dims){
  return ConditionStats.describeConditions(obj,dims).map(c=>
    `<span class="cond-badge cond-${c.dim}"><span class="cond-axis">${escapeHtml(c.axis)}</span>${escapeHtml(c.value)}</span>`
  ).join('');
}

// 백업 기록 정리 — 중복 제거 후 최신 10건만
window.dedupeBackupHistory=function(history){
  const seen=new Set();
  return (Array.isArray(history)?history:[])
    .filter(h=>h&&h.at)
    .map(h=>({kind:String(h.kind||'백업 기록'),at:String(h.at),detail:String(h.detail||'')}))
    .filter(h=>{
      const k=`${h.kind}|${h.at}|${h.detail}`;
      if(seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a,b)=>(new Date(b.at).getTime()||0)-(new Date(a.at).getTime()||0))
    .slice(0,10);
};

// 지역/차량 필터 버튼을 설정 데이터로부터 다시 그린다 (요구사항 13~16).
// "전체" + items 순서로 만들고, 클릭하면 onSelect(value)를 부른다.
// active 스타일은 이후 styleZoneButtons()/styleVehicleButtons() 가 입힌다.
function renderFilterButtons(containerId,items,dataAttr,onSelect,includeAll){
  const el=document.getElementById(containerId);
  if(!el) return;
  el.innerHTML='';
  const mk=(value,label)=>{
    const b=document.createElement('button');
    b.type='button'; b.className='zone-btn'; b.dataset[dataAttr]=value; b.textContent=label;
    b.addEventListener('click',()=>onSelect(value));
    return b;
  };
  if(includeAll!==false) el.appendChild(mk('all','전체'));
  (items||[]).forEach(it=>el.appendChild(mk(it.value,it.label)));
}

// ── 차량 색(달력 날짜 상세 · 누적 지도 공용) ─────────────────────
// 차량 순서는 저장된 날짜 요약에 나온 차량 이름 전체를 정렬한 것 — 그래서 같은 차량은
// 어느 화면·어느 날짜에서 봐도 같은 색이다. 시작(초록)·종료/점프(빨강)·공백(주황)과 겹치지 않는 색만.
// [설정] 차량 관리에서 색을 정해 둔 차량은 그 색(statistics.js VEHICLE_COLORS — 통계 탭과 같은 색).
const VEHICLE_PALETTE=['#4fd8c7','#5b9cff','#ff7eb6','#b48cff','#e6d35a','#7fe0ff'];
const NO_VEHICLE_COLOR='#8a94a8';
function compareVehicleNames(a,b){
  return (a===''?1:0)-(b===''?1:0)||String(a).localeCompare(String(b),'ko',{numeric:true});
}
// 기록이 있는 차량 이름(정렬) — 달력이 읽어 둔 날짜 요약(calendar.js dateSummaryIndex)에서 모은다
function knownVehicleNames(){
  const set=new Set();
  if(typeof dateSummaryIndex!=='undefined') dateSummaryIndex.forEach(sum=>{
    (sum&&sum.vehicles||[]).forEach(([v])=>{ if(v) set.add(String(v)); });
  });
  return [...set].sort(compareVehicleNames);
}
function vehicleColor(name){
  const v=name?String(name):'';
  if(!v) return NO_VEHICLE_COLOR;
  if(typeof VEHICLE_COLORS!=='undefined'&&VEHICLE_COLORS&&VEHICLE_COLORS[v]) return VEHICLE_COLORS[v];
  const names=knownVehicleNames();
  let i=names.indexOf(v);
  if(i<0) i=names.length; // 아직 요약에 없는 차량 — 마지막 다음 색
  return VEHICLE_PALETTE[i%VEHICLE_PALETTE.length];
}

function calGoToday(){ calMonth=new Date(); renderCalendarGrid(); }
function calShiftMonth(delta){
  calMonth=new Date(calMonth.getFullYear(),calMonth.getMonth()+delta,1);
  renderCalendarGrid();
}

// ══════════════════════════════════════════════════════════
//  데이터 상태(이슈) 필터 — 달력 · 누적 지도 · 통계 · 데이터 관리 · 추천이 같이 쓴다
//
//  값의 의미는 화면마다 다시 정하지 않는다. 판정 규칙은 issue-filter.js 한 곳에 있고,
//  SQLite 는 EXISTS SQL, IndexedDB 는 maskMatches(), 날짜 요약은 conditionCells 의
//  issueMask 로 같은 결론을 낸다.
//
//  고른 값은 localStorage 에 남겨서 탭을 옮기거나 앱을 다시 켜도 유지된다.
//  (데이터 자체가 아니라 "지금 무엇을 보고 있는지"라서 DB에 넣지 않는다)
// ══════════════════════════════════════════════════════════
const ISSUE_FILTER_LS_KEY='rv.issueFilter';
let issueFilter=(function(){
  try{ return IssueFilter.normalizeFilter(localStorage.getItem(ISSUE_FILTER_LS_KEY)); }
  catch(_){ return 'all'; }
})();

function currentIssueFilter(){ return issueFilter; }
function issueFilterActive(){ return issueFilter!=='all'; }
function issueFilterLabel(v){ return IssueFilter.filterLabel(v===undefined?issueFilter:v); }

// 화면 아래에 적는 "무엇을 기준으로 센 숫자인지" 한 줄
function issueFilterBasis(v){
  const f=IssueFilter.normalizeFilter(v===undefined?issueFilter:v);
  switch(f){
    case 'clean': return '계산 기준: 확인 필요 이슈 파일에서만 온 데이터 제외';
    case 'issue_all': return '계산 기준: 이슈로 표시한 파일에서 온 데이터만';
    default: return '계산 기준: 전체 데이터(이슈 포함)';
  }
}

// 데이터 상태 필터 버튼 — 어느 화면에서 눌러도 같은 값이 바뀐다
function renderIssueFilterButtons(containerId){
  const el=document.getElementById(containerId);
  if(!el) return;
  el.innerHTML='';
  const label=document.createElement('span');
  label.className='issue-filter-label'; label.textContent='데이터 상태';
  el.appendChild(label);
  IssueFilter.ISSUE_FILTERS.forEach(v=>{
    const b=document.createElement('button');
    b.type='button'; b.className='zone-btn'; b.dataset.issue=v;
    b.textContent=IssueFilter.ISSUE_FILTER_SHORT_LABELS[v];
    b.title=IssueFilter.ISSUE_FILTER_LABELS[v];
    b.addEventListener('click',()=>setIssueFilter(v));
    el.appendChild(b);
  });
  styleIssueFilterButtons(containerId);
}

function styleIssueFilterButtons(containerId){
  document.querySelectorAll('#'+containerId+' .zone-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.issue===issueFilter);
  });
}

// 필터가 바뀌면 지금 보고 있는 화면을 다시 그린다. Coverage 는 캐시 키에 이슈 필터가
// 들어 있어서(coverageCalcKey) 키가 달라지면 알아서 다시 계산한다 — 여기서는 구역 경계·
// 도로/건물 같은 정적 Geometry 캐시를 버리지 않는다.
function setIssueFilter(value){
  const next=IssueFilter.normalizeFilter(value);
  if(next===issueFilter) return issueFilter;
  issueFilter=next;
  try{ localStorage.setItem(ISSUE_FILTER_LS_KEY,issueFilter); }catch(_){ /* 무시 */ }
  ['issue-filter-group','accum-issue-filter','stats-issue-filter','data-issue-filter','rec-issue-filter']
    .forEach(styleIssueFilterButtons);
  refreshViewsForIssueFilter();
  return issueFilter;
}

function refreshViewsForIssueFilter(){
  if(typeof recomputeCollectionTotals==='function'){ recomputeCollectionTotals(); renderCollectionProgress(); }
  const tab=typeof currentTab!=='undefined'?currentTab:null;
  if(tab==='calendar'&&typeof renderCalendarGrid==='function'){ renderCalendarGrid(); updateCalStatus(); }
  else if(tab==='accum'&&typeof renderAccumView==='function') renderAccumView();
  else if(tab==='stats'&&typeof renderStatsView==='function') renderStatsView();
  else if(tab==='recommend'&&typeof renderRecommendView==='function') renderRecommendView();
  else if(tab==='data'&&typeof renderDataView==='function') renderDataView();
}

// 이슈 상태 배지 한 조각 (달력·데이터 관리·통계 공용)
// Import 한 건의 이슈 배지 — 자동 가져오기로 들어와 아직 아무도 보지 않은 파일은 "이슈 없음"이 아니라
// "검토 전"으로 보여준다(사람이 확인하지 않은 파일을 정상 확인으로 보이게 하지 않는다)
function importIssueBadgeHtml(im){
  if(im&&im.hasIssue) return issueBadgeHtml(im.issueStatus);
  if(im&&im.needsReview) return '<span class="issue-badge review" title="자동 가져오기로 들어온 파일 — 아직 이슈 여부를 확인하지 않았어요">자동 · 검토 전</span>';
  return '<span class="issue-badge resolved">이슈 없음</span>';
}

function issueBadgeHtml(status,text){
  const cls=status==='resolved'?'resolved':'open';
  const label=text||IssueFilter.statusLabel(status);
  return `<span class="issue-badge ${cls}">${escapeHtml(label)}</span>`;
}
