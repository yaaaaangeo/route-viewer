// ══════════════════════════════════════════════════════════
//  statistics — 지역별/차량별 통계
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  통계 — 지금까지 쌓인 기록의 구역·차량·장소·도로종류·날씨·시간대
//  분포를 막대그래프로 보여준다. 학습 데이터가 특정 조건(예: 맑은 날,
//  자동차전용도로)에만 쏠려있지 않은지 한눈에 확인하는 용도.
// ══════════════════════════════════════════════════════════
let statsZoneFilter='all';
let statsMode='region';
let statsVehicleFilter='all';

// 예전엔 여기 토레스 1~4호가 하드코딩돼 있었다(요구사항 13~14). 이제 [설정] 탭의
// 차량 관리(vehicles 테이블)에서 채워지는 캐시다. VEHICLE_ORDER 는 비활성 차량도
// 포함한다 — 과거 기록의 라벨(normalizeVehicleLabel)은 비활성화해도 정상 표시돼야
// 하기 때문. ACTIVE_VEHICLE_NAMES 만 필터 버튼에 쓰인다.
let VEHICLE_ORDER=[];
let VEHICLE_COLORS={};
let ACTIVE_VEHICLE_NAMES=[];

async function refreshVehicleCache(){
  let vehicles=[];
  try{ vehicles=await RouteDB.listVehicles(); }
  catch(err){ console.warn('[경로뷰어] 차량 설정 불러오기 실패:',err); vehicles=[]; }
  VEHICLE_ORDER=vehicles.map(v=>v.name);
  VEHICLE_COLORS={}; ACTIVE_VEHICLE_NAMES=[];
  vehicles.forEach(v=>{
    if(v.color) VEHICLE_COLORS[v.name]=v.color;
    if(v.active) ACTIVE_VEHICLE_NAMES.push(v.name);
  });
  return vehicles;
}

function setStatsZone(zone){
  statsZoneFilter=zone;
  styleZoneButtons('stats-zone-filter-group',zone);
  renderStatsView();
}

function setStatsMode(mode){
  statsMode=mode;
  renderStatsView();
}

function setStatsVehicle(vehicle){
  statsVehicleFilter=vehicle;
  styleVehicleButtons();
  renderStatsView();
}

function updateStatsModeUI(){
  document.getElementById('stats-type-region').classList.toggle('active',statsMode==='region');
  document.getElementById('stats-type-vehicle').classList.toggle('active',statsMode==='vehicle');
  document.getElementById('region-stats-panel').classList.toggle('active',statsMode==='region');
  document.getElementById('vehicle-stats-panel').classList.toggle('active',statsMode==='vehicle');
}

function styleVehicleButtons(){
  document.querySelectorAll('#stats-vehicle-filter-group .zone-btn').forEach(b=>{
    const isActive=b.dataset.vehicle===statsVehicleFilter;
    b.classList.toggle('active',isActive);
    if(isActive&&statsVehicleFilter!=='all'){
      const color=VEHICLE_COLORS[statsVehicleFilter]||'#4fd8c7';
      b.style.background=color; b.style.borderColor=color; b.style.color='#08110f';
    }else{
      b.style.background=''; b.style.borderColor=''; b.style.color='';
    }
  });
}

function normalizeVehicleLabel(vehicle){
  const text=String(vehicle||'').replace(/\s+/g,' ').trim();
  if(!text||text==='—') return '';
  const matched=VEHICLE_ORDER.find(name=>text.includes(name));
  return matched||text;
}

// DB가 준 [라벨,개수] 목록을 차량 표기 규칙('토레스 3호차' → '토레스 3호')으로 합친다.
// 파일에는 '…호차'로 들어있고 화면 필터 버튼은 '…호'라서 맞춰줘야 한다.
function normalizeVehicleEntries(entries){
  const counts={};
  (entries||[]).forEach(([label,n])=>{
    const v=normalizeVehicleLabel(label);
    if(v) counts[v]=(counts[v]||0)+n;
  });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
}

