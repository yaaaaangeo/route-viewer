// ══════════════════════════════════════════════════════════
//  career-log-view — 개인용 "Project Impact / Career Log" 화면
//
//  진입: 헤더 왼쪽 위 양(🐑)을 3초 안에 5번 누르면 열리고, 다시 5번 누르거나 ✕ 로 닫힌다.
//    · 탭·메뉴·설정 어디에도 버튼을 두지 않는다. 열린 상태는 저장하지 않아서 앱을 다시 켜면 닫혀 있다.
//    · 양 1번 클릭에는 원래 아무 동작이 없고, 여기서도 그 클릭을 막거나 바꾸지 않는다(세기만 한다).
//    · 보안 기능이 아니라 이스터에그다.
//
//  계산은 career-metrics.js, 측정·Snapshot 은 kpi-history.js — 여기서는 그리기와 입력만 한다.
//  모든 데이터는 이 PC 의 SQLite/IndexedDB 에만 있다(백업·서버 동기화 대상 아님, 외부 전송 없음).
// ══════════════════════════════════════════════════════════
const CAREER_CLICKS_NEEDED=5;
const CAREER_CLICK_WINDOW_MS=3000;
let careerOpen=false;
let careerMeasured=null;     // KpiHistory.measure() 결과
let careerStore={kpiSnapshots:[],collectionPlans:[],contributions:[],workTimes:[]};
let careerMeasuring=false;
let careerMeasureError=null;
let careerMeasurePromise=null;
// detailsOpen: "상세 보기"를 펼쳤는지 — 이번 실행 동안만 기억한다(저장하지 않음)
const careerUi={contribOrder:'desc',onlyDeficit:false,planEditor:null,contribEdit:null,contribFormOpen:false,detailsOpen:false,quickDraft:'',quickSaving:false,quickError:null};

const clEsc=s=>escapeHtml(s==null?'':s);
const clNum=n=>Number.isFinite(n)?Math.round(n).toLocaleString('en-US'):'—';
const clPct=n=>Number.isFinite(n)?`${(Math.round(n*10)/10).toFixed(1)}%`:'—';

// ── 이스터에그 ─────────────────────────────────────────
(function initCareerEasterEgg(){
  const mark=document.querySelector('header .brand-mark');
  if(!mark) return;
  const clicks=[];
  mark.addEventListener('click',()=>{
    const now=Date.now();
    clicks.push(now);
    while(clicks.length&&now-clicks[0]>CAREER_CLICK_WINDOW_MS) clicks.shift();
    if(clicks.length<CAREER_CLICKS_NEEDED) return;
    clicks.length=0;
    if(careerOpen) closeCareerLog();
    else{
      openCareerLog();
      if(typeof showToast==='function') showToast('🐑 Career Log unlocked');
    }
  });
})();

function openCareerLog(){
  if(typeof CareerMetrics==='undefined'||typeof KpiHistory==='undefined') return;
  careerOpen=true;
  KpiHistory.enableOnFirstUnlock();
  let el=document.getElementById('career-overlay');
  if(!el){
    el=document.createElement('div');
    el.id='career-overlay';
    el.className='cl-overlay';
    el.setAttribute('role','dialog');
    el.setAttribute('aria-label','Project Impact');
    el.addEventListener('click',onCareerClick);
    el.addEventListener('change',onCareerChange);
    el.addEventListener('submit',e=>e.preventDefault());
    // 메모 칸에서 Ctrl(⌘)+Enter = 저장
    el.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&e.target&&e.target.dataset&&e.target.dataset.quick==='memo'){
        e.preventDefault();
        careerSaveQuickNote();
      }
    });
    document.body.appendChild(el);
  }
  el.classList.add('show');
  document.addEventListener('keydown',onCareerKeydown);
  renderCareerLog();
  // 열자마자 바로 쓸 수 있게 메모 칸에 커서
  const memo=el.querySelector('[data-quick="memo"]');
  if(memo) memo.focus();
  refreshCareerLog();
}

function closeCareerLog(){
  careerOpen=false;
  const el=document.getElementById('career-overlay');
  // 닫으면 DOM 을 지운다 — 개인 기록이 화면 뒤에 남아 있지 않게
  if(el) el.remove();
  document.removeEventListener('keydown',onCareerKeydown);
  careerUi.planEditor=null; careerUi.contribEdit=null; careerUi.contribFormOpen=false;
}

function onCareerKeydown(e){
  if(e.key!=='Escape') return;
  const modal=document.getElementById('modal-backdrop');
  if(modal&&modal.classList.contains('show')) return; // 공용 모달이 먼저 닫힌다
  closeCareerLog();
}

// 저장된 기록을 다시 읽고, 지금 상태를 측정한다(저장은 하지 않는다 — 저장은 "현재 상태 기록")
async function refreshCareerLog(){
  try{ careerStore=await KpiHistory.loadStore(); }
  catch(err){ console.warn('[경로뷰어] Career Log 읽기 실패:',err); }
  renderCareerLog();
  if(careerMeasuring) return careerMeasurePromise;
  careerMeasuring=true; careerMeasureError=null;
  renderCareerLog();
  careerMeasurePromise=(async()=>{
    try{
      careerMeasured=await KpiHistory.measure();
      // 열었을 때 오늘 Snapshot 이 없으면 한 번 자동으로 남긴다(기록이 한 건도 없으면 남길 것도 없다)
      if(!careerStore.kpiSnapshots.some(s=>s.date===careerMeasured.date)&&careerMeasured.scale.raw.recordCount>0){
        await KpiHistory.recordSnapshot('auto-open',careerMeasured);
        careerStore=await KpiHistory.loadStore();
      }
    }catch(err){ careerMeasureError=(err&&err.message)||String(err); console.warn('[경로뷰어] Career Log 측정 실패:',err); }
    careerMeasuring=false;
    careerMeasurePromise=null;
    if(careerOpen) renderCareerLog();
  })();
  return careerMeasurePromise;
}

async function reloadCareerStore(){
  careerStore=await KpiHistory.loadStore();
  if(careerOpen) renderCareerLog();
}

// ══════════════════════════════════════════════════════════
//  그리기
// ══════════════════════════════════════════════════════════
const CAREER_SECTIONS=[
  ['cl-scale','Project Scale'],['cl-depth','Coverage Depth'],['cl-fulfill','Scenario Fulfillment'],
  ['cl-deficit','Deficit Trend'],['cl-plans','Collection Plans'],['cl-contrib','Contribution Log'],
  ['cl-auto','Automation Impact'],['cl-snapshots','Snapshot History'],['cl-resume','Impact Summary'],
];

// 다시 그리면 입력칸이 새로 만들어진다 — 측정이 끝나 화면이 바뀌어도 쓰던 내용이 날아가지 않게 먼저 옮겨 둔다.
// reset: 방금 상태를 바꾼 폼('plan'|'contrib'|'work') — 그 폼만 화면 값을 다시 읽지 않는다
function careerCaptureDrafts(reset){
  if(reset!=='plan') careerSyncPlanEditor();
  const read=(sel,attr)=>{
    const root=document.querySelector(sel);
    if(!root) return null;
    const out={};
    root.querySelectorAll(`[data-${attr}]`).forEach(inp=>{ out[inp.dataset[attr]]=inp.value; });
    return out;
  };
  const contrib=reset==='contrib'?null:read('#cl-contrib .cl-editor','contrib');
  if(contrib) careerUi.contribDraft=contrib;
  const work=reset==='work'?null:read('#cl-auto .cl-editor','work');
  if(work) careerUi.workDraft=work;
  const quick=reset==='quick'?null:document.querySelector('#career-overlay [data-quick="memo"]');
  if(quick) careerUi.quickDraft=quick.value;
}

