// ══════════════════════════════════════════════════════════
//  replay — 리플레이 콘솔 · 테이프 스크러버
// ══════════════════════════════════════════════════════════
// ── 콘솔(로드 후 화면) 구성 ────────────────────────────
const REPLAY_MAX_DIRECT_SEGMENT_M=70;

function replayPointTimestamp(p){
  return p.timestamp || (p.date&&p.time ? `${p.date}T${p.time}` : null);
}

function replaySegmentStatus(a,b){
  const distM=haversine(a.lat,a.lng,b.lat,b.lng);
  const t1=replayPointTimestamp(a), t2=replayPointTimestamp(b);
  const dtSec=(window.CoverageGrid&&t1&&t2) ? CoverageGrid.timeDiffSec(t1,t2) : null;
  const maxGapSec=(window.CoverageGrid&&CoverageGrid.MAX_INTERPOLATION_GAP_SEC)||30;
  const maxSpeedKmh=(window.CoverageGrid&&CoverageGrid.MAX_INTERPOLATION_SPEED_KMH)||150;
  const speedKmh=(dtSec&&dtSec>0) ? (distM/dtSec)*3.6 : Infinity;
  return {
    distM,
    connected:distM<=REPLAY_MAX_DIRECT_SEGMENT_M&&dtSec!=null&&dtSec>0&&dtSec<=maxGapSec&&speedKmh<=maxSpeedKmh,
  };
}

// 차량마다 따로 잇는다 — 두 대가 같이 달린 날은 좌표가 시간순으로 번갈아 섞여 있어서,
// 그대로 이으면 두 차량 사이를 오가는 경로가 된다(core.js vehicleIndexPartitions 주석 참고).
function buildReplayRouteSegments(dayPoints){
  const segments=[];
  if(!dayPoints||dayPoints.length<2) return segments;
  for(const part of vehicleIndexPartitions(dayPoints)){
    if(part.length<2) continue;
    let current=[dayPoints[part[0]]];
    for(let k=1;k<part.length;k++){
      const prev=dayPoints[part[k-1]], cur=dayPoints[part[k]];
      if(replaySegmentStatus(prev,cur).connected){
        current.push(cur);
      }else{
        if(current.length>=2) segments.push(current);
        current=[cur];
      }
    }
    if(current.length>=2) segments.push(current);
  }
  return segments;
}

function replayConnectedDistanceM(dayPoints){
  let distM=0;
  for(const part of vehicleIndexPartitions(dayPoints)){
    for(let k=1;k<part.length;k++){
      const status=replaySegmentStatus(dayPoints[part[k-1]],dayPoints[part[k]]);
      if(status.connected) distM+=status.distM;
    }
  }
  return distM;
}

function renderConsole(){
  document.getElementById('dropzone').style.display='none';
  document.getElementById('calendar-view').style.display='none';
  document.getElementById('console').style.display='flex';
  initMap();
  setTimeout(()=>map.invalidateSize(),60);

  routeLayer.clearLayers();
  // 날짜 상세에서 차량이 여러 대인 날은 차량마다 색을 나눈다(calendar.js 차량 탭과 같은 색)
  const multiVehicle=typeof dayIsMultiVehicle==='function'&&dayIsMultiVehicle();
  if(typeof renderMapVehicleTabs==='function') renderMapVehicleTabs();
  const routeColor=p=>multiVehicle?dayVehicleColor(p.vehicle):'#4fd8c7';
  const latlngs=points.map(p=>[p.lat,p.lng]);
  buildReplayRouteSegments(points).forEach(segment=>{
    L.polyline(segment.map(p=>[p.lat,p.lng]),{color:routeColor(segment[0]),weight:4,opacity:.85}).addTo(routeLayer);
  });
  addVehicleStorageMarker(map,routeLayer);

  const start=points[0], end=points[points.length-1];
  // 시작·종료 표시도 차량마다 — 여러 대를 같이 보면 차량별 첫 기록·마지막 기록에 찍고 테두리를 차량 색으로
  for(const part of vehicleIndexPartitions(points)){
    const s=points[part[0]], e=points[part[part.length-1]];
    const who=multiVehicle?`${escapeHtml(s.vehicle||'차량 정보 없음')} · `:'';
    L.circleMarker([s.lat,s.lng],{radius:8,color:multiVehicle?routeColor(s):'#5fd88a',fillColor:'#5fd88a',fillOpacity:1,weight:multiVehicle?3:2})
      .bindPopup(`${who}시작 · ${s.time||'—'}${s.place?('<br/>'+s.place):''}`).addTo(routeLayer);
    L.circleMarker([e.lat,e.lng],{radius:8,color:multiVehicle?routeColor(e):'#ff6b6b',fillColor:'#ff6b6b',fillOpacity:1,weight:multiVehicle?3:2})
      .bindPopup(`${who}종료 · ${e.time||'—'}${e.place?('<br/>'+e.place):''}`).addTo(routeLayer);
  }

  playheadMarker=L.marker([start.lat,start.lng],{
    icon:L.divIcon({className:'playhead-icon',iconSize:[16,16]})
  }).addTo(routeLayer);

  map.fitBounds(L.latLngBounds(latlngs),{padding:[26,26]});

  // 데이터 품질 체크: 시간 공백/좌표 점프 의심 지점을 지도 위에 별도 표시
  const quality=analyzeDayQuality(points);
  renderQualityPanel(quality);
  quality.gaps.forEach(g=>{
    const p1=points[g.prevI], p2=points[g.i];
    L.circleMarker([p1.lat,p1.lng],{radius:6,color:'#ffb84d',fillColor:'#ffb84d',fillOpacity:.9,weight:1})
      .bindPopup(`⏱ 시간 공백 시작<br/>다음 기록까지 ${g.gapSec}초`).addTo(routeLayer);
    L.circleMarker([p2.lat,p2.lng],{radius:6,color:'#ffb84d',fillColor:'#ffb84d',fillOpacity:.9,weight:1})
      .bindPopup(`⏱ 시간 공백 끝<br/>이전 기록에서 ${g.gapSec}초 지남`).addTo(routeLayer);
  });
  quality.teleports.forEach(t=>{
    const p=points[t.i];
    L.circleMarker([p.lat,p.lng],{radius:7,color:'#ff6b6b',fillColor:'#ff6b6b',fillOpacity:.9,weight:2})
      .bindPopup(`📍 좌표 점프 의심<br/>추정 속도 ${isFinite(t.speedKmh)?Math.round(t.speedKmh)+'km/h':'∞'}`).addTo(routeLayer);
  });

  // 통계
  const distM=replayConnectedDistanceM(points);
  document.getElementById('stat-date').textContent=start.date||'—';
  document.getElementById('stat-range').innerHTML=(start.time&&end.time)?`${start.time}<small> → </small>${end.time}`:'—';
  document.getElementById('stat-points').textContent=points.length+'개';
  document.getElementById('stat-dist').innerHTML=(distM/1000).toFixed(2)+'<small> km</small>';

  // 테이프(스크러버) 설정
  const tape=document.getElementById('tape');
  tape.min=0; tape.max=points.length-1; tape.value=0;
  tape.oninput=()=>setTapeIndex(parseInt(tape.value,10));
  document.getElementById('tape-start-lbl').textContent=start.time||'--:--:--';
  document.getElementById('tape-end-lbl').textContent=end.time||'--:--:--';
  setTapeIndex(0);
}