// showPct=false면 퍼센트 없이 개수만 표시 (특정 구역 하나로 필터된 상태에서는
// 예를 들어 "구역: 강남 100%" 처럼 당연한 숫자가 나와 의미가 없기 때문)
// 이슈로 표시한 파일에서 온 기록은 같은 막대 안에 회색으로 덧그린다(누적 지도의 회색 칸과 같은 색).
// issueCounts: 항목 이름 → 이슈 기록 수(Map). 없으면 예전처럼 한 가지 색 막대만 그린다.
const ISSUE_BAR_COLOR='#7d8798';

function distCardHTML(title,entries,total,showPct,barColor,issueCounts){
  if(!entries.length){
    return `<div class="dist-card"><div class="dc-title">${title}</div><div class="dc-empty">데이터 없음</div></div>`;
  }
  const maxCount=entries[0][1];
  const colorStyle=barColor?`background:${barColor};`:'';
  let issueTotal=0;
  const rows=entries.map(([label,count])=>{
    const barPct=Math.round(count/maxCount*100);
    const issueN=Math.min(count,(issueCounts&&issueCounts.get(label))||0);
    issueTotal+=issueN;
    // 회색 몫은 그 막대 안에서의 비율이다(막대 길이 자체는 전체 기록 수 기준 그대로)
    const issuePct=count?Math.round(issueN/count*100):0;
    const countLabel=showPct?`${count}개 (${total?Math.round(count/total*100):0}%)`:`${count}개`;
    const issueTitle=issueN?` · 이슈 데이터 ${fmtNum(issueN)}개`:'';
    return `
      <div class="dist-row">
        <span class="dist-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <span class="dist-bar-wrap" title="${escapeHtml(label)} ${countLabel}${issueTitle}"><span class="dist-bar" style="width:${barPct}%;${colorStyle}">${
          issueN?`<span class="dist-bar-issue" style="width:${issuePct}%"></span>`:''
        }</span></span>
        <span class="dist-count">${countLabel}</span>
      </div>`;
  }).join('');
  const note=issueTotal
    ? `<div class="dc-issue-note"><span class="dc-issue-swatch"></span>회색 = 이슈로 표시한 파일에서 온 기록 ${fmtNum(issueTotal)}개</div>`
    : '';
  return `<div class="dist-card"><div class="dc-title">${title}</div>${rows}${note}</div>`;
}

const DONUT_COLORS=['#4fd8c7','#f5a623','#8b7cf6','#ff6b6b','#5fd88a','#7d8798'];
function donutCardHTML(title,entries,total,colorFn){
  if(!entries.length){
    return `<div class="dist-card"><div class="dc-title">${title}</div><div class="dc-empty">데이터 없음</div></div>`;
  }
  const getColor=colorFn||((label,i)=>DONUT_COLORS[i%DONUT_COLORS.length]);
  let acc=0;
  const stops=entries.map(([label,count],i)=>{
    const start=total?acc/total*360:0; acc+=count; const end=total?acc/total*360:360;
    return `${getColor(label,i)} ${start}deg ${end}deg`;
  }).join(', ');
  const legend=entries.map(([label,count],i)=>{
    const pct=total?Math.round(count/total*100):0;
    return `
      <div class="donut-legend-row">
        <span class="donut-swatch" style="background:${getColor(label,i)}"></span>
        <span class="donut-label">${escapeHtml(label)}</span>
        <span class="donut-value">${fmtNum(count)}개 (${pct}%)</span>
      </div>`;
  }).join('');
  return `
    <div class="dist-card">
      <div class="dc-title">${title}</div>
      <div class="donut-wrap">
        <div class="donut-ring" style="background:conic-gradient(${stops});"></div>
        <div class="donut-legend">${legend}</div>
      </div>
    </div>`;
}