// options.reset: 막 열거나 닫거나 바꾼 폼 — 그 폼은 화면 값 대신 상태(careerUi)로 그린다
function renderCareerLog(options){
  const el=document.getElementById('career-overlay');
  if(!el||!careerOpen) return;
  careerCaptureDrafts(options&&options.reset);
  const scrollTop=el.querySelector('.cl-panel')?el.querySelector('.cl-panel').scrollTop:0;
  // 메모를 쓰는 중에 측정이 끝나 다시 그려져도 커서가 그대로 있게
  const active=document.activeElement;
  const quickFocus=active&&active.dataset&&active.dataset.quick==='memo'?{start:active.selectionStart,end:active.selectionEnd}:null;
  const m=careerMeasured;
  const snaps=CareerMetrics.sortSnapshots(careerStore.kpiSnapshots);
  const last=snaps[snaps.length-1];
  // 상세 보기 안은 펼쳤을 때만 그린다(기본 화면을 가볍게)
  const details=careerUi.detailsOpen?`
      <div class="cl-actions cl-more-actions">
        <button class="btn ghost" type="button" data-act="snapshot" ${careerMeasuring?'disabled':''} title="지금 측정한 값을 오늘 날짜 Snapshot 으로 저장(같은 날짜는 최신 값으로 갱신)">현재 상태 기록</button>
        <button class="btn ghost" type="button" data-act="remeasure" ${careerMeasuring?'disabled':''}>↻ 다시 측정</button>
        <span class="cl-sep"></span>
        <button class="btn ghost" type="button" data-act="export" data-format="json" title="career-log-YYYYMMDD.json — 집계 수치와 직접 쓴 기록만(원본 GPS 좌표 없음)">JSON</button>
        <button class="btn ghost" type="button" data-act="export" data-format="csv" title="career-metrics-YYYYMMDD.csv — 날짜별 KPI Snapshot">CSV</button>
        <button class="btn ghost" type="button" data-act="export" data-format="md" title="career-summary-YYYYMMDD.md — Impact Summary · 기록">Markdown</button>
        <button class="btn ghost" type="button" data-act="import" title="예전에 Export 한 career-log JSON 을 다시 넣기(같은 기록은 건너뜀)">가져오기</button>
        <label class="cl-check" title="하루 1회(앱 실행 중) · 주행기록 Import 뒤에 자동으로 Snapshot 을 남겨요 — 이 PC 에서만"><input type="checkbox" data-act="auto" ${KpiHistory.autoEnabled()?'checked':''}/> 자동 기록</label>
      </div>
      <div class="cl-meta mono">${careerMetaHTML(m,last)}</div>
      <nav class="cl-nav">${CAREER_SECTIONS.map(([id,label])=>`<button type="button" class="zone-btn" data-act="goto" data-target="${id}">${label}</button>`).join('')}</nav>
      ${careerScaleHTML(m)}
      ${careerDepthHTML(m,snaps)}
      ${careerFulfillHTML(m,snaps)}
      ${careerDeficitHTML(snaps)}
      ${careerSnapshotHistoryHTML(snaps)}
      ${careerPlansHTML(m)}
      ${careerContribHTML()}
      ${careerAutomationHTML()}
      ${careerResumeHTML(m,snaps)}`:'';
  el.innerHTML=`<div class="cl-panel cl-notebook${careerUi.detailsOpen?' cl-wide':''}">
    <div class="cl-head">
      <div class="cl-title">🐑 Project Impact <span class="cl-sub">notebook · 이 PC에만 저장돼요</span></div>
      <div class="cl-actions">
        <span class="cl-status mono">${careerStatusText()}</span>
        <button class="btn ghost cl-close" type="button" data-act="close" title="닫기 (Esc)">✕</button>
      </div>
    </div>
    ${careerMonthHTML(m)}
    ${careerChangeHTML(snaps)}
    ${careerTodayHTML()}
    <details class="cl-more" ${careerUi.detailsOpen?'open':''}>
      <summary>상세 보기</summary>
      <div class="cl-more-body">${details}</div>
    </details>
    <input type="file" id="career-import-input" accept=".json" style="display:none"/>
  </div>`;
  const panel=el.querySelector('.cl-panel');
  if(panel) panel.scrollTop=scrollTop;
  const more=el.querySelector('details.cl-more');
  if(more) more.addEventListener('toggle',()=>{
    if(careerUi.detailsOpen===more.open) return;
    careerUi.detailsOpen=more.open;
    renderCareerLog();
  });
  if(quickFocus){
    const ta=el.querySelector('[data-quick="memo"]');
    if(ta){ ta.focus(); try{ ta.setSelectionRange(quickFocus.start,quickFocus.end); }catch(_){ /* 무시 */ } }
  }
}

function careerStatusText(){
  if(careerMeasuring) return '측정 중…';
  if(careerMeasureError) return '측정 실패';
  return careerMeasured?`${clEsc(careerMeasured.measuredAt.slice(11,16))} 기준`:'';
}

// ── 기본 화면 1) 이번 달 Project Scale ──────────────────
function careerMonthHTML(m){
  const s=m&&m.monthScale;
  const month=s?`${Number(s.from.slice(5,7))}월`:'이번 달';
  const tile=(label,value,unit)=>`<div class="cl-big"><div class="cl-big-v mono">${value}<span class="cl-big-u">${unit}</span></div><div class="cl-big-k">${label}</div></div>`;
  const body=s
    ?`<div class="cl-bigs">
        ${tile('주행거리',clNum(s.distanceKm),' km')}
        ${tile('수집시간',clNum(s.collectionMinutes),' min')}
        ${tile('수집일',clNum(s.collectionDays),'일')}
        ${tile('차량',clNum(s.vehicleCount),'대')}
      </div>${s.recordCount?'':'<div class="cl-lite-sub">이번 달 주행 기록은 아직 없어요 · 전체 기간 규모는 상세 보기 → Project Scale</div>'}`
    :`<div class="cl-note">${careerMeasureError?clEsc('측정하지 못했어요 — '+careerMeasureError):'측정 중…'}</div>`;
  return `<section class="cl-card-lite"><div class="cl-lite-title">${clEsc(month)} Project Scale</div>${body}</section>`;
}

// ── 기본 화면 2) Impact 변화(월초 → 현재) ───────────────
function careerChangeHTML(snaps){
  const today=KpiHistory.today();
  const im=CareerMetrics.monthlyImpact(snaps,today);
  const row=(label,v,unit,lowerIsBetter)=>{
    if(!v) return `<div class="cl-chg"><span class="cl-chg-k">${clEsc(label)}</span><span class="cl-chg-v cl-dim">아직 값이 없어요</span></div>`;
    const u=unit==='%'?'%':'';
    const d=v.delta, good=lowerIsBetter?d<0:d>0;
    const dText=v.single?'기록 시작':`${d>0?'+':''}${unit==='%'?d.toFixed(1)+'%p':d+'개'}`;
    const fmt=x=>unit==='%'?x.toFixed(1)+u:String(Math.round(x));
    return `<div class="cl-chg"><span class="cl-chg-k">${clEsc(label)}</span>
      <span class="cl-chg-v mono">${v.single?'':`${fmt(v.from)} → `}${fmt(v.to)}</span>
      <span class="cl-chg-d mono ${v.single||d===0?'':good?'up':'down'}">${dText}</span></div>`;
  };
  const base=[im.coverage5x,im.fulfillment,im.deficit].find(Boolean);
  const basis=base?(base.fromDate<im.monthStart?`${base.fromDate} 기록 기준`:`이번 달 첫 기록 ${base.fromDate} 기준`):'';
  return `<section class="cl-card-lite"><div class="cl-lite-title">Impact 변화 <span class="cl-lite-sub">월초 → 현재${basis?` · ${clEsc(basis)}`:''}</span></div>
    ${row('5x Coverage',im.coverage5x,'%')}
    ${row('Scenario Fulfillment',im.fulfillment,'%')}
    ${row('Deficit Target',im.deficit,'n',true)}
  </section>`;
}

// ── 기본 화면 3) 오늘 내가 한 일 ────────────────────────
function careerTodayHTML(){
  const recent=CareerMetrics.sortContributions(careerStore.contributions,'desc').slice(0,5);
  const k=c=>{
    const a=c.kpiAtSave;
    if(!a) return '';
    const parts=[];
    if(Number.isFinite(a.coverage5x)) parts.push(`5x ${a.coverage5x.toFixed(1)}%`);
    if(Number.isFinite(a.fulfillmentPercent)) parts.push(`달성 ${a.fulfillmentPercent.toFixed(1)}%`);
    if(Number.isFinite(a.targetDeficit)) parts.push(`미달 ${a.targetDeficit}`);
    return parts.length?`<span class="cl-note-kpi mono">${parts.join(' · ')}</span>`:'';
  };
  const list=recent.map(c=>`<li><span class="cl-note-date mono">${clEsc(c.date.slice(5).replace('-','/'))}</span>
      <span class="cl-note-text">${clEsc(c.memo||c.problem)}</span>${k(c)}</li>`).join('');
  return `<section class="cl-card-lite"><div class="cl-lite-title">오늘 내가 한 일</div>
    <div class="cl-quick">
      <textarea class="cl-in cl-quick-in" data-quick="memo" rows="2" placeholder="예: ⑤ 구역 야간 데이터 부족으로 18~21시 우선 경로로 변경  (Ctrl+Enter 저장)">${clEsc(careerUi.quickDraft)}</textarea>
      <button class="btn" type="button" data-act="quick-save" ${careerUi.quickSaving?'disabled':''}>${careerUi.quickSaving?'저장 중…':'저장'}</button>
    </div>
    ${careerUi.quickError?`<div class="cl-note cl-warn">${clEsc(careerUi.quickError)}</div>`:''}
    <div class="cl-lite-sub">저장할 때 그 시점의 Coverage · Fulfillment · Deficit · 수집시간 · 주행거리 · Plan 이 함께 남아요.</div>
    ${list?`<ul class="cl-notes">${list}</ul>`:''}
  </section>`;
}

