// ══════════════════════════════════════════════════════════
//  auto-import-view — 데이터 관리 › 주행기록 자동 가져오기 (데스크톱 전용)
//
//  실제 확인·가져오기는 메인 프로세스(electron/auto-import.js)가 한다. 이 화면은
//    · 폴더 선택 / ON·OFF / 지금 확인 / 최초 연결 결정(전체 · 새 파일만)
//    · 처리 현황("새 파일 3개 반영 / 이미 처리 2개 / 실패 1개")과 파일별 이력 · 실패 재시도
//  만 맡는다.
//
//  새 파일이 반영되면 메인이 'autoImport:changed' 를 보낸다 → 수동 불러오기·서버 동기화와 같은
//  경로로 캐시를 무효화하고(RouteDB.notifyChange) 날짜 색인을 다시 읽은 뒤, 지금 보고 있는 화면만
//  다시 그린다. 열어 둔 날짜·차량 탭(daySummaryTab)·통계/누적 지도 필터는 건드리지 않는다.
// ══════════════════════════════════════════════════════════

let autoImportStatus=null;
let autoImportPreviewInfo=null;   // 최초 연결 결정 전 — 대상 파일 수
let autoImportShowAll=false;      // 처리 이력을 전부 펼쳐 볼지
let autoImportVisibleFiles=[];    // 지금 그려진 이력 — [다시 시도] 버튼이 순번으로 찾는다
let desktopPrefs=null;            // Windows 시작 시 자동 실행 · 창 닫으면 트레이로 (electron/main.js)

// 확인 간격 고르기 — 자동 가져오기는 15초~1시간 사이로 받는다(electron/auto-import.js)
const AUTO_IMPORT_INTERVALS=[[30,'30초'],[60,'1분'],[300,'5분'],[600,'10분'],[1800,'30분']];
function intervalLabel(sec){
  const hit=AUTO_IMPORT_INTERVALS.find(([v])=>v===sec);
  if(hit) return hit[1];
  return sec%60===0?`${sec/60}분`:`${sec}초`;
}

function autoImportAvailable(){ return !!(window.routeAPI&&window.routeAPI.isDesktop&&window.routeAPI.autoImportStatus); }

async function renderAutoImportPanel(){
  const el=document.getElementById('auto-import-panel');
  if(!el) return;
  if(!autoImportAvailable()){ el.style.display='none'; return; }
  el.style.display='flex';
  try{ autoImportStatus=await window.routeAPI.autoImportStatus(); }
  catch(err){ el.innerHTML=`<div class="ir-note warn">자동 가져오기 상태를 읽지 못했어요. (${escapeHtml(err.message)})</div>`; return; }
  paintDriveBadge();
  if(window.routeAPI.getDesktopPrefs){
    try{ desktopPrefs=await window.routeAPI.getDesktopPrefs(); }catch(_){ desktopPrefs=null; }
  }
  if(autoImportStatus.needsDecision&&!autoImportPreviewInfo){
    try{ autoImportPreviewInfo=await window.routeAPI.autoImportPreview(); }catch(_){ autoImportPreviewInfo=null; }
  }
  paintAutoImportPanel();
}

const AUTO_IMPORT_STATUS_LABELS={
  imported:['반영','ok'], already:['이미 처리','dim'], failed:['실패','bad'], pending:['동기화 대기','wait'],
  baseline:['건너뜀(최초 연결)','dim'], queued:['대기','wait'],
};

// '2026-10-02' → '2026년 10월 2일'
function koreanDate(d){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d||''));
  return m?`${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`:String(d||'');
}

