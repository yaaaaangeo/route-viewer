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
// importId → Import 이력(이슈 여부·메모·상태). 날짜 요약의 importSources 와 맞춰서
// 달력 배지와 일자 요약의 이슈 목록을 만든다 — 날짜마다 DB를 다시 묻지 않는다.
let importIndex = new Map();
// 데이터 상태 필터 때문에 하루가 일부만 남은 날짜 수(주행 시간은 그런 날짜를 빼고 더한다)
let collectionPartialDates = 0;

// DB에서 날짜 요약을 다시 읽어온다. 데이터가 바뀔 때마다(시작·import·삭제·백업 복원·
// 서버 동기화) 호출된다 — 전체 데이터 수집 현황도 여기서만 다시 합산한다.
async function refreshDateIndex(){
  const rows=await RouteDB.listDateSummaries();
  dateSummaryIndex=new Map(rows.map(r=>[r.date,r]));
  await refreshImportIndex();
  recomputeCollectionTotals();
  renderCollectionProgress();
  return dateSummaryIndex;
}

// Import 이력을 한 번에 읽어 색인해 둔다(이슈 배지·일자 요약 이슈 목록 공용)
async function refreshImportIndex(){
  try{
    const imports=await RouteDB.listImports(100000,{});
    importIndex=new Map((imports||[]).map(im=>[im.id,im]));
  }catch(err){
    console.warn('[경로뷰어] Import 이력을 읽지 못했어요:',err);
    importIndex=new Map();
  }
  return importIndex;
}

// 지금 고른 데이터 상태 필터로 걸러 본 날짜 요약
function visibleDateSummary(sum){
  return sum?ConditionStats.filterDaySummary(sum,currentIssueFilter()):null;
}

// 그 날짜에 걸린 이슈 개수 — 같은 Import 가 여러 번 세지 않게 importId 로 묶는다(issue-filter.js)
function dateIssueSummary(sum){
  if(!sum||!Array.isArray(sum.importSources)) return {open:0,resolved:0,total:0,records:0};
  return IssueFilter.summarizeDateIssues(sum.importSources.map(s=>{
    const im=importIndex.get(s.importId)||{};
    return {importId:s.importId,recordCount:s.recordCount,hasIssue:!!im.hasIssue,issueStatus:im.issueStatus};
  }));
}

// ── 전체 데이터 수집 현황(달력 맨 위 표) ─────────────────────
// 날짜 요약에 저장된 날짜별 유효 수집 시간(collectionSec)만 더한다 — 원본 GPS 기록은
// 가져오지 않는다. 현재 보고 있는 달·선택한 날짜와 무관한 DB 전체 누적이며, 월 이동이나
// 날짜 선택은 이 값을 다시 계산하지 않는다(refreshDateIndex 때만).
let collectionTotals={totalSec:0,dateCount:0,latestDate:null,missing:0};
const collectionStats={computations:0,renders:0};