async function careerSaveQuickNote(){
  if(careerUi.quickSaving) return;
  const ta=document.querySelector('#career-overlay [data-quick="memo"]');
  const memo=ta?ta.value:careerUi.quickDraft;
  if(!String(memo||'').trim()){ careerUi.quickError='기록할 내용을 입력해주세요.'; renderCareerLog(); return; }
  careerUi.quickSaving=true; careerUi.quickError=null; careerUi.quickDraft=memo;
  renderCareerLog();
  try{
    if(careerMeasurePromise) await careerMeasurePromise;       // 열 때 시작한 측정이 끝나기를 기다린다
    if(!careerMeasured) careerMeasured=await KpiHistory.measure();
    const snap=await KpiHistory.recordSnapshot('note',careerMeasured); // 오늘 Snapshot 도 이 시점 값으로 갱신
    const res=CareerMetrics.buildQuickNote({memo,snapshot:snap});
    if(!res.ok) throw new Error(res.errors.join(' '));
    await RouteDB.saveCareerItem('contributions',res.value);
    careerStore=await KpiHistory.loadStore();
    careerUi.quickDraft='';
    if(typeof showToast==='function') showToast('기록했어요');
  }catch(err){
    careerUi.quickError='저장하지 못했어요 — '+((err&&err.message)||err);
  }
  careerUi.quickSaving=false;
  renderCareerLog({reset:'quick'});
  const box=document.querySelector('#career-overlay [data-quick="memo"]');
  if(box&&!careerUi.quickError) box.focus();
}

// ── 상세: Snapshot History ─────────────────────────────
function careerSnapshotHistoryHTML(snaps){
  if(!snaps.length) return clSection('cl-snapshots','Snapshot History','','<div class="cl-note">아직 Snapshot 이 없어요.</div>');
  const n=v=>Number.isFinite(v)?v:'—';
  const p=v=>Number.isFinite(v)?v.toFixed(1)+'%':'—';
  const rows=snaps.slice().reverse().map(s=>`<tr><td class="mono">${clEsc(s.date)}</td><td class="cl-dim">${clEsc(s.source||'')}</td><td class="mono">${clEsc(s.planId||'—')}</td>
    <td class="cl-num mono">${p(s.coverage1x)}</td><td class="cl-num mono">${p(s.coverage5x)}</td><td class="cl-num mono">${p(s.fulfillmentPercent)}</td>
    <td class="cl-num mono">${n(s.targetDeficit)}</td><td class="cl-num mono">${Number.isFinite(s.collectionMinutes)?clNum(s.collectionMinutes):'—'}</td>
    <td class="cl-num mono">${n(s.updateCount)}</td></tr>`).join('');
  return clSection('cl-snapshots','Snapshot History','하루 한 줄 · 같은 날짜는 최신 값으로 갱신',`<div class="cl-table-wrap"><table class="cl-table">
    <thead><tr><th>날짜</th><th>기록 방식</th><th>Plan</th><th class="cl-num">1x</th><th class="cl-num">5x</th><th class="cl-num">Fulfillment</th><th class="cl-num">미달</th><th class="cl-num">수집시간(분)</th><th class="cl-num">갱신</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`);
}

function careerMetaHTML(m,last){
  const parts=[];
  if(careerMeasuring) parts.push('<span class="cl-wait">측정 중… (날짜 요약·①~⑫ 구역·Coverage 를 읽어요)</span>');
  else if(careerMeasureError) parts.push(`<span class="cl-warn">측정 실패 — ${clEsc(careerMeasureError)}</span>`);
  else if(m) parts.push(`측정 ${clEsc(m.measuredAt.slice(0,16).replace('T',' '))}`);
  parts.push('조건·Coverage 기준: 확인 필요 이슈 데이터 제외(추천과 같은 기준) · 규모: 전체 데이터');
  parts.push(last?`마지막 Snapshot ${clEsc(last.date)} (${clEsc(last.source||'manual')})`:'Snapshot 없음 — "현재 상태 기록"을 누르면 오늘 값이 남아요');
  return parts.join(' · ');
}

function clSection(id,title,sub,body){
  return `<section class="cl-section" id="${id}">
    <div class="cl-sec-head"><h3>${clEsc(title)}</h3>${sub?`<span class="cl-sec-sub">${sub}</span>`:''}</div>
    ${body}
  </section>`;
}

// 퍼센트 막대(0~100%로 자름) + 숫자
function clBar(v,ok,left){
  const w=Number.isFinite(v)?Math.max(0,Math.min(100,v)):0;
  return `<div class="cl-bar-cell${left?' cl-bar-left':''}"><span class="cl-mini-track"><span class="cl-mini-bar${ok?' ok':''}" style="width:${w}%"></span></span><span>${clPct(v)}</span></div>`;
}

function clInfo(text){
  return `<details class="cl-info"><summary title="${clEsc(text)}">ⓘ</summary><div>${clEsc(text)}</div></details>`;
}

// ── 1) Project Scale ───────────────────────────────────
function careerScaleHTML(m){
  if(!m) return clSection('cl-scale','Project Scale','',careerPendingHTML());
  const tiles=m.scale.items.map(it=>`<div class="cl-tile">
      <div class="cl-tile-k">${clEsc(it.label)} ${clInfo(it.basis)}</div>
      <div class="cl-tile-v mono">${clEsc(it.display)}</div>
    </div>`).join('');
  const note=m.scale.raw.missingSummaries?`<div class="cl-note cl-warn">수집 시간이 없는 예전 형식 날짜 요약 ${m.scale.raw.missingSummaries}개는 시간 합계에서 빠졌어요.</div>`:'';
  return clSection('cl-scale','Project Scale','기존 날짜 요약·Import 기록에서 자동 집계',`<div class="cl-tiles">${tiles}</div>${note}`);
}

function careerPendingHTML(){
  if(careerMeasureError) return `<div class="cl-note cl-warn">측정하지 못했어요 — ${clEsc(careerMeasureError)}</div>`;
  return '<div class="cl-note">측정 중…</div>';
}

// ── 2) Coverage Depth ──────────────────────────────────
function careerScopeOrder(m){
  const pz=(m.depthScopes||[]).map(String);
  const areaScopes=CareerMetrics.AREA_NOS.map(String).filter(s=>!pz.includes(s));
  return [...pz,...areaScopes,...(m.activeZones||[]).filter(z=>!pz.includes(z))];
}