// Google Drive 에서 몇 년 몇 월 며칠 주행분까지 가져왔나 — 처리 현황 패널과 달력 맨 위에 같이 보여준다
function driveLatestHTML(st,compact){
  if(!st||!st.folder) return '';
  const latest=st.latest||{};
  const err=st.lastResult&&st.lastResult.folderError;
  const head=latest.latestDate
    ? `Google Drive <b>${escapeHtml(koreanDate(latest.latestDate))}</b> 주행분까지 가져왔어요`
    : (st.needsDecision?'Google Drive 폴더를 연결했어요 — 가져오기 방식을 골라주세요':'Google Drive 에서 아직 가져온 주행 기록이 없어요');
  const parts=[];
  if(latest.lastNewFileAt) parts.push(`마지막 새 파일 ${escapeHtml(formatBackupTime(latest.lastNewFileAt))}${compact?'':(latest.lastNewFileName?` (${escapeHtml(latest.lastNewFileName)})`:'')}`);
  if(st.lastCheckAt) parts.push(`확인 ${escapeHtml(formatBackupTime(st.lastCheckAt))}`);
  if(!st.enabled) parts.push('자동 가져오기 꺼짐');
  if(err) parts.push('<span class="ai-warn">폴더 연결 안 됨</span>');
  return `${head}${parts.length?` <span class="ai-dim">· ${parts.join(' · ')}</span>`:''}${driveVehicleLineHTML(latest,compact)}`;
}

// '2026-10-02' 와 '2026-10-08' 사이 날짜 수
function daysBetween(a,b){
  const t=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10));
  return Math.round((t(b)-t(a))/86400000);
}

// 차량별 마지막 주행 날짜 — 가장 늦은 날짜보다 뒤처진 차량은 "N일 전"으로 눈에 띄게(아직 안 올렸을 수 있다)
function driveVehicleLineHTML(latest,compact){
  const list=(latest&&latest.byVehicle)||[];
  if(!list.length) return '';
  const top=latest.latestDate;
  const items=list.map(v=>{
    const name=v.vehicle||'차량 정보 없음';
    const m=/^\d{4}-(\d{2})-(\d{2})$/.exec(v.latestDate||'');
    const date=compact&&m?`${Number(m[1])}/${Number(m[2])}`:koreanDate(v.latestDate);
    const behind=top&&v.latestDate&&v.latestDate<top?daysBetween(v.latestDate,top):0;
    return `<span class="ai-veh${behind?' behind':''}" title="${escapeHtml(name)} — ${escapeHtml(v.latestDate||'')}${behind?` · 가장 최근보다 ${behind}일 이전`:''}">${escapeHtml(name)} <b>${escapeHtml(date)}</b>${behind?` <small>(${behind}일 전)</small>`:''}</span>`;
  });
  return `<div class="ai-veh-line">${compact?'':'<span class="ai-dim">차량별 마지막 주행</span> '}${items.join('<span class="ai-dim"> · </span>')}</div>`;
}

// 달력 맨 위 "전체 데이터 수집 현황" 옆 한 줄
function paintDriveBadge(){
  const el=document.getElementById('cp-drive');
  if(!el) return;
  const html=autoImportAvailable()?driveLatestHTML(autoImportStatus,true):'';
  el.innerHTML=html;
  el.style.display=html?'':'none';
}

// "새 파일 3개 반영 / 이미 처리 2개 / 실패 1개"
function autoImportSummaryText(r){
  if(!r) return '';
  const parts=[`새 파일 ${fmtNum(r.newImported||0)}개 반영`,`이미 처리 ${fmtNum(r.alreadyProcessed||0)}개`,`실패 ${fmtNum(r.failed||0)}개`];
  if(r.pending) parts.push(`동기화 대기 ${fmtNum(r.pending)}개`);
  return parts.join(' / ');
}

