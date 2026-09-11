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

// DB에서 날짜 요약을 다시 읽어온다. 데이터가 바뀔 때마다(시작·import·삭제·백업 복원·
// 서버 동기화) 호출된다 — 전체 데이터 수집 현황도 여기서만 다시 합산한다.
async function refreshDateIndex(){
  const rows=await RouteDB.listDateSummaries();
  dateSummaryIndex=new Map(rows.map(r=>[r.date,r]));
  recomputeCollectionTotals();
  renderCollectionProgress();
  return dateSummaryIndex;
}

// ── 전체 데이터 수집 현황(달력 맨 위 표) ─────────────────────
// 날짜 요약에 저장된 날짜별 유효 수집 시간(collectionSec)만 더한다 — 원본 GPS 기록은
// 가져오지 않는다. 현재 보고 있는 달·선택한 날짜와 무관한 DB 전체 누적이며, 월 이동이나
// 날짜 선택은 이 값을 다시 계산하지 않는다(refreshDateIndex 때만).
let collectionTotals={totalSec:0,dateCount:0,latestDate:null,missing:0};
const collectionStats={computations:0,renders:0};

function recomputeCollectionTotals(){
  collectionStats.computations++;
  collectionTotals=CollectionStats.summarizeCollection([...dateSummaryIndex.values()]);
  return collectionTotals;
}

function renderCollectionProgress(){
  const body=document.getElementById('cp-body');
  if(!body) return;
  collectionStats.renders++;
  const progress=CollectionStats.collectionProgress(collectionTotals.totalSec,undefined,collectionTotals.totalSpanSec);
  // 주행 시간(첫~마지막 기록, 휴식 포함)과 수집 시간(GPS가 실제 기록된 시간)을 나란히 보여준다.
  // 진행률은 수집 시간 기준이고, 주행 시간 기준 진행률은 그 아래 참고로만 적는다.
  body.innerHTML=progress.rows.map(r=>`
    <tr class="cp-row cp-${escapeHtml(r.key)}">
      <th scope="row"><span class="cp-dot"></span>${escapeHtml(r.label)}</th>
      <td class="mono">${fmtNum(r.targetClips)}</td>
      <td class="mono">${fmtNum(r.targetMinutes)}</td>
      <td class="mono cp-span">${fmtNum(r.driveMinutes)}</td>
      <td class="mono cp-collected">${fmtNum(r.collectedMinutes)}</td>
      <td class="cp-progress"><span class="mono cp-pct">${CollectionStats.formatPercent(r.percent)}</span><span class="cp-bar"><span class="cp-bar-fill" style="width:${r.barPercent.toFixed(2)}%"></span></span><span class="mono cp-sub">주행 기준 ${CollectionStats.formatPercent(r.drivePercent)}</span></td>
    </tr>`).join('');
  const latest=document.getElementById('cp-latest');
  if(latest){
    latest.textContent=`최근 데이터: ${collectionTotals.latestDate||'없음'}`
      +(collectionTotals.missing?` · 수집 시간 계산 전 날짜 ${collectionTotals.missing}일`:'');
  }
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
      if(Number.isFinite(sum.collectionSec)&&Number.isFinite(sum.driveSpanSec)){
        const tm=document.createElement('div');
        tm.className='cal-time';
        tm.textContent=`수집 ${fmtNum(Math.round(sum.collectionSec/60))}분 · 주행 ${fmtNum(Math.round(sum.driveSpanSec/60))}분`;
        tm.title='수집 = GPS가 실제로 기록된 시간(90초 넘는 공백 제외) · 주행 = 첫 기록~마지막 기록(휴식 포함)';
        cell.appendChild(tm);
      }
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
  // 주행 시간 = 차량별 첫 기록~마지막 기록(휴식·GPS 공백 포함, driveSpanSec)
  // 수집 시간 = 그중 GPS가 실제로 기록된 시간(차량별로 90초 넘는 공백 제외, collectionSec)
  // 둘 다 날짜 요약에 저장된 값이고, 달력 맨 위 "전체 데이터 수집 현황"과 같은 규칙이다.
  const collectionSec=cached&&Number.isFinite(cached.collectionSec)?cached.collectionSec:null;
  const driveSec=cached&&Number.isFinite(cached.driveSpanSec)?cached.driveSpanSec:null;
  const fmtDuration=sec=>`${(sec/3600).toFixed(1)} h (${fmtNum(Math.round(sec/60))}분)`;
  const gapMinutes=(collectionSec!=null&&driveSec!=null)?Math.round((driveSec-collectionSec)/60):0;

  el.innerHTML=`
    <div class="ds-title">일자 요약</div>
    <div class="ds-row"><span class="ds-label">운행 시간</span><span class="mono" style="font-size:12px;">${sum.startTime||'—'} → ${sum.endTime||'—'}</span></div>
    <div class="ds-row"><span class="ds-label">주행 거리</span><span class="mono" style="font-size:12px;">${distanceKm!=null?distanceKm.toFixed(1)+' km':'—'}</span></div>
    <div class="ds-row"><span class="ds-label">기록 수</span><span class="mono" style="font-size:12px;">${fmtNum(sum.count)}개</span></div>
    <div class="ds-row"><span class="ds-label">주행 시간</span><span class="mono" style="font-size:12px;" title="첫 기록~마지막 기록(휴식·GPS 공백 포함)">${driveSec!=null?fmtDuration(driveSec):'—'}</span></div>
    <div class="ds-row"><span class="ds-label">수집 시간</span><span class="mono" style="font-size:12px;" title="GPS가 실제로 기록된 시간(90초 넘는 공백 제외)">${collectionSec!=null?fmtDuration(collectionSec)+(gapMinutes>0?` · 공백 ${fmtNum(gapMinutes)}분 제외`:''):'—'}</span></div>
    <div class="ds-row"><span class="ds-label">GPS 공백</span><span class="mono" style="font-size:12px;">${quality?fmtNum(quality.gaps):'—'}</span></div>
    <div class="ds-row"><span class="ds-label">GPS 점프</span><span class="mono" style="font-size:12px;">${quality?fmtNum(quality.teleports):'—'}</span></div>
    <div class="ds-row"><span class="ds-label">구역</span>${zoneChips}</div>
    <div class="ds-row"><span class="ds-label">차량</span>${vehicleChips}</div>
  `;
  el.style.display='block';
}