function careerDepthHTML(m,snaps){
  if(!m) return clSection('cl-depth','Coverage Depth','',careerPendingHTML());
  const levels=CareerMetrics.DEPTH_LEVELS;
  const pz=new Set((m.depthScopes||[]).map(String));
  const cell=v=>`<td class="cl-num">${clBar(v,false)}</td>`;
  const scopes=careerScopeOrder(m);
  const reasonOf=scope=>{ const d=m.depth.byScope[scope]; return (d&&d.total)?null:(m.depth.notes[scope]||(d?'구역 안 유효 도로 칸이 없어요.':'—')); };
  // 여러 구역이 같은 이유로 비어 있으면 이유는 한 번만 적고, 행에는 짧은 상태만 둔다
  const reasonCount=new Map();
  scopes.forEach(s=>{ const r=reasonOf(s); if(r) reasonCount.set(r,(reasonCount.get(r)||0)+1); });
  const shared=[...reasonCount.entries()].filter(([,n])=>n>1).map(([r])=>r);
  const rows=scopes.map(scope=>{
    const d=m.depth.byScope[scope];
    const label=`${clEsc(CareerMetrics.scopeLabel(scope))}${pz.has(scope)?' <span class="cl-tag">Priority</span>':''}`;
    if(!d||!d.total){
      const reason=reasonOf(scope);
      const i=shared.indexOf(reason);
      const cellText=i>=0?`<span class="cl-badge cl-badge-na" title="${clEsc(reason)}">계산 필요</span> <span class="cl-dim">※${i+1}</span>`:clEsc(reason);
      return `<tr class="cl-muted"><td>${label}</td><td class="cl-num">—</td><td colspan="${levels.length}" class="cl-reason">${cellText}</td></tr>`;
    }
    return `<tr><td>${label}${d.provisional?' <span class="cl-tag cl-tag-warn" title="도로·건물 데이터를 못 받아 대체값으로 계산된 임시값">임시</span>':''}</td>
      <td class="cl-num mono">${clNum(d.total)}</td>${levels.map(k=>cell(d.percent[k])).join('')}</tr>`;
  }).join('');
  const c=m.combined;
  const totalRow=c.total?`<tr class="cl-total"><td>Priority Zones 합계</td><td class="cl-num mono">${clNum(c.total)}</td>${levels.map(k=>cell(c.percent[k])).join('')}</tr>`:'';
  const chart=clLineChart([
    {name:'1x',color:'#4fd8c7',points:CareerMetrics.snapshotSeries(snaps,'coverage1x')},
    {name:'3x',color:'#f5a623',points:CareerMetrics.snapshotSeries(snaps,'coverage3x')},
    {name:'5x',color:'#5fd88a',points:CareerMetrics.snapshotSeries(snaps,'coverage5x')},
    {name:'10x',color:'#b58cff',points:CareerMetrics.snapshotSeries(snaps,'coverage10x')},
  ],{max:100,unit:'%',title:'Priority Zones Coverage Depth 추이'});
  const sharedNote=shared.map((r,i)=>`<div class="cl-note cl-warn">※${i+1} ${clEsc(r)}</div>`).join('');
  const body=`${sharedNote}<div class="cl-table-wrap"><table class="cl-table">
      <thead><tr><th>Zone</th><th class="cl-num">유효 도로 칸</th>${levels.map(k=>`<th class="cl-num">${k}x Coverage</th>`).join('')}</tr></thead>
      <tbody>${totalRow}${rows}</tbody></table></div>
    <div class="cl-note">Repeated Collection Depth — 유효 도로 칸(${CoverageGrid.DEFAULT_CELL_SIZE_M}m) 중 N회 이상 지나간 칸의 비율이에요. 반복 수집은 의도한 수집 방식이라 그대로 셉니다.
      방문 1회 = 칸에 들어간 한 번(날짜·차량이 다르거나 칸을 벗어났다 다시 들어오면 새 방문) — 누적 지도 Coverage 와 같은 칸·같은 방문 수·같은 수동 셀 보정이에요.
      ①~⑫ 는 상위 구역 칸을 구역 경계로 잘라 센 값이에요.</div>
    ${chart}`;
  return clSection('cl-depth','Coverage Depth','1x · 3x · 5x · 10x',body);
}

// ── 3) Scenario Fulfillment ────────────────────────────
function careerTargetLabel(t){
  const TC=TimeConditions;
  switch(t.kind){
    case 'coverageDepth': return `${t.value}x Coverage`;
    case 'totalTime': return '전체 수집 시간';
    case 'trafficPeriod': return TC.TRAFFIC_PERIOD_LABELS[t.value]||t.value;
    case 'lightCondition': return (TC.LIGHT_CONDITION_LABELS[t.value]||t.value)+' (조도)';
    default: return t.value;
  }
}
function careerMetricUnit(metric){ return metric==='percent'?'%':metric==='events'?'회':'분'; }
function careerCurrentText(r){
  const u=careerMetricUnit(r.metric);
  const cur=r.metric==='percent'?(Number.isFinite(r.current)?r.current.toFixed(1):'—'):clNum(r.current);
  return `${cur}${u} / ${r.metric==='percent'?r.target:clNum(r.target)}${u}`;
}

function careerFulfillHTML(m,snaps){
  if(!m) return clSection('cl-fulfill','Scenario Fulfillment','',careerPendingHTML());
  if(!m.plan){
    return clSection('cl-fulfill','Scenario Fulfillment','',`<div class="cl-note">오늘 적용되는 Collection Plan 이 없어요. 아래 <b>Collection Plans</b>에서 Plan 을 만들면 그 목표로 달성률을 계산해요.</div>`);
  }
  const f=m.fulfillment, s=f.summary;
  const tiles=[
    ['관리 Target',s.total,'측정할 수 있는 Target 수(측정 불가는 따로 셈)'],
    ['달성',s.achieved,'현재 값 ≥ 목표값'],
    ['미달',s.deficit,'현재 값 < 목표값'],
    ['달성률',clPct(s.percent),'달성 ÷ 관리 Target'],
    ['Priority Zone 달성률',clPct(s.priorityZone.percent),`Plan priorityZones(${m.plan.priorityZones.map(CareerMetrics.scopeLabel).join(' ')}) 안의 Target 만`],
    ['측정 불가',s.unmeasurable,'이 구역 단위 집계가 없거나 Coverage 미계산 — 미달로 세지 않아요'],
  ].map(([k,v,b])=>`<div class="cl-tile"><div class="cl-tile-k">${clEsc(k)} ${clInfo(b)}</div><div class="cl-tile-v mono">${typeof v==='number'?clNum(v):clEsc(v)}</div></div>`).join('');
  let rows=f.rows;
  if(careerUi.onlyDeficit) rows=rows.filter(r=>r.measurable&&!r.achieved);
  const byScope=new Map();
  rows.forEach(r=>{ if(!byScope.has(r.scope)) byScope.set(r.scope,[]); byScope.get(r.scope).push(r); });
  const body=[...byScope.entries()].map(([scope,list])=>{
    const trs=list.map(r=>{
      const status=!r.measurable?`<span class="cl-badge cl-badge-na" title="${clEsc(r.reason)}">측정 불가</span>`
        :r.achieved?'<span class="cl-badge cl-badge-ok">달성</span>':'<span class="cl-badge cl-badge-no">미달</span>';
      const bar=r.measurable?clBar(r.percent,r.achieved,true):`<span class="cl-reason">${clEsc(r.reason)}</span>`;
      return `<tr class="${r.measurable?'':'cl-muted'}"><td>${clEsc(CareerMetrics.TARGET_KINDS[r.kind].label)}</td><td>${clEsc(careerTargetLabel(r))}</td>
        <td class="cl-num mono">${r.measurable?clEsc(careerCurrentText(r)):`— / ${clEsc(String(r.target))}${careerMetricUnit(r.metric)}`}</td>
        <td>${bar}</td><td>${status}</td><td><span class="cl-prio cl-prio-${r.priority}">${CareerMetrics.PRIORITY_LABELS[r.priority]}</span></td></tr>`;
    }).join('');
    return `<tbody><tr class="cl-group"><td colspan="6">${clEsc(CareerMetrics.scopeLabel(scope))}</td></tr>${trs}</tbody>`;
  }).join('');
  const chart=clLineChart([
    {name:'Scenario Fulfillment',color:'#4fd8c7',points:CareerMetrics.snapshotSeries(snaps,'fulfillmentPercent')},
    {name:'Priority Zone 달성률',color:'#f5a623',points:CareerMetrics.snapshotSeries(snaps,'priorityZoneAchievementPercent')},
  ],{max:100,unit:'%',title:'달성률 추이'});
  return clSection('cl-fulfill','Scenario Fulfillment',`Plan ${clEsc(m.plan.id)} 목표 기준`,`
    <div class="cl-tiles">${tiles}</div>
    <div class="cl-toolbar"><label class="cl-check"><input type="checkbox" data-act="only-deficit" ${careerUi.onlyDeficit?'checked':''}/> 미달만 보기</label></div>
    <div class="cl-table-wrap"><table class="cl-table">
      <thead><tr><th>종류</th><th>조건</th><th class="cl-num">현재 / 목표</th><th>달성률</th><th>상태</th><th>우선순위</th></tr></thead>
      ${body||'<tbody><tr><td colspan="6" class="cl-reason">표시할 Target 이 없어요.</td></tr></tbody>'}
    </table></div>
    <div class="cl-note">현재 값은 운영 구역은 날짜 요약(ConditionStats — 추천과 같은 LOW 신뢰도 제외 규칙), ①~⑫ 는 HD Map 우선 수집 현황과 같은 구역 집계에서 읽어요. 우선순위: Plan 의 priorityZones 첫 구역 = High, 나머지 = Medium, 그 밖 = Low.</div>
    ${chart}`);
}