// 현재 탭/필터 상태를 DB 조회 조건으로
function statsFilter(){
  const filter=statsBaseFilter();
  if(issueFilterActive()) filter.issueFilter=currentIssueFilter();
  return filter;
}

// 데이터 상태 필터를 뺀 조건 — 이슈 비교표는 같은 구역·차량 조건에서 상태별로만 갈라 센다
function statsBaseFilter(){
  if(statsMode==='region'){
    return statsZoneFilter==='all' ? {} : {zone:statsZoneFilter};
  }
  // 차량 필터는 '토레스 3호' 로 고르고 데이터에는 '토레스 3호차' 로 들어있다
  return statsVehicleFilter==='all' ? {} : {vehicleLike:statsVehicleFilter};
}

// 묶음 결과의 이슈 몫 → 항목 이름으로 찾는 Map (막대 안 회색 부분에 쓴다).
// 이슈 몫이 없으면(이슈 파일이 없거나 '이슈 없음'을 보는 중) 전부 null 이라 회색을 그리지 않는다.
function issueShareMaps(issue){
  const empty={zone:null,vehicle:null,place:null,road:null,weather:null,timeOfDay:null};
  if(!issue||!issue.points) return empty;
  const toMap=entries=>new Map((entries||[]).map(([k,n])=>[k,n]));
  return {
    zone:toMap(issue.zones),
    vehicle:toMap(normalizeVehicleEntries(issue.vehicles)),
    place:toMap(issue.place), road:toMap(issue.road), weather:toMap(issue.weather),
    timeOfDay:toMap(issue.timeOfDay.length?issue.timeOfDay:issue.timeBuckets),
  };
}

let statsRenderToken=0;

