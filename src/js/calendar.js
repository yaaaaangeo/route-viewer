// ══════════════════════════════════════════════════════════
//  calendar — 달력 그리드 · 날짜별 상세
//
//  예전에는 화면이 들고 있던 entriesByDate(Map) 를 그대로 읽었지만,
//  이제는 DB가 만들어 둔 "날짜 요약"만 읽는다.
//  포인트 원본은 사용자가 날짜를 눌렀을 때만 그 하루치를 가져온다.
//  → 몇 년치가 쌓여도 달력을 여는 비용이 늘지 않는다.
// ══════════════════════════════════════════════════════════

// date → {count, zones, vehicles, startTime, endTime, quality, distanceKm}
let dateSummaryIndex = new Map();
let calMonth = new Date();

// DB에서 날짜 요약을 다시 읽어온다. 데이터가 바뀔 때마다(import/삭제/복구) 호출.
async function refreshDateIndex(){
  const rows=await RouteDB.listDateSummaries();
  dateSummaryIndex=new Map(rows.map(r=>[r.date,r]));
  return dateSummaryIndex;
}

function hasAnyData(){ return dateSummaryIndex.size>0; }
function sortedDataDates(){ return [...dateSummaryIndex.keys()].sort(); }
function totalPointCount(){
  let n=0;
  dateSummaryIndex.forEach(s=>{ n+=s.count||0; });
  return n;
}

function renderCalendarGrid(){
  document.getElementById('cal-title').textContent=
    `${calMonth.getFullYear()}년 ${calMonth.getMonth()+1}월`;
  const grid=document.getElementById('cal-grid');
  grid.innerHTML='';
  ['일','월','화','수','목','금','토'].forEach(d=>{
    const el=document.createElement('div');
    el.className='cal-dow'; el.textContent=d;
    grid.appendChild(el);
  });

  const firstDay=new Date(calMonth.getFullYear(),calMonth.getMonth(),1);
  const daysInMonth=new Date(calMonth.getFullYear(),calMonth.getMonth()+1,0).getDate();
  const startWeekday=firstDay.getDay();
  const todayStr=dstr(new Date());

  for(let i=0;i<startWeekday;i++){
    const el=document.createElement('div');
    el.className='cal-cell empty';
    grid.appendChild(el);
  }
  for(let day=1;day<=daysInMonth;day++){
    const dateObj=new Date(calMonth.getFullYear(),calMonth.getMonth(),day);
    const key=dstr(dateObj);
    const sum=dateSummaryIndex.get(key)||null;
    const cell=document.createElement('div');
    cell.className='cal-cell'+(sum?' has-data':'')+(key===todayStr?' today':'');
    const num=document.createElement('div');
    num.className='cal-daynum'; num.textContent=day;
    cell.appendChild(num);

    if(sum&&sum.count){
      const q=sum.quality||{total:0};
      if(q.total>0){
        const warn=document.createElement('div');
        warn.className='cal-warn-badge';
        warn.textContent='⚠';
        warn.title=`의심 항목 ${q.total}건 — 눌러서 자세히 확인`;
        cell.appendChild(warn);
      }
      const chips=document.createElement('div');
      chips.className='cal-chips';
      (sum.zones||[]).slice(0,2).forEach(([z])=>{
        const c1=document.createElement('span');
        c1.className='cal-chip zone'; c1.textContent=z;
        chips.appendChild(c1);
      });
      (sum.vehicles||[]).slice(0,2).forEach(([v])=>{
        const c2=document.createElement('span');
        c2.className='cal-chip vehicle'; c2.textContent=v;
        chips.appendChild(c2);
      });
      cell.appendChild(chips);
      const cnt=document.createElement('div');
      cnt.className='cal-count'; cnt.textContent=`${fmtNum(sum.count)}개 지점`;
      cell.appendChild(cnt);
      cell.onclick=()=>openDayDetail(key);
    }
    grid.appendChild(cell);
  }
}