function recomputeCollectionTotals(){
  collectionStats.computations++;
  // 데이터 상태 필터가 걸려 있으면 그 필터에 남는 기록만 더한다(기록 수·수집 시간은 정확히 나뉜다).
  const list=[...dateSummaryIndex.values()].map(visibleDateSummary).filter(s=>s&&s.count>0);
  collectionPartialDates=list.filter(s=>s.partial).length;
  collectionTotals=CollectionStats.summarizeCollection(list);
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
      +(collectionTotals.missing?` · 수집 시간 계산 전 날짜 ${collectionTotals.missing}일`:'')
      +(issueFilterActive()?` · ${issueFilterLabel()}만 집계`:'');
  }
  const basis=document.getElementById('cp-issue-basis');
  if(basis){
    basis.textContent=issueFilterActive()
      ? `${issueFilterBasis()}${collectionPartialDates?` · 하루 일부만 걸러진 ${collectionPartialDates}일은 주행 시간에서 빠집니다(주행 시간은 첫 기록~마지막 기록이라 파일별로 나눌 수 없어요)`:''}`
      : '';
    basis.style.display=issueFilterActive()?'block':'none';
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
  renderIssueFilterButtons('issue-filter-group');
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
    const raw=dateSummaryIndex.get(key)||null;
    const sum=visibleDateSummary(raw);
    const hidden=!!(raw&&sum&&!sum.count); // 데이터는 있지만 지금 필터에서 빠진 날짜
    const cell=document.createElement('div');
    cell.className='cal-cell'+(sum&&sum.count?' has-data':'')+(hidden?' issue-hidden':'')+(key===todayStr?' today':'');
    if(hidden) cell.title=`${issueFilterLabel()} 기준에서는 이 날짜에 남는 기록이 없어요(전체 ${fmtNum(sum.fullCount)}개).`;
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
      const issues=dateIssueSummary(raw);
      if(issues.total){
        const badge=document.createElement('div');
        badge.className='cal-issue-badge';
        badge.innerHTML=(issues.open?`<span class="issue-badge open">확인 필요 ${issues.open}</span>`:'')
          +(issues.resolved?`<span class="issue-badge resolved">확인 완료 ${issues.resolved}</span>`:'');
        badge.title=`이슈로 표시한 파일 ${issues.total}개 · 그 파일에서 온 기록 ${fmtNum(issues.records)}개 — 눌러서 일자 요약에서 확인`;
        cell.appendChild(badge);
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
    }
    if(raw){
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
  renderDayIssues(dateKey);
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
    ${dayConditionSectionsHTML(cached)}
    <div id="ds-issues" class="ds-issues"></div>
  `;
  el.style.display='block';
}

// 일자 요약의 조건 분포 — 날짜 요약에 저장된 조건 칸(conditionCells)만 더한다(원본 기록을 다시 읽지 않음).
// 수집 시간은 달력 맨 위 표·"수집 시간"과 같은 규칙(차량별 90초 넘는 GPS 공백 제외)이라 합이 서로 맞는다.
function dayConditionSectionsHTML(cached){
  if(!cached||!Array.isArray(cached.conditionCells)){
    return '<div class="ds-row"><span class="ds-label">조건</span><span style="color:var(--text-faint);font-size:11px;">날짜 요약을 다시 만들면 교통 시간대·조도 분포가 표시돼요</span></div>';
  }
  const signature=currentClassificationSignature();
  const by=dim=>ConditionStats.aggregate([cached],{groupBy:[dim],signature}).rows;
  const combos=ConditionStats.aggregate([cached],{groupBy:['weekdayType','trafficPeriod','lightCondition','weather'],signature}).rows
    .sort((a,b)=>b.collectionSec-a.collectionSec).slice(0,6);
  const stale=ConditionStats.isStale(cached,signature)
    ? '<div class="ir-note warn ds-cond-stale">분류 기준이 바뀐 뒤 아직 다시 분류하지 않은 날짜예요. [설정] 탭에서 재분류하면 새 기준으로 바뀌어요.</div>'
    : '';
  return `
    <div class="ds-cond">
      ${stale}
      <div class="ds-cond-grid">
        <div class="ds-cond-block" data-axis="trafficPeriod">
          <div class="ds-subtitle">교통 시간대 <span class="ds-hint">수집 시간 · 기록 수</span></div>
          ${conditionDistRowsHTML(by('trafficPeriod'),'trafficPeriod')}
        </div>
        <div class="ds-cond-block" data-axis="lightCondition">
          <div class="ds-subtitle">조도 조건 <span class="ds-hint">수집 시간 · 기록 수</span></div>
          ${conditionDistRowsHTML(by('lightCondition'),'lightCondition')}
        </div>
      </div>
      <div class="ds-subtitle">조건 조합 <span class="ds-hint">수집 시간 많은 순</span></div>
      <div class="ds-combos">${combos.map(c=>`<div class="ds-combo">${conditionBadgesHTML(c)}<span class="mono ds-combo-n">${fmtNum(c.collectionMinutes)}분 · ${fmtNum(c.recordCount)}개</span></div>`).join('')||'<div class="dc-empty">데이터 없음</div>'}</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  일자 요약 · 이슈사항
//
//  그 날짜의 기록이 어느 Import 파일에서 왔는지 보여주고, 거기 적힌 이슈 메모를
//  고치거나 확인 필요 ↔ 확인 완료로 바꿀 수 있다. 중복 제거 때문에 한 기록이 여러
//  파일에서 왔을 수 있어서, 파일 목록은 record_sources(출처 관계)에서 가져온다.
// ══════════════════════════════════════════════════════════
let dayIssueDate=null;
let dayIssueImports=[];
let dayIssueEditingId=null;

async function renderDayIssues(dateKey){
  dayIssueDate=dateKey;
  dayIssueEditingId=null;
  try{
    dayIssueImports=await RouteDB.listDateImports(dateKey);
  }catch(err){
    console.warn('[경로뷰어] 날짜 Import 목록 조회 실패:',err);
    dayIssueImports=[];
  }
  paintDayIssues();
}

function paintDayIssues(){
  const box=document.getElementById('ds-issues');
  if(!box) return;
  const list=dayIssueImports||[];
  if(!list.length){
    box.innerHTML='<div class="ds-subtitle">이슈사항</div><div class="dc-empty">이 날짜 기록의 Import 출처 정보가 없어요(이 기능 이전에 들어온 데이터예요).</div>';
    return;
  }
  const issues=list.filter(im=>im.hasIssue);
  const head=`<div class="ds-subtitle">이슈사항 <span class="ds-hint">${issues.length?`이슈 ${issues.length}건`:'등록된 이슈 없음'} · Import 파일 ${list.length}개</span></div>`;
  box.innerHTML=head+`<div class="issue-list">${list.map(im=>dayIssueItemHTML(im)).join('')}</div>`;
}

function dayIssueItemHTML(im){
  const editing=dayIssueEditingId===im.id;
  const cls=im.hasIssue?(im.issueStatus==='resolved'?'resolved':'open'):'';
  const max=IssueFilter.ISSUE_NOTE_MAX;
  const conflict=im.issueConflict
    ? `<div class="ir-note warn">다른 기기의 수정과 겹쳐서 최신 값(${escapeHtml(im.issueConflict.keptFrom==='local'?'이 기기':'동기화된 쪽')})을 남겼어요. 밀려난 메모: ${escapeHtml(im.issueConflict.replaced&&im.issueConflict.replaced.issueNote||'(없음)')}</div>`
    : '';
  const body=editing
    ? `<div class="issue-edit-row">
         <input type="text" id="ds-issue-input-${im.id}" maxlength="${max}" value="${escapeHtml(im.issueNote||'')}" placeholder="이슈 내용을 한 줄로 적어주세요 (최대 ${max}자)"/>
         <button class="btn" type="button" onclick="saveDayIssue(${im.id})">저장</button>
         <button class="btn ghost" type="button" onclick="cancelDayIssueEdit()">취소</button>
       </div>
       <div class="imp-err" id="ds-issue-err-${im.id}"></div>`
    : (im.hasIssue?`<div class="issue-note-text">${escapeHtml(im.issueNote||'')}</div>`:'');
  const actions=editing?'':`
    <div class="issue-item-actions">
      <button class="btn ghost" type="button" onclick="startDayIssueEdit(${im.id})">${im.hasIssue?'메모 수정':'이슈 등록'}</button>
      ${im.hasIssue?`<button class="btn ghost" type="button" onclick="toggleDayIssueStatus(${im.id})">${im.issueStatus==='resolved'?'확인 필요로 되돌리기':'확인 완료로 변경'}</button>`:''}
      ${im.hasIssue?`<button class="btn ghost" type="button" onclick="clearDayIssue(${im.id})" title="이슈 표시를 지웁니다(기록은 그대로)">이슈 해제</button>`:''}
    </div>`;
  return `
    <div class="issue-item ${cls}">
      <div class="issue-item-head">
        <span class="imp-name" title="${escapeHtml(im.filename||'')}">${escapeHtml(im.filename||'(파일명 없음)')}</span>
        ${im.hasIssue?issueBadgeHtml(im.issueStatus):'<span class="issue-badge resolved">이슈 없음</span>'}
      </div>
      <div class="issue-item-meta mono">
        <span>기록 ${fmtNum(im.recordCount||0)}개</span>
        <span>${escapeHtml(im.importedAt||'')}</span>
        ${im.importedBy?`<span>${escapeHtml(im.importedBy)}</span>`:''}
      </div>
      ${body}${conflict}${actions}
    </div>`;
}

function startDayIssueEdit(importId){ dayIssueEditingId=importId; paintDayIssues(); }
function cancelDayIssueEdit(){ dayIssueEditingId=null; paintDayIssues(); }

async function saveDayIssue(importId){
  const input=document.getElementById('ds-issue-input-'+importId);
  const note=input?input.value:'';
  const check=IssueFilter.validateIssueInput({hasIssue:true,issueNote:note});
  if(!check.ok){
    const err=document.getElementById('ds-issue-err-'+importId);
    if(err){ err.textContent=check.errors[0]; err.style.display='block'; }
    return;
  }
  const current=(dayIssueImports||[]).find(im=>im.id===importId);
  await applyImportIssueChange(importId,{
    hasIssue:true, issueNote:check.value.issueNote,
    issueStatus:(current&&current.hasIssue&&current.issueStatus)||'open',
  });
}

async function toggleDayIssueStatus(importId){
  const im=(dayIssueImports||[]).find(x=>x.id===importId);
  if(!im) return;
  await applyImportIssueChange(importId,{issueStatus:im.issueStatus==='resolved'?'open':'resolved'});
}

async function clearDayIssue(importId){
  await applyImportIssueChange(importId,{hasIssue:false,issueNote:''});
}

// 이슈를 고친 뒤 화면을 맞춘다 — 날짜 요약(이슈 마스크)이 다시 만들어지므로 달력 숫자도 다시 읽는다.
// 누적 지도 Coverage 는 RouteDB.onChange 알림으로 accum.js 가 무효화한다.
async function applyImportIssueChange(importId,patch){
  try{
    await RouteDB.updateImportIssue(importId,patch);
  }catch(err){
    showError(`이슈를 저장하지 못했어요. (${(err&&err.message)||err})`);
    return false;
  }
  dayIssueEditingId=null;
  await refreshDateIndex();
  if(dayIssueDate) await renderDayIssues(dayIssueDate);
  if(typeof renderCalendarGrid==='function'&&currentTab==='calendar') renderCalendarGrid();
  return true;
}