// ── 4) Deficit Trend ───────────────────────────────────
function careerDeficitHTML(snaps){
  const hist=CareerMetrics.deficitHistory(snaps);
  if(!hist.length){
    return clSection('cl-deficit','Deficit Trend','',`<div class="cl-note">아직 Snapshot 이 없어요. "현재 상태 기록"(또는 자동 기록)이 쌓이면 날짜별 부족 Target 수가 남아요.</div>`);
  }
  const chart=clLineChart([
    {name:'미달 Target',color:'#ff6b6b',points:hist.filter(h=>Number.isFinite(h.total)).map(h=>({x:h.date,y:h.total}))},
    {name:'High',color:'#f5a623',points:hist.filter(h=>Number.isFinite(h.high)).map(h=>({x:h.date,y:h.high}))},
    {name:'추천 부족 조건(점수 40+)',color:'#8a94a8',points:hist.filter(h=>Number.isFinite(h.recTotal)).map(h=>({x:h.date,y:h.recTotal}))},
  ],{unit:'',title:'부족 Target 추이'});
  const rows=hist.slice().reverse().map(h=>`<tr><td class="mono">${clEsc(h.date)}</td><td class="mono">${clEsc(h.planId||'—')}</td>
    <td class="cl-num mono">${h.total??'—'}</td><td class="cl-num mono">${h.high??'—'}</td><td class="cl-num mono">${h.medium??'—'}</td><td class="cl-num mono">${h.low??'—'}</td>
    <td class="cl-num mono">${h.recTotal??'—'}</td></tr>`).join('');
  return clSection('cl-deficit','Deficit Trend','Snapshot 날짜별 기록',`${chart}
    <div class="cl-table-wrap"><table class="cl-table"><thead><tr><th>날짜</th><th>Plan</th><th class="cl-num">미달 Target</th><th class="cl-num">High</th><th class="cl-num">Medium</th><th class="cl-num">Low</th>
      <th class="cl-num" title="추천 엔진의 조건 후보 중 우선순위 '보통' 이상(점수 40+) 개수">추천 부족 조건</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

// ── 5) Collection Plans ────────────────────────────────
function careerPlansHTML(m){
  const plans=careerStore.collectionPlans||[];
  const history=CareerMetrics.planHistory(plans);
  const active=m?m.plan:CareerMetrics.activePlanFor(plans,KpiHistory.today());
  const editor=careerUi.planEditor?careerPlanEditorHTML():'';
  const activeCard=active?`<div class="cl-card cl-card-active">
      <div class="cl-card-title">${clEsc(active.title)} <span class="cl-tag">적용 중</span></div>
      <div class="cl-kv mono">${clEsc(active.id)} · 기간 ${clEsc(active.validFrom||'제한 없음')} ~ ${clEsc(active.validTo||'제한 없음')} · Target ${CareerMetrics.expandPlanTargets(active).length}개</div>
      <div class="cl-kv">Priority Zones: ${active.priorityZones.map(s=>clEsc(CareerMetrics.scopeLabel(s))).join(' ')||'—'}</div>
      ${active.reason?`<div class="cl-kv">사유: ${clEsc(active.reason)}</div>`:''}
    </div>`:'<div class="cl-note">오늘 적용되는 Plan 이 없어요.</div>';
  const hist=history.map(h=>`<div class="cl-card">
      <div class="cl-card-title">${clEsc(h.latest.title)} <span class="mono cl-dim">${clEsc(h.seriesId)} · v${h.latest.version}</span>
        <button class="btn ghost cl-small" type="button" data-act="plan-revise" data-id="${clEsc(h.latest.id)}">수정 → 새 버전</button></div>
      <ol class="cl-versions">${h.versions.map(v=>{
        const prev=plans.find(p=>p.id===v.previousVersionId);
        const d=prev?CareerMetrics.diffPlanTargets(prev,v):null;
        return `<li><span class="mono">${clEsc(v.id)}</span> · ${clEsc(String(v.createdAt||'').slice(0,16).replace('T',' '))}
          · 기간 ${clEsc(v.validFrom||'—')} ~ ${clEsc(v.validTo||'—')}
          · <b>${clEsc(v.changeReason||'')}</b>${v.previousVersionId?` · 이전 ${clEsc(v.previousVersionId)}`:''}
          ${d?` <span class="cl-dim">(+${d.added.length} −${d.removed.length} ~${d.changed.length})</span>`:''}</li>`;
      }).join('')}</ol>
    </div>`).join('');
  return clSection('cl-plans','Collection Plans','목표 버전 기록 — 수정하면 새 버전이 생기고 예전 버전은 그대로 남아요',`
    ${activeCard}
    <div class="cl-toolbar"><button class="btn ghost" type="button" data-act="plan-new">+ 새 Plan (추천 설정값으로 초안)</button></div>
    ${editor}
    ${hist||''}`);
}

const CAREER_KIND_VALUES=()=>({
  coverageDepth:CareerMetrics.DEPTH_LEVELS.map(String),
  totalTime:['total'],
  trafficPeriod:TimeConditions.TRAFFIC_PERIOD_IDS.slice(),
  lightCondition:TimeConditions.LIGHT_CONDITION_IDS.slice(),
  maneuver:[...Recommendation.MANEUVER_EVENT_IDS,...Recommendation.MANEUVER_DURATION_IDS],
  drivingState:Recommendation.DRIVING_STATE_IDS.slice(),
  roadContext:Recommendation.ROAD_CONTEXT_IDS.slice(),
});

function careerPlanEditorHTML(){
  const e=careerUi.planEditor;
  const scopes=[...CareerMetrics.AREA_NOS.map(String),...((careerMeasured&&careerMeasured.activeZones)||[])];
  const kinds=CareerMetrics.TARGET_KIND_IDS;
  const values=CAREER_KIND_VALUES();
  const rows=e.rows.map((r,i)=>`<tr data-row="${i}">
      <td><input class="cl-in cl-in-s" list="cl-scopes" data-field="scope" value="${clEsc(r.scope)}" title="①~⑫ 는 숫자 1~12, 운영 구역은 이름"/></td>
      <td><select class="cl-in" data-field="kind">${kinds.map(k=>`<option value="${k}" ${k===r.kind?'selected':''}>${clEsc(CareerMetrics.TARGET_KINDS[k].label)}</option>`).join('')}</select></td>
      <td><input class="cl-in" list="cl-values-${clEsc(r.kind)}" data-field="value" value="${clEsc(r.value)}"/></td>
      <td><input class="cl-in cl-in-s" type="number" min="0" step="any" data-field="target" value="${clEsc(r.target)}"/> <span class="cl-dim">${careerMetricUnit(CareerMetrics.metricOf(r.kind,r.value))}</span></td>
      <td><button class="btn ghost cl-small" type="button" data-act="plan-row-del" data-row="${i}">✕</button></td>
    </tr>`).join('');
  return `<div class="cl-editor">
    <div class="cl-editor-title">${e.base?`새 버전 — ${clEsc(e.base.id)} 을(를) 이어받음`:'새 Plan'}</div>
    <div class="cl-form">
      <label>제목<input class="cl-in" data-plan="title" value="${clEsc(e.title)}" placeholder="예: 2차년도 HD Map 우선수집"/></label>
      <label>시작일<input class="cl-in" type="date" data-plan="validFrom" value="${clEsc(e.validFrom)}"/></label>
      <label>종료일<input class="cl-in" type="date" data-plan="validTo" value="${clEsc(e.validTo)}"/></label>
      <label class="cl-wide">Priority Zones (첫 번째 = High)<input class="cl-in" data-plan="priorityZones" value="${clEsc(e.priorityZones)}" placeholder="5,1,2,6,9,10"/></label>
      <label class="cl-wide">Plan 사유<input class="cl-in" data-plan="reason" value="${clEsc(e.reason)}" placeholder="예: HD Map 우선 구축지역 데이터 확보"/></label>
      ${e.base?`<label class="cl-wide">변경 사유 (필수)<input class="cl-in" data-plan="changeReason" value="${clEsc(e.changeReason)}" placeholder="예: ⑤ 야간 목표 상향"/></label>`:''}
    </div>
    <div class="cl-note">${e.base?'이전 버전의 목표를 복사해 왔어요.':'추천 설정(교통 시간대·Maneuver·Road Context·Coverage 목표)을 초안으로 복사했어요 — 추천은 "조건 한 칸" 목표, Plan 은 "구역 전체 누적" 목표라 값을 확인해서 고쳐 주세요.'}</div>
    <div class="cl-table-wrap"><table class="cl-table cl-edit-table">
      <thead><tr><th>Zone</th><th>종류</th><th>값</th><th>목표</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <datalist id="cl-scopes">${scopes.map(s=>`<option value="${clEsc(s)}">${clEsc(CareerMetrics.scopeLabel(s))}</option>`).join('')}</datalist>
    ${kinds.map(k=>`<datalist id="cl-values-${k}">${values[k].map(v=>`<option value="${clEsc(v)}"></option>`).join('')}</datalist>`).join('')}
    ${e.errors&&e.errors.length?`<div class="cl-note cl-warn">${e.errors.map(clEsc).join('<br/>')}</div>`:''}
    <div class="cl-toolbar">
      <button class="btn ghost" type="button" data-act="plan-row-add">+ Target</button>
      <span style="flex:1"></span>
      <button class="btn ghost" type="button" data-act="plan-cancel">취소</button>
      <button class="btn" type="button" data-act="plan-save">${e.base?'새 버전 저장':'Plan 저장'}</button>
    </div>
  </div>`;
}

function careerStartPlanEditor(base){
  const m=careerMeasured;
  let source;
  if(base) source=base;
  else{
    source=CareerMetrics.defaultPlanDraft({
      recommendationSettings:m?m.recSettings:Recommendation.defaultRecommendationSettings(),
      // 기록이 한 건도 없는 운영 구역은 초안에 넣지 않는다(목표만 잔뜩 생겨 미달 수가 부풀려진다) — 필요하면 직접 추가
      operatingZones:m?m.activeZones.filter(z=>m.measurements[z]&&m.measurements[z].recordCount>0):[],
      priorityAreaNos:[HDMapPriority.PRIMARY_AREA_NO,...HDMapPriority.PRIORITY_AREA_NOS.filter(n=>n!==HDMapPriority.PRIMARY_AREA_NO)],
    });
  }
  careerUi.planEditor={
    base:base||null,
    title:source.title||'', validFrom:source.validFrom||'', validTo:source.validTo||'',
    priorityZones:(source.priorityZones||[]).join(','), reason:source.reason||'', changeReason:'',
    rows:CareerMetrics.expandPlanTargets(source).map(t=>({scope:t.scope,kind:t.kind,value:t.value,target:t.target})),
    errors:[],
  };
  renderCareerLog({reset:'plan'});
  const el=document.getElementById('cl-plans');
  if(el) el.scrollIntoView({block:'start'});
}

// 입력칸 값을 편집 상태로 옮긴다(다시 그리기 전에)
function careerSyncPlanEditor(){
  const e=careerUi.planEditor;
  const root=document.querySelector('#cl-plans .cl-editor');
  if(!e||!root) return;
  root.querySelectorAll('[data-plan]').forEach(inp=>{ e[inp.dataset.plan]=inp.value; });
  root.querySelectorAll('tr[data-row]').forEach(tr=>{
    const r=e.rows[Number(tr.dataset.row)];
    if(!r) return;
    tr.querySelectorAll('[data-field]').forEach(inp=>{ r[inp.dataset.field]=inp.value; });
  });
}

async function careerSavePlan(){
  careerSyncPlanEditor();
  const e=careerUi.planEditor;
  const input={
    title:e.title, validFrom:e.validFrom, validTo:e.validTo, reason:e.reason, changeReason:e.changeReason,
    priorityZones:String(e.priorityZones||'').split(',').map(s=>s.trim()).filter(Boolean),
    ...CareerMetrics.collapseTargetRows(e.rows),
  };
  const res=e.base
    ?CareerMetrics.revisePlan(e.base,input)
    :CareerMetrics.createPlan(input,careerStore.collectionPlans);
  if(!res.ok){ e.errors=res.errors; renderCareerLog(); return; }
  try{
    await RouteDB.saveCareerItem('collectionPlans',res.value);
  }catch(err){ e.errors=[(err&&err.message)||String(err)]; renderCareerLog(); return; }
  careerUi.planEditor=null;
  if(typeof showToast==='function') showToast(`Plan ${res.value.id} 저장`);
  await refreshCareerLog();
}

// ── 6) Decision / Contribution Log ─────────────────────
function careerContribHTML(){
  const list=CareerMetrics.sortContributions(careerStore.contributions,careerUi.contribOrder);
  const form=careerUi.contribFormOpen?careerContribFormHTML(careerUi.contribEdit,careerUi.contribDraft):'';
  const cards=list.map(c=>`<div class="cl-card">
      <div class="cl-card-title"><span class="mono">${clEsc(c.date)}</span> ${clEsc(c.problem)}
        <span style="flex:1"></span>
        <button class="btn ghost cl-small" type="button" data-act="contrib-edit" data-id="${clEsc(c.id)}">수정</button>
        <button class="btn ghost cl-small" type="button" data-act="contrib-del" data-id="${clEsc(c.id)}">삭제</button></div>
      <dl class="cl-dl">
        ${[['분석',c.analysis],['내 결정/제안',c.decision],['내 구현',c.implementation],['결과',c.result],['정량 결과',c.quantResult],
          ['관련 Zone',(c.zones||[]).join(', ')],['관련 기능',(c.features||[]).join(', ')],['관련 Plan',c.planId],['저장 당시 KPI',careerKpiAtSaveText(c.kpiAtSave)]]
          .filter(([,v])=>v).map(([k,v])=>`<dt>${clEsc(k)}</dt><dd>${clEsc(v)}</dd>`).join('')}
      </dl>
    </div>`).join('');
  return clSection('cl-contrib','Contribution Log','상세 편집 — "오늘 내가 한 일"도 여기서 고칠 수 있어요',`
    <div class="cl-toolbar">
      <button class="btn ghost" type="button" data-act="contrib-new">+ 기록 추가</button>
      <span style="flex:1"></span>
      <button class="btn ghost cl-small" type="button" data-act="contrib-order">${careerUi.contribOrder==='desc'?'최신순':'오래된 순'} ⇅</button>
    </div>
    ${form}
    ${cards||'<div class="cl-note">아직 기록이 없어요. 문제 → 분석 → 결정 → 구현 → 결과를 그때그때 남겨 두면 나중에 "내 기여"와 "팀 성과"를 나눠 설명할 수 있어요.</div>'}`);
}

// 한 줄 기록에 자동으로 붙은 저장 시점 KPI — 없으면 ''(예전 상세 기록)
function careerKpiAtSaveText(a){
  if(!a) return '';
  const p=v=>Number.isFinite(v)?v.toFixed(1)+'%':'—';
  const parts=[`Coverage 1x ${p(a.coverage1x)} · 3x ${p(a.coverage3x)} · 5x ${p(a.coverage5x)} · 10x ${p(a.coverage10x)}`,
    `Fulfillment ${p(a.fulfillmentPercent)}`, `Deficit ${Number.isFinite(a.targetDeficit)?a.targetDeficit:'—'}`,
    `수집 ${Number.isFinite(a.collectionMinutes)?clNum(a.collectionMinutes)+'분':'—'}`, `주행 ${Number.isFinite(a.distanceKm)?a.distanceKm+'km':'—'}`];
  if(a.planId) parts.push(`Plan ${a.planId}`);
  return parts.join(' · ');
}

function careerContribFormHTML(c,draft){
  const v=draft||c||{date:KpiHistory.today()};
  const plans=careerStore.collectionPlans||[];
  const field=(key,label,multi,ph)=>multi
    ?`<label class="cl-wide">${label}<textarea class="cl-in" rows="2" data-contrib="${key}" placeholder="${clEsc(ph||'')}">${clEsc(v[key]||'')}</textarea></label>`
    :`<label>${label}<input class="cl-in" data-contrib="${key}" value="${clEsc(Array.isArray(v[key])?v[key].join(', '):(v[key]||''))}" placeholder="${clEsc(ph||'')}"/></label>`;
  return `<div class="cl-editor">
    <div class="cl-editor-title">${c?'기록 수정':'새 기록'}</div>
    <div class="cl-form">
      <label>날짜<input class="cl-in" type="date" data-contrib="date" value="${clEsc(v.date||'')}"/></label>
      ${field('zones','관련 Zone',false,'예: 5, 강남')}
      ${field('features','관련 기능',false,'예: Route Planning, Coverage Analysis')}
      <label>관련 Plan<select class="cl-in" data-contrib="planId"><option value="">—</option>${plans.map(p=>`<option value="${clEsc(p.id)}" ${p.id===v.planId?'selected':''}>${clEsc(p.id)}</option>`).join('')}</select></label>
      ${field('problem','문제 / 요구사항 (필수)',true,'예: ⑤ 구역 야간 데이터 부족')}
      ${field('analysis','내가 분석한 내용',true,'예: 야간 42분 / 목표 120분')}
      ${field('decision','내가 결정 또는 제안한 내용',true)}
      ${field('implementation','내가 구현한 내용',true)}
      ${field('result','결과',true)}
      ${field('quantResult','정량 결과 (선택)',false,'예: 야간 +96분')}
    </div>
    ${careerUi.contribErrors&&careerUi.contribErrors.length?`<div class="cl-note cl-warn">${careerUi.contribErrors.map(clEsc).join('<br/>')}</div>`:''}
    <div class="cl-toolbar"><span style="flex:1"></span>
      <button class="btn ghost" type="button" data-act="contrib-cancel">취소</button>
      <button class="btn" type="button" data-act="contrib-save">저장</button></div>
  </div>`;
}

async function careerSaveContribution(){
  const root=document.querySelector('#cl-contrib .cl-editor');
  if(!root) return;
  const input={};
  root.querySelectorAll('[data-contrib]').forEach(inp=>{ input[inp.dataset.contrib]=inp.value; });
  const res=CareerMetrics.normalizeContribution(input,careerUi.contribEdit);
  if(!res.ok){ careerUi.contribErrors=res.errors; renderCareerLog(); return; }
  try{ await RouteDB.saveCareerItem('contributions',res.value); }
  catch(err){ careerUi.contribErrors=[(err&&err.message)||String(err)]; renderCareerLog(); return; }
  careerStore=await KpiHistory.loadStore();
  careerSetContribForm(false);
}

// 폼을 새로 열거나 닫을 때는 이전 초안을 버리고 그린다
function careerSetContribForm(open,edit){
  careerUi.contribFormOpen=open; careerUi.contribEdit=edit||null; careerUi.contribErrors=null; careerUi.contribDraft=null;
  renderCareerLog({reset:'contrib'});
}

// ── 7) Automation Impact (Manual Work Time Log) ────────
function careerAutomationHTML(){
  const entries=(careerStore.workTimes||[]).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  const stats=CareerMetrics.workTimeStats(entries);
  const tasks=[...new Set(entries.map(e=>e.task))];
  const w=careerUi.workDraft||{mode:'manual',date:KpiHistory.today()};
  const statRows=stats.map(s=>`<tr><td>${clEsc(s.task)}</td>
      <td class="cl-num mono">${s.manual.n?`n=${s.manual.n} · 평균 ${s.manual.avg}분`:'—'}</td>
      <td class="cl-num mono">${s.routeViewer.n?`n=${s.routeViewer.n} · 평균 ${s.routeViewer.avg}분`:'—'}</td>
      <td class="cl-num mono">${s.comparable?`<b>${s.reductionPercent}% 감소</b>`:'<span class="cl-dim">양쪽 측정 필요</span>'}</td></tr>`).join('');
  const entryRows=entries.map(e=>`<tr><td class="mono">${clEsc(e.date)}</td><td>${clEsc(e.task)}</td><td>${clEsc(CareerMetrics.WORK_MODES[e.mode]||e.mode)}</td>
      <td class="cl-num mono">${e.minutes}분</td><td class="cl-dim">${clEsc(e.note||'')}</td>
      <td><button class="btn ghost cl-small" type="button" data-act="work-del" data-id="${clEsc(e.id)}">✕</button></td></tr>`).join('');
  return clSection('cl-auto','Automation Impact','Manual Work Time Log — 직접 잰 값만',`
    <div class="cl-editor cl-inline">
      <div class="cl-form">
        <label>Task<input class="cl-in" data-work="task" list="cl-work-tasks" value="${clEsc(w.task||'')}" placeholder="예: 일일 수집 현황 분석"/></label>
        <label>Mode<select class="cl-in" data-work="mode">${Object.entries(CareerMetrics.WORK_MODES).map(([k,v])=>`<option value="${k}" ${k===w.mode?'selected':''}>${clEsc(v)}</option>`).join('')}</select></label>
        <label>Duration(분)<input class="cl-in cl-in-s" type="number" min="0" step="any" data-work="minutes" value="${clEsc(w.minutes||'')}"/></label>
        <label>Date<input class="cl-in" type="date" data-work="date" value="${clEsc(w.date||KpiHistory.today())}"/></label>
        <label class="cl-wide">메모 (선택)<input class="cl-in" data-work="note" value="${clEsc(w.note||'')}"/></label>
      </div>
      <datalist id="cl-work-tasks">${tasks.map(t=>`<option value="${clEsc(t)}"></option>`).join('')}</datalist>
      ${careerUi.workErrors&&careerUi.workErrors.length?`<div class="cl-note cl-warn">${careerUi.workErrors.map(clEsc).join('<br/>')}</div>`:''}
      <div class="cl-toolbar"><span style="flex:1"></span><button class="btn" type="button" data-act="work-add">측정값 추가</button></div>
    </div>
    ${stats.length?`<div class="cl-table-wrap"><table class="cl-table"><thead><tr><th>Task</th><th class="cl-num">Manual</th><th class="cl-num">Route Viewer</th><th class="cl-num">자동화 후</th></tr></thead><tbody>${statRows}</tbody></table></div>`:''}
    <div class="cl-note">사용자가 입력한 측정값만 계산해요. 과거 값을 추정하거나 채우지 않고, 한쪽 방식 측정이 없으면 감소율을 내지 않아요. 감소율 = (Manual 평균 − Route Viewer 평균) ÷ Manual 평균.</div>
    ${entryRows?`<details class="cl-details"><summary>측정 기록 ${entries.length}건</summary><div class="cl-table-wrap"><table class="cl-table"><tbody>${entryRows}</tbody></table></div></details>`:''}`);
}

async function careerAddWorkTime(){
  const root=document.querySelector('#cl-auto .cl-editor');
  if(!root) return;
  const input={};
  root.querySelectorAll('[data-work]').forEach(inp=>{ input[inp.dataset.work]=inp.value; });
  const res=CareerMetrics.normalizeWorkTime(input);
  if(!res.ok){ careerUi.workErrors=res.errors; renderCareerLog(); return; }
  try{ await RouteDB.saveCareerItem('workTimes',res.value); }
  catch(err){ careerUi.workErrors=[(err&&err.message)||String(err)]; renderCareerLog(); return; }
  careerUi.workErrors=null;
  // 같은 작업을 반복 측정하기 쉽게 Task·방식·날짜는 남기고 시간·메모만 비운다
  careerUi.workDraft={...input,minutes:'',note:''};
  careerStore=await KpiHistory.loadStore();
  renderCareerLog({reset:'work'});
}

// ── 8) Impact Summary(예전 이름 Resume Metrics) ──────────────────────────────────
function careerResumeData(m,snaps){
  return CareerMetrics.buildResumeMetrics({
    scale:m?m.scale:null, snapshots:snaps,
    workStats:CareerMetrics.workTimeStats(careerStore.workTimes),
    contributions:careerStore.contributions,
  });
}

function careerResumeHTML(m,snaps){
  const r=careerResumeData(m,snaps);
  const block=(title,list,empty)=>`<div class="cl-resume-block"><div class="cl-resume-title">${clEsc(title)}</div>
    ${list.length?`<ul>${list.map(x=>`<li><span>${clEsc(x.label)}</span><b class="mono">${clEsc(x.value)}</b>${x.fromDate&&x.points>1?` <span class="cl-dim">(${clEsc(x.fromDate)} → ${clEsc(x.toDate)})</span>`:''}</li>`).join('')}</ul>`:`<div class="cl-dim">${clEsc(empty)}</div>`}</div>`;
  return clSection('cl-resume','Impact Summary','숫자와 사실만 — 문장은 만들지 않아요',`
    <div class="cl-resume">
      ${block('PROJECT SCALE',r.scale,'측정 중…')}
      ${block('DATA COVERAGE',r.coverage,'Snapshot 이 쌓이면 처음 → 지금 변화가 표시돼요')}
      ${block('AUTOMATION',r.automation,'Manual / Route Viewer 측정값이 양쪽 다 있어야 표시돼요')}
      ${block('MY CONTRIBUTION',r.contribution,'Contribution Log 의 "관련 기능"에 적은 항목이 여기 모여요')}
    </div>
    <div class="cl-toolbar"><button class="btn ghost" type="button" data-act="copy-md">요약 Markdown 복사</button></div>`);
}

// ══════════════════════════════════════════════════════════
//  작은 SVG 선 그래프 — 새 라이브러리 없이
//  series: [{name,color,points:[{x:'YYYY-MM-DD',y}]}] · opts: {max, unit, title}
// ══════════════════════════════════════════════════════════
function clLineChart(series,opts){
  const o=opts||{};
  const live=(series||[]).filter(s=>s.points&&s.points.length);
  const dates=[...new Set(live.flatMap(s=>s.points.map(p=>p.x)))].sort();
  if(!dates.length) return `<div class="cl-chart-empty">${clEsc(o.title||'추이')} — Snapshot 이 쌓이면 그래프가 그려져요.</div>`;
  const W=640,H=180,L=38,R=12,T=14,B=26;
  const maxY=o.max!=null?o.max:Math.max(1,...live.flatMap(s=>s.points.map(p=>p.y)));
  const x=d=>dates.length===1?L+(W-L-R)/2:L+(dates.indexOf(d)/(dates.length-1))*(W-L-R);
  const y=v=>T+(1-Math.max(0,Math.min(maxY,v))/maxY)*(H-T-B);
  const grid=[0,0.5,1].map(f=>{
    const v=maxY*f, yy=y(v);
    return `<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" class="cl-grid"/><text x="${L-6}" y="${yy+3}" text-anchor="end" class="cl-axis">${Math.round(v)}${clEsc(o.unit||'')}</text>`;
  }).join('');
  const labelIdx=[...new Set([0,Math.floor((dates.length-1)/2),dates.length-1])];
  // 양 끝 날짜는 그래프 밖으로 잘리지 않게 안쪽으로 붙인다
  const anchor=i=>dates.length===1?'middle':i===0?'start':i===dates.length-1?'end':'middle';
  const xl=labelIdx.map(i=>`<text x="${x(dates[i])}" y="${H-8}" text-anchor="${anchor(i)}" class="cl-axis">${clEsc(dates[i].slice(5).replace('-','/'))}</text>`).join('');
  const lines=live.map(s=>{
    const pts=s.points.map(p=>`${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    const dots=s.points.map(p=>`<circle cx="${x(p.x).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="2.6" fill="${s.color}"><title>${clEsc(s.name)} ${clEsc(p.x)}: ${p.y}${clEsc(o.unit||'')}</title></circle>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="1.8"/>${dots}`;
  }).join('');
  const legend=live.map(s=>`<span class="cl-legend-item"><span class="cl-legend-dot" style="background:${s.color}"></span>${clEsc(s.name)}</span>`).join('');
  return `<figure class="cl-chart"><figcaption>${clEsc(o.title||'')} <span class="cl-legend">${legend}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${clEsc(o.title||'추이 그래프')}">${grid}${xl}${lines}</svg></figure>`;
}