function paintAutoImportPanel(){
  paintDriveBadge();
  const el=document.getElementById('auto-import-panel');
  const st=autoImportStatus;
  if(!el||!st) return;
  const last=st.lastResult;
  const counts=st.counts||{};
  const running=!!st.running;
  const lastText=running?'확인 중…':(st.lastCheckAt?`마지막 확인: ${formatBackupTime(st.lastCheckAt)}`:'아직 확인한 적 없어요');

  let banner='';
  if(st.folder&&st.needsDecision){
    const n=autoImportPreviewInfo?autoImportPreviewInfo.fileCount:(last&&last.fileCount);
    banner=`<div class="ai-decision">
      <div><b>처음 연결한 폴더예요.</b> 하위 폴더까지 주행기록 파일 <b>${n!=null?fmtNum(n):'…'}개</b>가 있어요.
        과거 파일까지 모두 가져올지, 지금부터 새로 올라오는 파일만 가져올지 골라주세요.
        ${autoImportPreviewInfo&&autoImportPreviewInfo.knownCount?`<br/><span class="ai-dim">(이 중 ${fmtNum(autoImportPreviewInfo.knownCount)}개는 이미 처리한 파일이에요)</span>`:''}
        <br/><span class="ai-dim">이미 넣었던 파일(수동 불러오기 포함)은 내용이 같으면 다시 넣지 않아요.</span></div>
      <div class="ai-decision-actions">
        <button class="btn" type="button" onclick="confirmAutoImportInitial('all')">전체 가져오기${n!=null?` (${fmtNum(n)}개)`:''}</button>
        <button class="btn ghost" type="button" onclick="confirmAutoImportInitial('new')">지금부터 새 파일만</button>
      </div>
    </div>`;
  }
  const folderError=last&&last.folderError
    ? `<div class="ir-note warn">${escapeHtml(last.folderError)}</div>` : '';
  const summary=(!st.needsDecision&&last&&last.ok&&!last.needsDecision)
    ? `<div class="ai-summary mono">${escapeHtml(autoImportSummaryText(last))}
        ${counts.baseline?`<span class="ai-dim"> · 최초 연결 때 건너뛴 파일 ${fmtNum(counts.baseline)}개 <button type="button" class="ai-link" onclick="importAutoImportBaseline()">가져오기</button></span>`:''}
        ${counts.missing?`<span class="ai-dim"> · 폴더에서 사라진 파일 ${fmtNum(counts.missing)}개(기록은 그대로)</span>`:''}
        ${last.walkErrors&&last.walkErrors.length?`<span class="ai-dim"> · 읽지 못한 하위 폴더 ${fmtNum(last.walkErrors.length)}개</span>`:''}
      </div>` : '';

  const files=st.files||[];
  const visible=autoImportShowAll?files:files.filter(f=>f.status!=='baseline').slice(0,30);
  autoImportVisibleFiles=visible;
  const list=files.length
    ? `<div class="ai-files">${visible.map((f,i)=>autoImportFileRowHTML(f,i)).join('')||'<div class="dc-empty">표시할 파일이 없어요.</div>'}</div>
       ${files.length>visible.length||autoImportShowAll?`<button type="button" class="ai-link" onclick="toggleAutoImportShowAll()">${autoImportShowAll?'접기':`전체 ${fmtNum(files.length)}개 보기`}</button>`:''}`
    : '';

  el.innerHTML=`
    <div class="sync-head">
      <div class="sync-title">주행기록 자동 가져오기</div>
      <div class="sync-sub">Google Drive 데스크톱 앱이 이 PC 에 동기화한 <b>폴더</b>를 선택하면, 그 안(하위 폴더 포함)의
        .xlsx · .xls · .csv 파일을 앱 시작 때와 ${escapeHtml(intervalLabel(st.intervalSec||60))}마다 확인해서 기존 기록에 <b>추가</b>해요.
        Drive 웹 주소가 아니라 파일 탐색기에서 보이는 폴더를 고르세요. 원본 파일은 읽기만 하고 옮기거나 지우지 않아요.</div>
    </div>
    <div class="sync-row">
      <span class="sync-label">폴더</span>
      <code class="ai-folder" title="${escapeHtml(st.folder||'')}">${st.folder?escapeHtml(st.folder):'선택 안 됨'}</code>
      <button class="btn ghost" type="button" onclick="pickAutoImportFolder()">${st.folder?'폴더 변경':'폴더 선택'}</button>
      ${st.folder?'<button class="btn ghost" type="button" onclick="window.routeAPI.autoImportRevealFolder()">열기</button>':''}
    </div>
    <div class="sync-row">
      <label class="sync-checkbox">
        <input type="checkbox" id="auto-import-enabled" ${st.enabled?'checked':''} ${st.folder?'':'disabled'} onchange="setAutoImportEnabled(this.checked)"/>
        자동 가져오기 켜기 (앱 시작 시 + ${escapeHtml(intervalLabel(st.intervalSec||60))}마다)
      </label>
      <label class="sync-checkbox">확인 간격
        <select class="dm-issue-select" onchange="setAutoImportInterval(this.value)" ${st.folder?'':'disabled'}>
          ${(AUTO_IMPORT_INTERVALS.some(([v])=>v===(st.intervalSec||60))?AUTO_IMPORT_INTERVALS:[...AUTO_IMPORT_INTERVALS,[st.intervalSec,intervalLabel(st.intervalSec)]])
            .map(([v,l])=>`<option value="${v}"${v===(st.intervalSec||60)?' selected':''}>${escapeHtml(l)}</option>`).join('')}
        </select>
      </label>
    </div>
    ${desktopPrefsRowHTML()}
    ${st.folder?`<div class="ai-latest">${driveLatestHTML(st,false)}</div>`:''}
    ${banner}${folderError}
    <div class="sync-actions">
      <button class="btn" type="button" id="auto-import-run-btn" onclick="runAutoImportNow()" ${(!st.folder||running||st.needsDecision)?'disabled':''}>${running?'확인 중…':'지금 확인'}</button>
      ${counts.failed?`<button class="btn ghost" type="button" onclick="retryAutoImport()">실패 파일 다시 시도 (${fmtNum(counts.failed)})</button>`:''}
      <span class="sync-last mono">${escapeHtml(lastText)}</span>
    </div>
    ${summary}
    ${st.reviewPending?`<div class="ai-summary"><span class="issue-badge review">검토 전 ${fmtNum(st.reviewPending)}</span>
      <span class="ai-dim">이슈 여부를 아직 확인하지 않은 파일 — 아래 이슈 관리에서 하나씩 보거나</span>
      <button type="button" class="ai-link" onclick="reviewAllPendingImports()">모두 검토 완료</button></div>`:''}
    ${list}`;
}