function setTapeIndex(idx){
  if(!points.length) return;
  idx=Math.max(0,Math.min(points.length-1,idx));
  const p=points[idx];
  document.getElementById('tape').value=idx;
  const pct=points.length>1?(idx/(points.length-1)*100):0;
  document.getElementById('tape').style.setProperty('--pct',pct+'%');
  document.getElementById('tape-time').textContent=p.time||'--:--:--';
  document.getElementById('tape-place').textContent=p.place||'—';
  document.getElementById('tape-speed').textContent=p.speed?(p.speed+' km/h'):'—';
  document.getElementById('tape-road').textContent=p.road||'—';
  document.getElementById('tape-idx').textContent=`${idx+1} / ${points.length}`;
  // 이 지점의 조건 — 날짜 상세(DB)는 이미 분류값이 붙어 오고, 파일을 바로 연 경우는 같은 규칙으로 계산
  const condEl=document.getElementById('tape-conditions');
  if(condEl){
    const cls=p.trafficPeriod?p:{...p,...TimeConditions.classifyRecord(p,currentClassificationConfig())};
    condEl.innerHTML=conditionBadgesHTML(cls,['trafficPeriod','lightCondition','weekdayType','weather']);
  }
  if(playheadMarker) playheadMarker.setLatLng([p.lat,p.lng]);
  if(map && !map._tapePanning){
    map.panTo([p.lat,p.lng],{animate:true,duration:.25});
  }
}

function stepTape(delta){
  const tape=document.getElementById('tape');
  setTapeIndex(parseInt(tape.value,10)+delta);
}

const PLAY_BASE_MS=180;
let playSpeed=1;

function setPlaySpeed(mult){
  playSpeed=mult;
  document.querySelectorAll('.speed-btn').forEach(b=>{
    b.classList.toggle('active',parseFloat(b.dataset.speed)===mult);
  });
  if(playTimer){ clearInterval(playTimer); startPlayInterval(); }
}

function startPlayInterval(){
  playTimer=setInterval(()=>{
    const tape=document.getElementById('tape');
    let idx=parseInt(tape.value,10)+1;
    if(idx>points.length-1){ clearInterval(playTimer); playTimer=null; document.getElementById('play-btn').textContent='▶'; return; }
    setTapeIndex(idx);
  },PLAY_BASE_MS/playSpeed);
}

function togglePlay(){
  const btn=document.getElementById('play-btn');
  if(playTimer){
    clearInterval(playTimer); playTimer=null; btn.textContent='▶';
    return;
  }
  btn.textContent='⏸';
  startPlayInterval();
}

// "다른 파일 불러오기" — 화면만 초기화한다.
//
// ⚠ 예전에는 여기서 entriesByDate=null; persistEntries() 로 저장된 데이터까지
//    통째로 지웠다. 파일을 하나 더 보려던 것뿐인데 그동안 쌓은 기록이 날아갔다.
//    이제 저장된 데이터는 건드리지 않는다. 삭제는 [데이터 관리] 탭에서만 한다.
function resetViewer(){
  points=[];
  currentSource=null;
  if(playTimer){ clearInterval(playTimer); playTimer=null; }
  document.getElementById('play-btn').textContent='▶';
  if(typeof fileInput!=='undefined'&&fileInput) fileInput.value='';
  switchTab('upload');
}