async function renderStatsView(){
  const token=++statsRenderToken; // 필터를 빠르게 바꿔도 늦게 온 결과가 덮지 않게
  const statusEl=document.getElementById('stats-status');
  const summaryEl=document.getElementById('stats-summary');
  const regionGridEl=document.getElementById('dist-grid');
  const vehicleGridEl=document.getElementById('vehicle-dist-grid');
  updateStatsModeUI();
  renderFilterButtons('stats-zone-filter-group',ACTIVE_ZONE_NAMES.map(z=>({value:z,label:z})),'zone',setStatsZone);
  renderFilterButtons('stats-vehicle-filter-group',ACTIVE_VEHICLE_NAMES.map(v=>({value:v,label:v})),'vehicle',setStatsVehicle);
  styleZoneButtons('stats-zone-filter-group',statsZoneFilter);
  styleVehicleButtons();
  renderIssueFilterButtons('stats-issue-filter');

  let totalStats;
  try{
    totalStats=await RouteDB.stats();
  }catch(err){
    console.warn('[경로뷰어] 통계 집계 실패:',err);
    showError('통계를 계산하지 못했어요. ('+err.message+')');
    return;
  }
  if(token!==statsRenderToken) return;

  if(!totalStats.points){
    statusEl.style.display='block';
    statusEl.innerHTML='아직 쌓인 기록이 없어요. <b>"파일 불러오기"</b> 탭에서 파일을 불러오면 구역·차량·장소·도로종류·날씨·시간대 분포를 여기서 볼 수 있어요.';
    summaryEl.style.display='none';
    regionGridEl.innerHTML='';
    vehicleGridEl.innerHTML='';
    return;
  }
  statusEl.style.display='none';

  const filter=statsFilter();
  // 요약·분포·이슈 몫을 한 번에 받는다. 브라우저 모드(IndexedDB)는 집계마다 전체 기록을
  // 훑기 때문에, 예전처럼 여섯 번 따로 물어보면 8만 건을 여섯 번 훑어서 탭이 몇 초씩 걸렸다.
  // '이슈 없음'을 보고 있으면 회색으로 그릴 이슈 몫이 없으니 그 계산은 건너뛴다.
  const bundle=await RouteDB.getStatsBundle(filter,{
    withIssueShare:currentIssueFilter()!=='clean',
    // 이슈 현황 표는 "전체"를 보고 있을 때만 쓸모가 있다 — 이슈 없음/이슈만을 고른 화면에서는
    // 그 표가 지금 보고 있는 숫자와 어긋나 보여서 아예 빼고, 계산도 하지 않는다.
    withIssueOverview:currentIssueFilter()==='all',
  });
  if(token!==statsRenderToken) return;
  const overview={points:bundle.points,days:bundle.days,zones:bundle.zones,vehicles:bundle.vehicles};
  renderIssueOverview(bundle.issueOverview);

  const activeLabel=statsMode==='region'
    ? (statsZoneFilter==='all'?'전체':statsZoneFilter)
    : (statsVehicleFilter==='all'?'전체':statsVehicleFilter);
  const vehicleDist=normalizeVehicleEntries(overview.vehicles);
  const zoneDist=overview.zones;
  const secondaryDist=statsMode==='region'
    ? vehicleDist.map(([v,c])=>`${escapeHtml(v)} ${fmtNum(c)}`).join(' · ')
    : zoneDist.map(([z,c])=>`${escapeHtml(z)} ${fmtNum(c)}`).join(' · ');

  summaryEl.style.display='grid';
  summaryEl.innerHTML=`
    <div class="stat-cell"><div class="k">누적 일수</div><div class="v">${fmtNum(overview.days)}<small> 일</small></div></div>
    <div class="stat-cell"><div class="k">총 기록 지점</div><div class="v">${fmtNum(overview.points)}<small> 개</small></div></div>
    <div class="stat-cell"><div class="k">${statsMode==='region'?'지역':'차량'}</div><div class="v" style="font-size:13px;">${escapeHtml(activeLabel)}</div></div>
    <div class="stat-cell"><div class="k">${statsMode==='region'?'차량':'지역'}</div><div class="v" style="font-size:13px;">${secondaryDist||'—'}</div></div>
  `;

  if(!overview.points){
    const emptyHTML=`<div class="dist-card" style="grid-column:1/-1;"><div class="dc-empty">선택한 ${statsMode==='region'?'지역':'차량'}(${escapeHtml(activeLabel)})에는 아직 기록이 없어요.</div></div>`;
    regionGridEl.innerHTML=statsMode==='region'?emptyHTML:'';
    vehicleGridEl.innerHTML=statsMode==='vehicle'?emptyHTML:'';
    return;
  }

  const placeDist=bundle.place, roadDist=bundle.road, weatherDist=bundle.weather;
  // 파일에 '시간대' 열이 있으면 그 값 그대로, 없으면 시각을 4시간 묶음으로
  const timeDist=bundle.timeOfDay.length?bundle.timeOfDay:bundle.timeBuckets;
  // 막대 안에 회색으로 겹쳐 그릴 "이슈 파일에서 온 기록" 몫(항목 이름 → 개수)
  const issueShare=issueShareMaps(bundle.issue);

  const total=overview.points;
  const showPct=statsMode==='vehicle'||statsZoneFilter==='all';
  const barColor=statsMode==='region'
    ? (statsZoneFilter==='all' ? null : ZONE_COLORS[statsZoneFilter])
    : (statsVehicleFilter==='all' ? null : VEHICLE_COLORS[statsVehicleFilter]);
  const cardsHTML=[];

  if(statsMode==='region'){
    if(statsZoneFilter==='all'){
      cardsHTML.push(donutCardHTML('구역',zoneDist,total,
        (label,i)=>ZONE_COLORS[label]||DONUT_COLORS[i%DONUT_COLORS.length]));
    }
    cardsHTML.push(distCardHTML('차량',vehicleDist,total,showPct,barColor,issueShare.vehicle));
  }else{
    if(statsVehicleFilter==='all'){
      cardsHTML.push(donutCardHTML('차량',vehicleDist,total,
        (label,i)=>VEHICLE_COLORS[label]||DONUT_COLORS[i%DONUT_COLORS.length]));
    }
    cardsHTML.push(distCardHTML('구역',zoneDist,total,true,barColor,issueShare.zone));
  }
  cardsHTML.push(distCardHTML('장소',placeDist,total,showPct,barColor,issueShare.place));
  cardsHTML.push(distCardHTML('도로종류',roadDist,total,showPct,barColor,issueShare.road));
  cardsHTML.push(distCardHTML('날씨',weatherDist,total,showPct,barColor,issueShare.weather));
  // 파일의 '시간대' 열 원본(nav-app이 넣은 주간/일몰) — 아래 교통 시간대·조도 조건과는 다른, 그대로 보존하는 값
  cardsHTML.push(distCardHTML('파일 원본 시간대',timeDist,total,showPct,barColor,issueShare.timeOfDay));

  // ── 교통 시간대 · 조도 조건 · 요일 — 날짜 요약의 조건 칸을 더한다(SQLite/IndexedDB 같은 함수) ──
  let summaries=[];
  try{ summaries=await RouteDB.listDateSummaries(); }
  catch(err){ console.warn('[경로뷰어] 날짜 요약 조회 실패:',err); }
  if(token!==statsRenderToken) return;
  cardsHTML.push(...conditionStatsCardsHTML(summaries,filter,barColor));

  regionGridEl.innerHTML=statsMode==='region'?cardsHTML.join(''):'';
  vehicleGridEl.innerHTML=statsMode==='vehicle'?cardsHTML.join(''):'';
}

