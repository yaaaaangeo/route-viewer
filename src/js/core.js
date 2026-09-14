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

// 배경 타일은 CARTO Voyager(OSM 데이터로 렌더한 무료·키 없는 타일)를 쓴다.
// 왜 tile.openstreetmap.org 를 안 쓰나: OSM 공식 타일 서버는 자원봉사 운영이라
// 타일 사용 정책(operations.osmfoundation.org/policies/tiles)에 따라 앱을 차단한다 —
// Electron 앱처럼 브라우저로 식별되지 않는 클라이언트에는 타일 대신 "Access blocked"
// 403 이미지가 오고, 응답에 `x-blocked: Access denied` 헤더가 붙는다(실제로 겪은 회귀:
// 지도 전체가 노란 빗금 + Access blocked 타일로 덮였다).
// extraOptions: 누적 지도는 {crossOrigin:'anonymous'}를 넘긴다 — CARTO 타일도
// Access-Control-Allow-Origin:* 를 보내므로, CORS로 받은 타일은 브라우저 모드 지도 캡처
// (캔버스 합성)에 그려도 캔버스가 오염되지 않는다.
function addNoKeyOsmTileLayer(targetMap,extraOptions){
  return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',{
    subdomains:'abcd',
    maxZoom:20,
    attribution:'© OpenStreetMap contributors © CARTO',
    ...(extraOptions||{}),
  }).addTo(targetMap);
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
window.buildDaySummaryFromPoints=function(sortedPoints){
  const base=summarizePoints(sortedPoints);
  const q=analyzeDayQuality(sortedPoints);
  let distM=0;
  for(let i=1;i<sortedPoints.length;i++){
    distM+=haversine(sortedPoints[i-1].lat,sortedPoints[i-1].lng,sortedPoints[i].lat,sortedPoints[i].lng);
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
  };
};

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

function calGoToday(){ calMonth=new Date(); renderCalendarGrid(); }
function calShiftMonth(delta){
  calMonth=new Date(calMonth.getFullYear(),calMonth.getMonth()+delta,1);
  renderCalendarGrid();
}