// 앱이 꺼져 있으면 자동 가져오기도 멈춘다 — 계속 돌게 하는 두 가지 실행 옵션
function desktopPrefsRowHTML(){
  const p=desktopPrefs;
  if(!p) return '';
  return `<div class="sync-row ai-prefs">
      <label class="sync-checkbox" title="${p.canOpenAtLogin?'PC 를 켜면 창 없이 트레이에서 시작해 자동 가져오기를 해요':'설치한 앱에서만 켤 수 있어요(지금은 개발 버전으로 실행 중)'}">
        <input type="checkbox" ${p.openAtLogin?'checked':''} ${p.canOpenAtLogin?'':'disabled'} onchange="setDesktopPref('openAtLogin',this.checked)"/>
        Windows 시작 시 자동 실행 (트레이에서 조용히)${p.canOpenAtLogin?'':' <span class="ai-dim">— 설치판에서만</span>'}
      </label>
      <label class="sync-checkbox" title="[X] 를 눌러도 꺼지지 않고 작업 표시줄 트레이에 남아 자동 가져오기를 계속해요. 완전히 끄려면 트레이 아이콘 › 종료">
        <input type="checkbox" ${p.closeToTray?'checked':''} onchange="setDesktopPref('closeToTray',this.checked)"/>
        창을 닫으면 트레이로 숨기기 (자동 가져오기 계속)
      </label>
    </div>`;
}

async function setDesktopPref(key,on){
  try{
    desktopPrefs=await window.routeAPI.setDesktopPrefs({[key]:!!on});
    paintAutoImportPanel();
    if(key==='closeToTray'&&on) showToast('이제 창을 닫아도 트레이에서 자동 가져오기를 계속해요.');
    if(key==='openAtLogin'&&on) showToast('PC 를 켜면 트레이에서 자동으로 시작해요.');
  }catch(err){
    showError('실행 옵션을 바꾸지 못했어요. ('+err.message+')');
    await renderAutoImportPanel();
  }
}

async function setAutoImportInterval(sec){
  try{ autoImportStatus=await window.routeAPI.autoImportSetInterval(Number(sec)); paintAutoImportPanel(); }
  catch(err){ showError('확인 간격을 저장하지 못했어요. ('+err.message+')'); }
}