// 통계 탭의 조건 카드들. filter 는 statsFilter()({zone} 또는 {vehicleLike}) — 기록 수 카드들과 같은 조건.
function conditionStatsCardsHTML(summaries,filter,barColor){
  const signature=currentClassificationSignature();
  const agg=groupBy=>ConditionStats.aggregate(summaries,{filter,groupBy,signature});
  // 이슈 파일에서 온 수집 시간만 따로 — 막대 안에 회색으로 겹쳐 그린다
  // ('이슈 없음'을 보고 있으면 회색이 나올 데이터가 없으므로 계산하지 않는다)
  const issueSec=groupBy=>{
    if(currentIssueFilter()==='clean') return null;
    const rows=ConditionStats.aggregate(summaries,{filter:{...filter,issueFilter:'issue_all'},groupBy,signature}).rows;
    return new Map(rows.map(r=>[r[groupBy[0]],r.collectionSec]));
  };
  const traffic=agg(['trafficPeriod']);
  const light=agg(['lightCondition']);
  const weekday=agg(['weekdayType']);
  const cards=[];
  if(traffic.staleDates>0){
    cards.push(`<div class="dist-card cond-stale-card" style="grid-column:1/-1;"><div class="ir-note warn" style="margin:0;">분류 기준이 바뀐 뒤 아직 다시 분류하지 않은 날짜가 ${fmtNum(traffic.staleDates)}일 있어요. 아래 교통 시간대·조도 분포에는 그 날짜가 예전 기준으로 섞여 있어요 — [설정] 탭에서 재분류해 주세요.</div></div>`);
  }
  // 막대 색은 위쪽 분포 카드와 같은 규칙 — 지역/차량을 고르면 그 색, 전체면 기본 색
  const card=(title,rows,dim,issueMap)=>{
    const issueTotal=[...(issueMap||new Map()).values()].reduce((a,v)=>a+v,0);
    const note=issueTotal
      ? `<div class="dc-issue-note"><span class="dc-issue-swatch"></span>회색 = 이슈로 표시한 파일에서 온 수집 시간 ${fmtNum(Math.round(issueTotal/60))}분</div>`
      : '';
    return `<div class="dist-card cond-card" data-axis="${dim}"><div class="dc-title">${title}</div>${conditionDistRowsHTML(rows,dim,issueMap,barColor)}${note}</div>`;
  };
  cards.push(card('교통 시간대 · 수집 시간 / 기록 수',traffic.rows,'trafficPeriod',issueSec(['trafficPeriod'])));
  cards.push(card('조도 조건 · 수집 시간 / 기록 수',light.rows,'lightCondition',issueSec(['lightCondition'])));
  cards.push(card('평일 · 주말 · 수집 시간 / 기록 수',weekday.rows,'weekdayType',issueSec(['weekdayType'])));
  cards.push(`<div class="dist-card cond-card"><div class="dc-title">분류 기준</div><div class="cond-note">교통 시간대는 고정 시각 구간(설정 탭에서 수정), 조도 조건은 날짜·GPS로 계산한 일출·일몰 ±${currentClassificationConfig().sunriseWindowMinutes}/${currentClassificationConfig().sunsetWindowMinutes}분 기준이에요. 수집 시간은 90초 넘는 GPS 공백을 뺀 유효 수집 시간이에요.</div></div>`);

  // 구역별(지역 모드) / 차량별(차량 모드) × 교통 시간대 · 조도 조건 — 수집 분
  const rowDim=statsMode==='region'?'zone':'vehicle';
  cards.push(conditionMatrixCardHTML(summaries,filter,rowDim,'trafficPeriod',signature));
  cards.push(conditionMatrixCardHTML(summaries,filter,rowDim,'lightCondition',signature));
  return cards;
}