// ══════════════════════════════════════════════════════════
//  입력 처리(이벤트 위임)
// ══════════════════════════════════════════════════════════
async function onCareerClick(e){
  const btn=e.target.closest('[data-act]');
  if(!btn||btn.tagName==='INPUT'||btn.tagName==='SELECT') return;
  const act=btn.dataset.act;
  try{
    switch(act){
      case 'close': closeCareerLog(); break;
      case 'quick-save': await careerSaveQuickNote(); break;
      case 'goto': { const t=document.getElementById(btn.dataset.target); if(t) t.scrollIntoView({block:'start',behavior:'smooth'}); break; }
      case 'remeasure': careerMeasured=null; await refreshCareerLog(); break;
      case 'snapshot': await careerRecordNow(); break;
      case 'export': await careerExport(btn.dataset.format); break;
      case 'import': { const inp=document.getElementById('career-import-input'); if(inp) inp.click(); break; }
      case 'copy-md': await careerCopyMarkdown(); break;
      case 'plan-new': careerStartPlanEditor(null); break;
      case 'plan-revise': { const p=careerStore.collectionPlans.find(x=>x.id===btn.dataset.id); if(p) careerStartPlanEditor(p); break; }
      case 'plan-row-add': careerSyncPlanEditor(); careerUi.planEditor.rows.push({scope:'5',kind:'trafficPeriod',value:'night',target:''}); renderCareerLog({reset:'plan'}); break;
      case 'plan-row-del': careerSyncPlanEditor(); careerUi.planEditor.rows.splice(Number(btn.dataset.row),1); renderCareerLog({reset:'plan'}); break;
      case 'plan-cancel': careerUi.planEditor=null; renderCareerLog(); break;
      case 'plan-save': await careerSavePlan(); break;
      case 'contrib-new': careerSetContribForm(true,null); break;
      case 'contrib-edit': careerSetContribForm(true,careerStore.contributions.find(c=>c.id===btn.dataset.id)||null); break;
      case 'contrib-cancel': careerSetContribForm(false); break;
      case 'contrib-save': await careerSaveContribution(); break;
      case 'contrib-order': careerUi.contribOrder=careerUi.contribOrder==='desc'?'asc':'desc'; renderCareerLog(); break;
      case 'contrib-del': {
        const ok=await confirmDialog({title:'기록 삭제',message:'이 Contribution 기록을 지울까요?',detail:'되돌릴 수 없어요.',confirmLabel:'삭제',danger:true});
        if(ok){ await RouteDB.deleteCareerItem('contributions',btn.dataset.id); await reloadCareerStore(); }
        break;
      }
      case 'work-add': await careerAddWorkTime(); break;
      case 'work-del': {
        const ok=await confirmDialog({title:'측정값 삭제',message:'이 작업 시간 측정값을 지울까요?',confirmLabel:'삭제',danger:true});
        if(ok){ await RouteDB.deleteCareerItem('workTimes',btn.dataset.id); await reloadCareerStore(); }
        break;
      }
      default: break;
    }
  }catch(err){
    console.warn('[경로뷰어] Career Log 작업 실패:',err);
    if(typeof showToast==='function') showToast('실패했어요 — '+((err&&err.message)||err));
  }
}