// 날짜 클릭 — 이때만 그 하루치 원본 포인트를 DB에서 가져온다
async function openDayDetail(dateKey){
  clearError();
  let sorted=[];
  try{
    sorted=await RouteDB.getRecordsByDate(dateKey);
  }catch(err){
    console.warn('[경로뷰어] 날짜 기록 조회 실패:',err);
    showError(`${dateKey} 기록을 불러오지 못했어요. (${err.message})`);
    return;
  }
  if(!sorted.length){
    showError(`${dateKey} 기록에는 지도에 표시할 GPS 좌표가 없어요.`);
    return;
  }
  points=sorted;
  currentSource='day';
  document.getElementById('chip-label').textContent='선택한 날짜:';
  document.getElementById('chip-filename').textContent=dateKey;
  document.getElementById('back-btn').textContent='← 달력으로';
  document.getElementById('back-btn').onclick=()=>switchTab('calendar');
  // dateSummaryIndex 에 이미 거리/품질검사 결과가 캐시돼 있다(달력이 refreshDateIndex로
  // 채워둔 값) — 새로 계산하지 않고 그대로 재사용한다.
  renderDaySummary(summarizePoints(sorted),dateSummaryIndex.get(dateKey));
  renderConsole();
}

// sum: summarizePoints() 결과(zones/vehicles/startTime/endTime/count)
// cached: dateSummaryIndex 에 있는 날짜 요약(distanceKm/quality) — 없으면 '—'로 표시
function renderDaySummary(sum,cached){
  const el=document.getElementById('day-summary');
  const zoneChips=sum.zones.length
    ? sum.zones.map(([z])=>`<span class="ds-chip zone">${escapeHtml(z)}</span>`).join(' ')
    : '<span style="color:var(--text-faint);font-size:11px;">구역 정보 없음(이전 버전 기록)</span>';
  const vehicleChips=sum.vehicles.length
    ? sum.vehicles.map(([v])=>`<span class="ds-chip vehicle">${escapeHtml(v)}</span>`).join(' ')
    : '<span style="color:var(--text-faint);font-size:11px;">차량 정보 없음</span>';

  const distanceKm=cached&&cached.distanceKm!=null?cached.distanceKm:null;
  const quality=cached&&cached.quality?cached.quality:null;
  let hours=null;
  if(sum.startTime&&sum.endTime){
    let sec=timeToSec(sum.endTime)-timeToSec(sum.startTime);
    if(sec!=null){ if(sec<0) sec+=86400; hours=sec/3600; }
  }

  el.innerHTML=`
    <div class="ds-title">일자 요약</div>
    <div class="ds-row"><span class="ds-label">운행 시간</span><span class="mono" style="font-size:12px;">${sum.startTime||'—'} → ${sum.endTime||'—'}</span></div>
    <div class="ds-row"><span class="ds-label">주행 거리</span><span class="mono" style="font-size:12px;">${distanceKm!=null?distanceKm.toFixed(1)+' km':'—'}</span></div>
    <div class="ds-row"><span class="ds-label">기록 수</span><span class="mono" style="font-size:12px;">${fmtNum(sum.count)}개</span></div>
    <div class="ds-row"><span class="ds-label">주행 시간</span><span class="mono" style="font-size:12px;">${hours!=null?hours.toFixed(1)+' h':'—'}</span></div>
    <div class="ds-row"><span class="ds-label">GPS 공백</span><span class="mono" style="font-size:12px;">${quality?fmtNum(quality.gaps):'—'}</span></div>
    <div class="ds-row"><span class="ds-label">GPS 점프</span><span class="mono" style="font-size:12px;">${quality?fmtNum(quality.teleports):'—'}</span></div>
    <div class="ds-row"><span class="ds-label">구역</span>${zoneChips}</div>
    <div class="ds-row"><span class="ds-label">차량</span>${vehicleChips}</div>
  `;
  el.style.display='block';
}