function conditionMatrixCardHTML(summaries,filter,rowDim,colDim,signature){
  const rows=ConditionStats.aggregate(summaries,{filter,groupBy:[rowDim,colDim],signature}).rows;
  const rowLabel=v=>rowDim==='vehicle'?(normalizeVehicleLabel(v)||'정보 없음'):(v||'정보 없음');
  // 차량은 '토레스 3호차' → '토레스 3호' 로 합친다(normalizeVehicleEntries 와 같은 규칙)
  const table=new Map();
  rows.forEach(r=>{
    const rk=rowLabel(r[rowDim]);
    if(!table.has(rk)) table.set(rk,new Map());
    const cell=table.get(rk).get(r[colDim])||{sec:0,n:0};
    cell.sec+=r.collectionSec; cell.n+=r.recordCount;
    table.get(rk).set(r[colDim],cell);
  });
  const cols=ConditionStats.DIMENSION_ORDERS[colDim].filter(id=>id!==TimeConditions.UNKNOWN||rows.some(r=>r[colDim]===id));
  const title=`${rowDim==='zone'?'구역':'차량'}별 ${colDim==='trafficPeriod'?'교통 시간대':'조도 조건'} · 수집 분`;
  if(!table.size){
    return `<div class="dist-card cond-card" style="grid-column:1/-1;"><div class="dc-title">${title}</div><div class="dc-empty">데이터 없음</div></div>`;
  }
  const head=cols.map(c=>`<th scope="col">${escapeHtml(ConditionStats.dimensionValueLabel(colDim,c))}</th>`).join('');
  const body=[...table.entries()].sort((a,b)=>a[0].localeCompare(b[0],'ko')).map(([rk,m])=>
    `<tr><th scope="row">${escapeHtml(rk)}</th>${cols.map(c=>{
      const cell=m.get(c);
      return cell?`<td class="mono" title="${fmtNum(cell.n)}개 기록">${fmtNum(Math.round(cell.sec/60))}</td>`:'<td class="mono cond-zero">0</td>';
    }).join('')}</tr>`).join('');
  return `<div class="dist-card cond-card cond-matrix-card" data-rows="${rowDim}" data-cols="${colDim}" style="grid-column:1/-1;">
    <div class="dc-title">${title}</div>
    <div class="cond-matrix-wrap"><table class="cond-matrix"><thead><tr><th scope="col">${rowDim==='zone'?'구역':'차량'}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
//  이슈 현황 · 전체 / 이슈 없음 / 이슈 데이터 비교
//
//  같은 구역·차량 조건에서 데이터 상태별 기록 수만 갈라 센다(getIssueOverview).
//  "이슈 데이터"는 이슈 파일에서 온 기록이고, 한 기록이 정상 파일에서도 왔다면
//  '이슈 없음'과 '이슈 데이터' 양쪽에 모두 들어간다 — 합이 전체보다 클 수 있다.
// ══════════════════════════════════════════════════════════
// ov: getStatsBundle 이 같은 스캔에서 만들어 준 이슈 현황(따로 조회하지 않는다).
// "전체 데이터"를 보고 있을 때만 그린다(ov 가 null 이면 표를 비운다).
function renderIssueOverview(ov){
  const box=document.getElementById('stats-issue-overview');
  if(!box) return;
  if(!ov){ box.innerHTML=''; return; }
  const counts=ov.recordCounts||{};
  const pct=n=>counts.all?`${(n/counts.all*100).toFixed(1)}%`:'—';
  const row=(label,key,note)=>`
    <tr${currentIssueFilter()===key?' class="issue-row-active"':''}>
      <td>${escapeHtml(label)}</td>
      <td class="mono">${fmtNum(counts[key]||0)}</td>
      <td class="mono">${pct(counts[key]||0)}</td>
      <td class="issue-row-note">${escapeHtml(note)}</td>
    </tr>`;
  box.innerHTML=`
    <div class="dist-card" style="grid-column:1/-1;">
      <div class="dc-title">이슈 현황 <span class="ds-hint">Import 파일 ${fmtNum(ov.importCount)}개 중 이슈 ${fmtNum(ov.issueImportCount)}개 · 확인 필요 ${fmtNum(ov.openCount)} · 확인 완료 ${fmtNum(ov.resolvedCount)}</span></div>
      <div class="rec-table-wrap">
        <table class="rec-table issue-compare">
          <thead><tr><th>데이터 상태</th><th>기록 수</th><th>비율</th><th>설명</th></tr></thead>
          <tbody>
            ${row('전체 데이터','all','이슈 여부와 상관없이 저장된 모든 기록')}
            ${row('이슈 없는 데이터','clean','확인 필요 이슈 파일에서만 온 기록을 뺀 값')}
            ${row('이슈 데이터','issue_all',`이슈로 표시한 파일에서 온 기록 — 아래 막대와 누적 지도에서 회색${ov.openRecordCount?` (그중 확인 필요 ${fmtNum(ov.openRecordCount)}개)`:''}`)}
          </tbody>
        </table>
      </div>
      <div class="cond-note">아래 막대의 <span class="dc-issue-swatch" style="vertical-align:middle;"></span> 회색 부분이 이슈 데이터 몫이에요(누적 지도의 회색 점과 같은 뜻).
        위 <b>데이터 상태</b> 버튼으로 '이슈 없음'·'이슈만'을 고르면 아래 분포가 그 기준으로 다시 계산돼요(그때는 이 표를 숨깁니다).
        한 기록이 이슈 파일과 정상 파일 양쪽에서 왔을 수 있어서 '이슈 없음'과 '이슈 데이터'의 합은 전체보다 클 수 있어요.${
        ov.unlinkedRecords?` 출처 기록이 없는 예전 데이터 ${fmtNum(ov.unlinkedRecords)}개는 어떤 이슈에도 묶이지 않고 '이슈 없는 데이터'에 남아요.`:''}
        ${ov.conflictCount?`동기화 중 이슈가 겹쳐 최신 값으로 정리된 파일이 ${fmtNum(ov.conflictCount)}개 있어요([데이터 관리] 탭에서 확인).`:''}</div>
    </div>`;
}