function autoImportFileRowHTML(f,i){
  const [label,cls]=AUTO_IMPORT_STATUS_LABELS[f.status]||[f.status||'—','dim'];
  const dates=f.dates.length>3?`${f.dates[0]} … ${f.dates[f.dates.length-1]} (${f.dates.length}일)`:f.dates.join(', ');
  const nums=f.status==='imported'
    ? `<span class="ir-add">+${fmtNum(f.inserted)}</span>${f.duplicates?`<span class="ir-dup">중복 ${fmtNum(f.duplicates)}</span>`:''}`
    : (f.status==='already'?`<span class="ai-dim">같은 내용${f.duplicateOf&&f.duplicateOf!==f.name?`: ${escapeHtml(f.duplicateOf)}`:''}</span>`:'');
  // 자동으로 들어와 아직 아무도 이슈 여부를 보지 않은 파일 — "이슈 없음(확인)"으로 보이지 않게 따로 표시
  const review=f.status==='imported'&&f.importId!=null
    ? (f.hasIssue?issueBadgeHtml(f.issueStatus):(f.needsReview?'<span class="issue-badge review" title="자동으로 가져온 파일이라 아직 사람이 이슈 여부를 확인하지 않았어요">검토 전</span>':''))
    : '';
  const when=f.processedAt||f.lastSeenAt;
  return `
    <div class="ai-file ${cls}${f.missing?' missing':''}">
      <div class="ai-file-row1">
        <span class="ai-status ${cls}">${escapeHtml(label)}</span>
        <span class="ai-file-name" title="${escapeHtml(f.relPath||f.name)}">${escapeHtml(f.name)}</span>
        ${review}
        ${f.missing?'<span class="ai-dim">폴더에 없음</span>':''}
        <span class="mono ai-file-nums">${nums}</span>
      </div>
      <div class="ai-file-row2 mono">
        ${dates?`<span>${escapeHtml(dates)}</span>`:''}
        ${f.vehicles.length?`<span>${escapeHtml(f.vehicles.join(', '))}</span>`:''}
        ${f.relPath&&f.relPath!==f.name?`<span title="폴더 안 위치">${escapeHtml(f.relPath)}</span>`:''}
        <span class="ai-at">${f.status==='imported'?'가져온 시각 ':''}${escapeHtml(when?formatBackupTime(when):'')}</span>
        ${f.status==='failed'?`<button type="button" class="ai-link" onclick="retryAutoImportFile(${i})">다시 시도</button>`:''}
      </div>
      ${f.reason&&f.status!=='baseline'?`<div class="ai-reason">${escapeHtml(f.reason)}${f.attempts>1?` · 시도 ${fmtNum(f.attempts)}회`:''}</div>`:''}
    </div>`;
}

function toggleAutoImportShowAll(){ autoImportShowAll=!autoImportShowAll; paintAutoImportPanel(); }

async function pickAutoImportFolder(){
  let res;
  try{ res=await window.routeAPI.autoImportPickFolder(); }
  catch(err){ showError('폴더를 연결하지 못했어요. '+err.message.replace(/^Error:\s*/,'')); return; }
  if(!res) return;   // 취소
  autoImportPreviewInfo=res.preview;
  autoImportStatus=res.status;
  paintAutoImportPanel();
  if(res.status.needsDecision) showAutoImportDecision(res.preview);
}

// 최초 연결 — 대상 파일 수를 보여주고 전체 가져오기 여부를 고르게 한다
function showAutoImportDecision(preview){
  const n=preview?preview.fileCount:0;
  openModal({
    title:'자동 가져오기 폴더 연결',
    icon:'⇣',
    body:`
      <table class="ir-table">
        <tr><td class="ir-k">폴더</td><td class="ir-v mono">${escapeHtml(preview.folder||'')}</td></tr>
        <tr><td class="ir-k">주행기록 파일</td><td class="ir-v mono"><b>${fmtNum(n)}개</b> <span style="color:var(--text-faint);">(하위 폴더 포함 · 임시 파일 제외)</span></td></tr>
      </table>
      <div class="ir-note">과거 파일이 많으면 처음 한 번은 시간이 걸릴 수 있어요. 이미 넣었던 파일은 내용이 같으면 다시 넣지 않고,
        같은 GPS 기록은 자동으로 걸러져요. 가져온 파일은 <b>"검토 전"</b>으로 표시되고, 이슈 여부는 나중에 데이터 관리에서 정할 수 있어요.</div>`,
    buttons:[
      {label:'나중에 정하기',onClick:closeModal},
      {label:'지금부터 새 파일만',onClick:()=>{ closeModal(); confirmAutoImportInitial('new'); }},
      {label:`전체 가져오기 (${fmtNum(n)}개)`,primary:true,onClick:()=>{ closeModal(); confirmAutoImportInitial('all'); }},
    ],
  });
}