function onCareerChange(e){
  const t=e.target;
  if(t.dataset.act==='auto'){ KpiHistory.setAutoEnabled(t.checked); return; }
  if(t.dataset.act==='only-deficit'){ careerUi.onlyDeficit=t.checked; renderCareerLog(); return; }
  if(t.id==='career-import-input'){ careerImportFile(t.files&&t.files[0]); t.value=''; return; }
  // Target 종류를 바꾸면 값 목록(datalist)과 단위가 달라진다
  if(t.dataset.field==='kind'&&careerUi.planEditor){ careerSyncPlanEditor(); renderCareerLog({reset:'plan'}); }
}

async function careerRecordNow(){
  if(careerMeasuring) return;
  careerMeasuring=true; careerMeasureError=null; renderCareerLog();
  try{
    careerMeasured=await KpiHistory.measure();
    const snap=await KpiHistory.recordSnapshot('manual',careerMeasured);
    careerStore=await KpiHistory.loadStore();
    if(typeof showToast==='function') showToast(`${snap.date} Snapshot 기록${snap.updateCount>1?` (오늘 ${snap.updateCount}번째 갱신)`:''}`);
  }catch(err){
    careerMeasureError=(err&&err.message)||String(err);
  }
  careerMeasuring=false;
  renderCareerLog();
}