async function confirmAutoImportInitial(mode){
  autoImportPreviewInfo=null;
  await runAutoImportAction(()=>window.routeAPI.autoImportConfirmInitial(mode),true);
}

async function setAutoImportEnabled(on){
  try{ autoImportStatus=await window.routeAPI.autoImportSetEnabled(!!on); paintAutoImportPanel(); }
  catch(err){ showError('자동 가져오기 설정을 저장하지 못했어요. ('+err.message+')'); }
}

async function runAutoImportNow(){ await runAutoImportAction(()=>window.routeAPI.autoImportRunNow(),true); }
async function retryAutoImport(pathKeys){ await runAutoImportAction(()=>window.routeAPI.autoImportRetry(pathKeys||null),true); }
async function retryAutoImportFile(i){
  const f=autoImportVisibleFiles[i];
  if(f) await retryAutoImport([f.pathKey]);
}
async function importAutoImportBaseline(){ await runAutoImportAction(()=>window.routeAPI.autoImportBaseline(),true); }

// 버튼으로 실행 — 결과 요약을 토스트로 보여준다(새로 반영한 파일의 화면 갱신은 'changed' 알림이 맡는다)
async function runAutoImportAction(fn,announce){
  if(autoImportStatus){ autoImportStatus.running=true; paintAutoImportPanel(); }
  let res=null;
  try{ res=await fn(); }
  catch(err){ showError('자동 가져오기를 실행하지 못했어요. ('+err.message+')'); }
  await renderAutoImportPanel();
  if(announce&&res){
    if(res.folderError) showToast('폴더에 접근할 수 없어요 — 기존 기록은 그대로예요.');
    else if(res.ok&&!res.needsDecision) showToast(autoImportSummaryText(res));
  }
  return res;
}

// ── 새 파일이 반영됐다는 알림 → 필요한 화면만 갱신 ───────────────
async function onAutoImportChanged(res){
  // 수동 불러오기와 같은 신호 — 누적 지도 Coverage·추천·KPI 캐시가 이걸 듣고 무효화한다
  RouteDB.notifyChange('importRecords',[]);
  await refreshDateIndex();
  const dayOpen=document.getElementById('console').style.display!=='none'&&currentSource==='day';
  const openDate=dayOpen?document.getElementById('chip-filename').textContent:'';
  try{
    // 열어 둔 날짜 상세(지도·재생 위치·차량 탭)는 다시 불러오지 않는다 — 달력으로 돌아가면 새 값이 보인다
    if(dayOpen) renderCalendarGrid();
    else if(currentTab==='calendar'){ renderCalendarGrid(); updateCalStatus(); }
    else if(currentTab==='accum') renderAccumView();
    else if(currentTab==='stats') renderStatsView();
    else if(currentTab==='recommend') renderRecommendView();
    else if(currentTab==='data') await renderDataView();
    else if(currentTab==='upload') updateDropzoneSummary();
  }catch(err){ console.warn('[경로뷰어] 자동 가져오기 후 화면 갱신 실패:',err); }
  updateBackupStatus();
  const touchesOpen=openDate&&(res.dates||[]).includes(openDate);
  showToast(`자동 가져오기 · 새 파일 ${fmtNum(res.newImported)}개 반영 · 기록 +${fmtNum(res.insertedRecords||0)}`
    +(touchesOpen?` (보고 있는 ${openDate} 포함 — 다시 열면 반영돼요)`:''));
}

if(autoImportAvailable()){
  window.routeAPI.onAutoImport('changed',res=>{ onAutoImportChanged(res||{}); });
  window.routeAPI.onAutoImport('status',st=>{
    if(!st) return;
    autoImportStatus=st;
    if(currentTab==='data') paintAutoImportPanel();
    else paintDriveBadge();
  });
  // 앱을 켜자마자 달력에 "몇 월 며칠까지" 를 보여준다(자동 확인이 돌기 전 저장된 이력 기준)
  window.routeAPI.autoImportStatus().then(st=>{ autoImportStatus=st; paintDriveBadge(); }).catch(()=>{});
}