function careerExportBundle(){
  const m=careerMeasured;
  const snaps=careerStore.kpiSnapshots;
  const workStats=CareerMetrics.workTimeStats(careerStore.workTimes);
  const resume=careerResumeData(m,CareerMetrics.sortSnapshots(snaps));
  return {m,snaps,workStats,resume};
}

async function careerExport(format){
  const {m,snaps,workStats,resume}=careerExportBundle();
  const names=CareerMetrics.exportFileNames(KpiHistory.today());
  let text;
  if(format==='json'){
    text=JSON.stringify(CareerMetrics.buildExportPayload({
      scale:m?m.scale:null,snapshots:snaps,plans:careerStore.collectionPlans,contributions:careerStore.contributions,
      workTimes:careerStore.workTimes,workStats,resume,
    }),null,2);
  }else if(format==='csv'){
    text=CareerMetrics.toMetricsCsv(snaps);
  }else if(format==='md'){
    text=CareerMetrics.toSummaryMarkdown({resume,contributions:careerStore.contributions,snapshots:snaps});
  }else return;
  const name=names[format];
  if(window.routeAPI&&window.routeAPI.isDesktop&&typeof window.routeAPI.saveTextFile==='function'){
    const saved=await window.routeAPI.saveTextFile(name,text,format);
    if(saved&&typeof showToast==='function') showToast('저장했어요 — '+saved);
    return;
  }
  const types={json:'application/json',csv:'text/csv;charset=utf-8',md:'text/markdown;charset=utf-8'};
  const blob=new Blob([text],{type:types[format]});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  if(typeof showToast==='function') showToast(name+' 다운로드');
}

async function careerCopyMarkdown(){
  const {snaps,resume}=careerExportBundle();
  const text=CareerMetrics.toSummaryMarkdown({resume,contributions:careerStore.contributions,snapshots:snaps});
  try{
    await navigator.clipboard.writeText(text);
    if(typeof showToast==='function') showToast('요약 Markdown 을 클립보드에 복사했어요');
  }catch(_){
    openModal({title:'요약 Markdown',body:`<textarea class="cl-in" style="width:100%;height:320px">${clEsc(text)}</textarea>`,wide:true});
  }
}

async function careerImportFile(file){
  if(!file) return;
  try{
    const payload=JSON.parse(await file.text());
    const plan=CareerMetrics.planCareerImport(payload,careerStore);
    let n=0;
    for(const kind of CareerMetrics.CAREER_KIND_IDS){
      for(const item of plan[kind]){ await RouteDB.saveCareerItem(kind,item); n++; }
    }
    await reloadCareerStore();
    if(typeof showToast==='function') showToast(n?`Career Log ${n}건을 가져왔어요`:'새로 가져올 기록이 없어요(이미 있는 기록은 건너뜀)');
  }catch(err){
    if(typeof showToast==='function') showToast('가져오지 못했어요 — '+((err&&err.message)||err));
  }
}
