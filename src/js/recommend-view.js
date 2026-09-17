// ══════════════════════════════════════════════════════════
//  recommend-view — "추천 주행" 탭 화면
//
//  계산은 전부 recommendation.js(순수 함수)가 한다. 이 파일은
//    ① 작은 입력(날짜 요약·구역·설정·Coverage 스냅샷·추천 상태)만 저장소에서 읽고
//    ② 결과를 캐시하고
//    ③ 카드·근거·부족 현황·설정·한계를 그린다.
//  원본 GPS 기록은 읽지 않는다(날짜 요약의 조건 칸만 사용).
//
//  캐시 키 = 데이터 · 구역 · 수동 셀 · Coverage 스냅샷 · 분류 기준 · 추천 설정 revision + 차량 필터 + 오늘(한국 날짜).
//  revision 은 저장소 변경 알림(RouteDB.onChange / sync 의 notifyChange)으로만 올라간다 — 탭을 오가기만 하면
//  DB 를 다시 읽지도, 다시 계산하지도 않는다. 날짜가 바뀌면(최근 미방문 기간·다음 평일 기준일이 달라짐) 다시 계산한다.
//  추천 상태(숨김·기간 제외·완료 표시)는 점수와 무관해서 표시만 다시 그린다.
// ══════════════════════════════════════════════════════════

const recFilters={zone:'all',weekdayType:'all',trafficPeriod:'all',lightCondition:'all',weather:'all',vehicle:'',minConfidence:'low'};
let recSort='score';
const recRevisions={data:0,zone:0,manual:0,coverage:0,classification:0,settings:0};
let recCache={key:null,result:null};
let recStates={};
const recSessionHidden=new Set();   // "이번에는 숨기기" — 저장하지 않음
const recOpenDetails=new Set();     // 근거 보기를 펼친 추천 id
let recRenderToken=0;
let recSettingsForm=null;           // 아직 저장하지 않은 추천 설정 입력값
let recommendationClock=()=>Date.now(); // 테스트가 날짜를 고정할 수 있게
const recommendStats={fetches:0,computations:0,renders:0,staleDiscards:0,cacheHits:0};

function onRecommendDataChanged(evt){
  const m=evt&&evt.method, args=(evt&&evt.args)||[];
  // 이슈 상태가 바뀌면 같은 기록이라도 데이터 상태 필터에 걸리고 안 걸리고가 달라진다
  if(m==='importRecords'||m==='deleteDate'||m==='deleteAll'||m==='updateImportIssue'||m==='restoreImports') recRevisions.data++;
  else if(m==='restoreBackupPayload'||m==='sync'){
    // 복원·동기화는 기록·구역·수동 셀·설정을 모두 바꿀 수 있다
    recRevisions.data++; recRevisions.zone++; recRevisions.manual++; recRevisions.classification++; recRevisions.settings++;
  }
  else if(m==='saveZonePolygons'||m==='saveZone'||m==='setZoneActive') recRevisions.zone++;
  else if(m==='saveZoneManualCells') recRevisions.manual++;
  else if(m==='saveCoverageSnapshot') recRevisions.coverage++;
  else if(m==='reclassifySummaries') recRevisions.classification++;
  else if(m==='setSettings'){
    const p=args[0]||{};
    if('recommendationSettings' in p){ recRevisions.settings++; recSettingsForm=null; }
    if(TimeConditions.CLASSIFICATION_SETTING_KEYS.some(k=>k in p)) recRevisions.classification++;
  }
}
if(typeof RouteDB!=='undefined'&&RouteDB&&typeof RouteDB.onChange==='function') RouteDB.onChange(onRecommendDataChanged);

function recommendationCacheKey(){
  return JSON.stringify({
    version:Recommendation.RECOMMENDATION_VERSION,
    dataRevision:recRevisions.data, zoneRevision:recRevisions.zone, manualCoverageRevision:recRevisions.manual,
    coverageSnapshotRevision:recRevisions.coverage, timeClassificationRevision:recRevisions.classification,
    recommendationSettingsRevision:recRevisions.settings,
    vehicle:recFilters.vehicle, today:Recommendation.kstDate(recommendationClock()),
    issueFilter:recommendationIssueFilter(),
  });
}

// 탭에 들어올 때·필터(차량)를 바꿀 때 부른다. 입력이 같으면 캐시만 다시 그린다.
// 추천은 공용 데이터 상태 필터를 따른다. 다만 공용 필터가 '전체'일 때는 확인 필요 이슈 데이터를
// 뺀 기준으로 센다 — 아직 확인하지 않은 데이터로 "여기는 이미 충분하다"고 판단하면 안 되기 때문이다.
// 이슈 데이터까지 넣어서 보고 싶으면 '이슈만'·'확인 필요' 필터를 고르면 된다.
function recommendationIssueFilter(){
  return issueFilterActive()?currentIssueFilter():'clean';
}

async function renderRecommendView(){
  renderIssueFilterButtons('rec-issue-filter');
  const key=recommendationCacheKey();
  if(recCache.key===key&&recCache.result){
    recommendStats.cacheHits++;
    renderRecommendationResult();
    return recCache.result;
  }
  const token=++recRenderToken;
  const statusEl=document.getElementById('rec-status');
  if(statusEl){ statusEl.style.display='block'; statusEl.textContent='추천을 계산하는 중… (날짜 요약·구역·설정만 읽어요)'; }
  let inputs;
  try{
    recommendStats.fetches++;
    const [summaries,zones,settings,coverageSnapshots,states]=await Promise.all([
      RouteDB.listDateSummaries(),RouteDB.listZones(),RouteDB.getSettings(),RouteDB.listCoverageSnapshots(),RouteDB.listRecommendationStates(),
    ]);
    inputs={summaries,zones,settings,coverageSnapshots,states};
  }catch(err){
    if(token===recRenderToken){
      console.warn('[경로뷰어] 추천 입력 읽기 실패:',err);
      if(statusEl) statusEl.textContent='추천에 필요한 데이터를 읽지 못했어요. ('+((err&&err.message)||err)+')';
    }
    return null;
  }
  // 늦게 끝난 예전 계산이 최신 화면을 덮지 않게 — 그 사이 다른 렌더가 시작됐거나 입력이 바뀌었으면 버린다
  if(token!==recRenderToken){ recommendStats.staleDiscards++; return null; }
  if(recommendationCacheKey()!==key){ recommendStats.staleDiscards++; return renderRecommendView(); }
  recommendStats.computations++;
  const result=Recommendation.buildRecommendations({
    summaries:inputs.summaries, zones:inputs.zones, settings:inputs.settings,
    coverageSnapshots:inputs.coverageSnapshots, now:recommendationClock(), vehicle:recFilters.vehicle,
    issueFilter:recommendationIssueFilter(),
  });
  recStates=inputs.states||{};
  recCache={key,result,appSettings:inputs.settings,zones:inputs.zones};
  // 세부 구역(2단계) 집계·추천은 따로 계산한다 — 구역 경계 안 기록을 훑어야 해서 시간이 더 든다
  if (typeof refreshSubZones === 'function') refreshSubZones({ quiet: true });
  renderRecommendationResult();
  return result;
}

// ── 그리기 ────────────────────────────────────────────
const recEsc=s=>escapeHtml(s==null?'':s);
const recPct=v=>v==null?'—':`${(Math.round(v*10)/10).toFixed(1)}%`;
const confidenceClass=level=>`rec-conf-${level}`;

function currentRecommendationView(){
  const res=recCache.result;
  if(!res) return {visible:[],hidden:[],all:[]};
  const filtered=Recommendation.filterRecommendations(res.recommendations,recFilters,res.settings);
  const sorted=Recommendation.sortRecommendations(filtered,recSort);
  const states=Recommendation.applyRecommendationStates(sorted,recStates,recSessionHidden,recommendationClock());
  return {visible:states.visible.slice(0,res.settings.resultCount),hidden:states.hidden,all:states.visible,filteredCount:filtered.length};
}

function renderRecommendationResult(){
  const res=recCache.result;
  if(!res) return;
  recommendStats.renders++;
  const statusEl=document.getElementById('rec-status');
  if(statusEl){ statusEl.style.display='none'; statusEl.textContent=''; }
  renderRecommendationSummary(res);
  if (typeof renderSubZoneSection === 'function') renderSubZoneSection();
  renderDrivePlan();
  renderRecommendationFilters(res);
  const view=currentRecommendationView();
  renderRecommendationList(res,view);
  renderRecommendationHidden(view);
  renderRecommendationDeficits(res);
  renderRecommendationSettings(res);
  renderRecommendationLimitations(res);
}

function renderRecommendationSummary(res){
  const el=document.getElementById('rec-summary');
  if(!el) return;
  if(res.empty){
    el.innerHTML=`<div class="rec-empty"><div class="rec-empty-title">추천할 수 없어요</div><div>${recEsc(res.emptyReason)}</div></div>`;
    return;
  }
  const d=res.dataset;
  const counts={very_high:0,high:0,medium:0,low:0};
  res.recommendations.forEach(r=>{ if(counts[r.priority]!=null) counts[r.priority]++; });
  const kpiRows=d.kpi.rows.map(r=>`<span class="rec-kpi">${recEsc(r.label)} 목표 ${fmtNum(r.targetMinutes)}분 중 수집 ${fmtNum(r.collectedMinutes)}분(${CollectionStats.formatPercent(r.percent)}) · 부족 ${fmtNum(Math.max(0,r.targetMinutes-r.collectedMinutes))}분</span>`).join('');
  const top=res.recommendations[0];
  el.innerHTML=`
    <div class="rec-summary-head">
      <div class="rec-summary-title">추천 요약</div>
      <div class="mono rec-summary-meta">기준일 ${recEsc(res.today)} (한국 시간) · 데이터 ${d.dateRange?`${recEsc(d.dateRange.from)} ~ ${recEsc(d.dateRange.to)}`:'—'} · ${fmtNum(d.dateCount)}일 · ${fmtNum(d.recordCount)}건${res.vehicleFilter?` · 차량 필터 ${recEsc(res.vehicleFilter)}`:''}</div>
    </div>
    <div class="rec-summary-grid">
      <div class="stat-cell"><div class="k">추천 후보</div><div class="v">${fmtNum(res.candidateCount)}<small> 개</small></div></div>
      <div class="stat-cell"><div class="k">매우 높음 · 높음</div><div class="v">${fmtNum(counts.very_high)} · ${fmtNum(counts.high)}</div></div>
      <div class="stat-cell"><div class="k">보통 · 낮음</div><div class="v">${fmtNum(counts.medium)} · ${fmtNum(counts.low)}</div></div>
      <div class="stat-cell"><div class="k">1순위</div><div class="v rec-summary-top">${top?`${recEsc(top.zone)} · ${recEsc(top.conditionLabel)}`:'—'}</div></div>
    </div>
    <div class="rec-kpis">${kpiRows}</div>
    <div class="rec-disclaimer-inline">${recEsc(res.issueBasisText)}${res.issueFilter==='clean'?' (확인 완료 이슈와 이슈 없는 데이터는 포함)':''}</div>`;
}

function optionHTML(value,label,current){
  return `<option value="${recEsc(value)}"${String(current)===String(value)?' selected':''}>${recEsc(label)}</option>`;
}

function renderRecommendationFilters(res){
  const el=document.getElementById('rec-filters');
  if(!el) return;
  const zones=res.zones.map(z=>z.zone);
  const weathers=res.dataset.weatherCategories;
  const fleet=res.dataset.fleet;
  const sel=(id,name,opts,current)=>`<label class="rec-filter"><span>${name}</span><select id="${id}" onchange="setRecommendationFilter('${id.replace('rec-filter-','')}',this.value)">${opts.map(([v,l])=>optionHTML(v,l,current)).join('')}</select></label>`;
  el.innerHTML=[
    sel('rec-filter-zone','구역',[['all','전체 구역'],...zones.map(z=>[z,z])],recFilters.zone),
    sel('rec-filter-weekdayType','요일',[['all','평일·주말'],...TimeConditions.WEEKDAY_TYPE_IDS.map(id=>[id,TimeConditions.WEEKDAY_TYPE_LABELS[id]])],recFilters.weekdayType),
    sel('rec-filter-trafficPeriod','교통 시간대',[['all','전체'],...TimeConditions.TRAFFIC_PERIOD_IDS.map(id=>[id,TimeConditions.TRAFFIC_PERIOD_LABELS[id]])],recFilters.trafficPeriod),
    sel('rec-filter-lightCondition','조도',[['all','전체'],...TimeConditions.LIGHT_CONDITION_IDS.map(id=>[id,TimeConditions.LIGHT_CONDITION_LABELS[id]])],recFilters.lightCondition),
    sel('rec-filter-weather','날씨',[['all','전체'],...weathers.map(w=>[w,w])],recFilters.weather),
    sel('rec-filter-vehicle','차량',[['','전체 차량'],...fleet.map(v=>[v,v])],recFilters.vehicle),
    sel('rec-filter-minConfidence','최소 신뢰도',[['low','낮음 이상'],['medium','보통 이상'],['high','높음만']],recFilters.minConfidence),
    `<label class="rec-filter"><span>정렬</span><select id="rec-sort" onchange="setRecommendationSort(this.value)">${Object.entries(Recommendation.SORT_LABELS).map(([v,l])=>optionHTML(v,l,recSort)).join('')}</select></label>`,
  ].join('');
}

function setRecommendationFilter(name,value){
  if(!(name in recFilters)) return;
  recFilters[name]=value||(name==='vehicle'?'':'all');
  // 차량 필터는 집계 자체가 달라져서 다시 계산, 나머지는 결과를 거르기만 한다
  if(name==='vehicle') return renderRecommendView();
  renderRecommendationResult();
}

function setRecommendationSort(value){
  recSort=Recommendation.SORT_LABELS[value]?value:'score';
  renderRecommendationResult();
}

function recommendationCardHTML(r,rank,res){
  const open=recOpenDetails.has(r.id);
  const idArg=recEsc(JSON.stringify(r.id));
  const tr=r.timeRange;
  const cov=r.coverage.available
    ? `${recPct(r.coverage.coveragePercent)} · 미방문 Cell ${fmtNum(r.coverage.unvisitedCellCount)}개${r.coverage.provisional?' (임시값)':''}`
    : `<span class="rec-muted">${recEsc(r.coverage.reason||'계산값 없음')}</span>`;
  const weatherText=r.condition.weather?` · 날씨 '${recEsc(r.condition.weather)}'일 때 우선`:'';
  return `
  <article class="rec-card rec-priority-${recEsc(r.priority)}${r.reopened?' rec-reopened':''}" data-rec-id="${recEsc(r.id)}">
    <div class="rec-card-head">
      <div class="rec-rank">추천 ${rank}</div>
      <div class="rec-card-title">${recEsc(r.zone)} <span class="rec-cond">${conditionBadgesHTML(r.condition,['weekdayType','trafficPeriod','lightCondition','weather'].filter(k=>r.condition[k]))}</span></div>
      <div class="rec-score"><span class="mono rec-score-v">${r.score==null?'—':r.score.toFixed(1)}</span><span class="rec-score-u">점</span></div>
    </div>
    <div class="rec-badges">
      <span class="rec-badge rec-prio">우선순위 ${recEsc(r.priorityLabel)}</span>
      <span class="rec-badge ${confidenceClass(r.confidence.level)}">신뢰도 ${recEsc(r.confidence.label)}</span>
      ${r.reopened?`<span class="rec-badge rec-reopen">다시 추천</span>`:''}
    </div>
    ${r.stateNote?`<div class="ir-note rec-state-note">${recEsc(r.stateNote)}</div>`:''}
    <div class="rec-grid">
      <div><span class="rec-k">권장 요일</span><b>${recEsc(TimeConditions.WEEKDAY_TYPE_LABELS[r.condition.weekdayType])}</b></div>
      <div><span class="rec-k">권장 시간</span><b class="mono">${tr?`${recEsc(tr.start)}~${recEsc(tr.end)}`:'—'}</b>${weatherText}</div>
      <div><span class="rec-k">현재 수집 / 목표</span><b class="mono">${fmtNum(r.current.collectionMinutes)}분 / ${fmtNum(r.need.targetMinutes)}분</b></div>
      <div><span class="rec-k">부족한 수집 시간</span><b class="mono">${fmtNum(r.need.additionalMinutes)}분</b></div>
      <div><span class="rec-k">현재 방문 / 목표</span><b class="mono">${fmtNum(r.current.visitCount)}회 / ${fmtNum(r.need.targetVisits)}회</b></div>
      <div><span class="rec-k">권장 추가</span><b class="mono">${fmtNum(r.need.additionalVisits)}회 · 약 ${fmtNum(r.need.estimatedMinutesThisStage)}분</b>${r.need.staged?` <span class="rec-muted">(${recEsc(r.need.stageNote)})</span>`:''}</div>
      <div><span class="rec-k">현재 Coverage</span><span class="mono">${cov}</span></div>
      <div><span class="rec-k">마지막 방문</span><span class="mono">${r.current.lastVisitedAt?`${recEsc(r.current.lastVisitedAt.slice(0,10))} (${fmtNum(r.current.daysSinceLastVisit)}일 전)`:'방문 기록 없음'}</span></div>
    </div>
    ${tr&&tr.sunText?`<div class="rec-muted rec-time-note">${recEsc(tr.conditionText)} · ${recEsc(tr.sunText)}</div>`:''}
    <div class="rec-block"><span class="rec-k">부족한 조건</span><ul class="rec-facts">${(r.deficitConditions.length?r.deficitConditions:['부족도 40점 이상인 항목 없음']).map(f=>`<li>${recEsc(f)}</li>`).join('')}</ul></div>
    <div class="rec-block"><span class="rec-k">예상 확보 조건</span> ${r.expectedConditions.length?r.expectedConditions.map(x=>`<span class="rec-chip">${recEsc(x)}</span>`).join(''):'<span class="rec-muted">이 조건에 해당하는 규칙 없음</span>'}
      <div class="rec-disclaimer-inline">${recEsc(r.edgeCaseDisclaimer)}</div></div>
    <div class="rec-block rec-reason"><span class="rec-k">추천 이유</span> ${recEsc(r.reason)}</div>
    <div class="rec-actions">
      <button class="btn ghost" type="button" onclick="toggleRecommendationDetail(${idArg})">${open?'근거 닫기':'근거 보기'}</button>
      <button class="btn ghost" type="button" onclick="hideRecommendationOnce(${idArg})">이번에는 숨기기</button>
      <button class="btn ghost" type="button" onclick="snoozeRecommendation(${idArg})">${fmtNum(res.settings.snoozeDays)}일간 제외</button>
      <button class="btn ghost" type="button" onclick="completeRecommendation(${idArg})">수집 완료로 표시</button>
    </div>
    ${open?recommendationDetailHTML(r):''}
  </article>`;
}

function recommendationDetailHTML(r){
  const rows=r.breakdown.map(b=>`
    <tr class="${b.excluded?'rec-excluded':''}" data-score-key="${recEsc(b.key)}">
      <th scope="row">${recEsc(b.label)}</th>
      <td>${recEsc(b.current)}</td>
      <td class="mono">${b.excluded?'제외':b.value.toFixed(1)}</td>
      <td class="mono">${b.weight}%</td>
      <td class="mono">${b.excluded?'—':b.effectiveWeight.toFixed(2)+'%'}</td>
      <td class="mono">${b.excluded?'—':b.contribution.toFixed(2)}</td>
    </tr>
    <tr class="rec-basis-row"><td colspan="6">비교 기준: ${recEsc(b.basis)}</td></tr>`).join('');
  const sumText=r.breakdown.filter(b=>!b.excluded).map(b=>b.contribution.toFixed(2)).join(' + ');
  const payload=Recommendation.toLlmPayload(r);
  return `
  <div class="rec-detail">
    <div class="rec-detail-title">추천 근거 상세</div>
    <div class="mono rec-check">최종 점수 ${r.score==null?'—':r.score.toFixed(1)} = ${recEsc(sumText||'—')}${r.availableWeight<100?` · 데이터가 없는 항목을 뺀 가중치 합 ${r.availableWeight}%를 100%로 다시 나눔`:''}</div>
    <div class="rec-table-wrap"><table class="rec-table">
      <thead><tr><th>평가 항목</th><th>현재 상태</th><th>점수</th><th>가중치</th><th>적용 가중치</th><th>반영 점수</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="rec-detail-grid">
      <div><div class="rec-k">목표·비교 기준</div><ul class="rec-facts">
        <li>교통 시간대 목표: ${fmtNum(r.targets.periodMinutes)}분 · ${fmtNum(r.targets.periodVisits)}회 — ${recEsc(r.targets.periodBasis)}</li>
        <li>이 조건 목표: ${fmtNum(r.targets.minutes)}분 · ${fmtNum(r.targets.visits)}회 (시간대 목표 × 조도 비율 ${recPct(r.targets.lightShare*100)})</li>
        <li>최소 고유 수집일 ${fmtNum(r.targets.minUniqueDays)}일 · 현재 ${fmtNum(r.current.uniqueDays)}일</li>
        <li>목표 Coverage ${recEsc(r.targets.coveragePercent)}%</li>
        <li>권장 횟수: ${recEsc(r.need.basis)}</li>
        <li>${recEsc(r.need.efficiencyBasis)}</li>
        ${r.need.stageNote?`<li>${recEsc(r.need.stageNote)}</li>`:''}
      </ul></div>
      <div><div class="rec-k">권장 시간 계산</div><ul class="rec-facts">
        <li>${recEsc(r.timeRange?r.timeRange.conditionText:'—')}</li>
        <li>교통 시간대 ${recEsc(r.timeRange?r.timeRange.periodText:'—')} · 권장 ${recEsc(r.timeRange?`${r.timeRange.start}~${r.timeRange.end} (${r.timeRange.minutes}분)`:'—')}</li>
        ${r.timeRange&&r.timeRange.sunText?`<li>${recEsc(r.timeRange.sunText)}</li>`:''}
      </ul></div>
      <div><div class="rec-k">적용된 Edge Case 규칙</div><ul class="rec-facts">${r.predictedEdgeCaseHints.length?r.predictedEdgeCaseHints.map(h=>`<li><code>${recEsc(h.code)}</code> ${recEsc(h.label)} — 근거 <code>${recEsc(h.evidence)}</code></li>`).join(''):'<li>없음</li>'}
        ${r.skippedEdgeCaseRules.map(h=>`<li class="rec-muted"><code>${recEsc(h.code)}</code> 적용 안 함 — ${recEsc(h.reason)}</li>`).join('')}
        ${r.supportingObservations.map(o=>`<li class="rec-muted">참고 관찰: ${recEsc(o)}</li>`).join('')}
        <li class="rec-muted">근거 수준: ${recEsc(r.edgeCaseEvidenceLevel)} · 실제 이벤트 기록 ${fmtNum(r.observedEdgeCases.length)}건</li>
      </ul></div>
      <div><div class="rec-k">데이터 범위 · 누락 · 신뢰도</div><ul class="rec-facts">
        <li>사용한 데이터: ${recEsc(r.dataRange.from||'—')} ~ ${recEsc(r.dataRange.to||'—')} · ${fmtNum(r.dataRange.dateCount)}일${r.dataRange.vehicleFilter?` · 차량 ${recEsc(r.dataRange.vehicleFilter)}`:''}</li>
        <li>마지막 방문: ${recEsc(r.current.lastVisitedAt||'없음')}</li>
        ${r.missingData.length?r.missingData.map(m=>`<li>누락: ${recEsc(m)}</li>`).join(''):'<li>누락된 평가 항목 없음</li>'}
        <li>신뢰도 ${recEsc(r.confidence.label)}: ${r.confidence.reasons.map(x=>recEsc(x.text)).join(' · ')}</li>
      </ul></div>
    </div>
    <details class="rec-llm"><summary>LLM 전달용 구조화 데이터(원본 GPS·사람 이름·차량 이름 제외)</summary><pre class="mono">${recEsc(JSON.stringify(payload,null,2))}</pre></details>
  </div>`;
}

function renderRecommendationList(res,view){
  const el=document.getElementById('rec-list');
  if(!el) return;
  if(res.empty){ el.innerHTML=''; return; }
  if(!view.visible.length){
    el.innerHTML=`<div class="rec-empty">조건에 맞는 추천이 없어요. ${view.filteredCount?'모두 숨김·제외·완료 상태예요.':'필터를 넓혀 보세요.'}</div>`;
    return;
  }
  el.innerHTML=`<div class="rec-list-head mono">${fmtNum(view.visible.length)}개 표시 · 필터에 맞는 후보 ${fmtNum(view.all.length)}개 · ${recEsc(Recommendation.SORT_LABELS[recSort])}</div>`
    +view.visible.map((r,i)=>recommendationCardHTML(r,i+1,res)).join('');
}

function renderRecommendationHidden(view){
  const el=document.getElementById('rec-hidden');
  if(!el) return;
  if(!view.hidden.length){ el.innerHTML=''; el.style.display='none'; return; }
  el.style.display='block';
  el.innerHTML=`<div class="stats-section-title">숨김 · 제외 · 완료한 추천 (${fmtNum(view.hidden.length)})</div>`
    +view.hidden.map(h=>`<div class="rec-hidden-row" data-rec-id="${recEsc(h.rec.id)}" data-status="${recEsc(h.status)}">
      <span>${recEsc(h.rec.zone)} · ${recEsc(h.rec.conditionLabel)}</span>
      <span class="rec-muted">${recEsc(h.note)}</span>
      <button class="btn ghost settings-row-btn" type="button" onclick="restoreRecommendation(${recEsc(JSON.stringify(h.rec.id))})">다시 추천받기</button>
    </div>`).join('');
}

function shareRowsHTML(rows,labelOf,totalSec){
  if(!rows.length) return '<div class="dc-empty">데이터 없음</div>';
  return rows.map(r=>`<div class="dist-row"><span class="dist-label">${recEsc(labelOf(r))}</span><span class="dist-bar-wrap"><span class="dist-bar" style="width:${totalSec?Math.round(r.collectionSec/totalSec*100):0}%"></span></span><span class="dist-count cond-count"><b>${fmtNum(r.collectionMinutes)}분</b> · ${totalSec?Math.round(r.collectionSec/totalSec*100):0}%</span></div>`).join('');
}

function renderRecommendationDeficits(res){
  const el=document.getElementById('rec-deficits');
  if(!el) return;
  const d=res.dataset, b=res.breakdowns;
  const total=d.collectionSec;
  const zoneRows=res.zones.map(z=>`<tr><th scope="row">${recEsc(z.zone)}</th><td class="mono">${fmtNum(z.collectionMinutes)}</td><td class="mono">${fmtNum(z.visitCount)}</td><td class="mono">${fmtNum(z.uniqueDays)}</td><td class="mono">${recEsc(z.lastVisitedAt?z.lastVisitedAt.slice(0,10):'—')}</td><td>${z.coverage?(z.coverage.fresh?`${recPct(z.coverage.coveragePercent)} · 미방문 ${fmtNum(z.coverage.unvisitedCellCount)}칸${z.coverage.provisional?' (임시값)':''}`:`<span class="rec-muted">오래됨 — ${recEsc(z.coverage.staleReason)}</span>`):'<span class="rec-muted">계산값 없음</span>'}</td></tr>`).join('');
  const card=(title,html)=>`<div class="dist-card"><div class="dc-title">${title}</div>${html}</div>`;
  const periodTotal=Object.fromEntries(b.trafficPeriod.map(r=>[r.trafficPeriod,r]));
  const zonesN=Math.max(1,res.zones.length);
  const periodRows=TimeConditions.TRAFFIC_PERIOD_IDS.map(id=>{
    const r=periodTotal[id]||{collectionSec:0,collectionMinutes:0,visitCount:0};
    const target=res.settings.periodTargets[id].minutes*zonesN*2;
    return `<tr><th scope="row">${recEsc(TimeConditions.TRAFFIC_PERIOD_LABELS[id])}</th><td class="mono">${fmtNum(r.collectionMinutes)}</td><td class="mono">${fmtNum(r.visitCount)}</td><td class="mono">${fmtNum(target)}</td><td class="mono">${target?recPct(r.collectionSec/60/target*100):'—'}</td></tr>`;
  }).join('');
  el.innerHTML=`
    <div class="stats-section-title">현재 데이터 부족 현황</div>
    <div class="rec-table-wrap"><table class="rec-table"><thead><tr><th>구역</th><th>수집(분)</th><th>방문(회)</th><th>수집일</th><th>마지막 방문</th><th>Coverage</th></tr></thead><tbody>${zoneRows||'<tr><td colspan="6">활성 구역 없음</td></tr>'}</tbody></table></div>
    <div class="rec-table-wrap"><table class="rec-table"><thead><tr><th>교통 시간대</th><th>수집(분)</th><th>방문(회)</th><th title="시간대 목표 × 활성 구역 수 × 평일·주말">목표 합(분)</th><th>달성률</th></tr></thead><tbody>${periodRows}</tbody></table></div>
    <div class="rec-deficit-grid">
      ${card('평일 · 주말',shareRowsHTML(TimeConditions.WEEKDAY_TYPE_IDS.map(id=>b.weekdayType.find(r=>r.weekdayType===id)||{weekdayType:id,collectionSec:0,collectionMinutes:0}),r=>TimeConditions.WEEKDAY_TYPE_LABELS[r.weekdayType],total))}
      ${card('조도 조건',shareRowsHTML(TimeConditions.LIGHT_CONDITION_IDS.map(id=>b.lightCondition.find(r=>r.lightCondition===id)||{lightCondition:id,collectionSec:0,collectionMinutes:0}),r=>TimeConditions.LIGHT_CONDITION_LABELS[r.lightCondition],total))}
      ${card('날씨',shareRowsHTML(b.weather,r=>r.weather||'정보 없음',total))}
      ${card('차량 편중',shareRowsHTML(b.vehicle,r=>r.vehicle||'정보 없음',b.vehicle.reduce((a,r)=>a+r.collectionSec,0)))}
    </div>
    <div class="rec-muted">분석 단위(구역 × 요일 × 교통 시간대 × 조도 × 날씨) 중 기록이 있는 조합 ${fmtNum(res.analysisUnitCount)}개 · 품질 경고(GPS 공백+점프) 기록 1,000건당 ${(Math.round(d.quality.per1000*10)/10).toFixed(1)}건${d.speed&&d.speed.count?` · 평균속도 ${d.speed.averageKmh}km/h(정차 ${recPct(d.speed.stoppedRatio*100)})`:''}</div>`;
}

// ── 추천 설정 ─────────────────────────────────────────
function recommendationSettingsFormFrom(settings){
  return JSON.parse(JSON.stringify(settings));
}

function renderRecommendationSettings(res){
  const el=document.getElementById('rec-settings');
  if(!el) return;
  if(!recSettingsForm) recSettingsForm=recommendationSettingsFormFrom(res.settings);
  const f=recSettingsForm;
  const num=(path,value,attrs)=>`<input type="number" class="depth-threshold-input mono rec-input" value="${recEsc(value)}" ${attrs||''} oninput="onRecommendationSettingInput(${recEsc(JSON.stringify(path))},this.value)"/>`;
  const weightSum=Recommendation.SCORE_KEYS.reduce((a,k)=>a+(Number(f.weights[k])||0),0);
  const zoneNames=res.zones.map(z=>z.zone);
  el.innerHTML=`
    <div class="stats-section-title">추천 설정</div>
    <div class="ir-note" style="margin:0;">설정을 바꿔도 원본 주행 기록은 바뀌지 않아요. 저장하면 추천을 다시 계산해요.</div>
    <div class="rec-settings-grid">
      <div class="dist-card"><div class="dc-title">평가 항목 가중치(%) · 합계 <span id="rec-weight-sum" class="mono ${Math.abs(weightSum-100)>0.001?'rec-bad':''}">${Math.round(weightSum*100)/100}%</span></div>
        ${Recommendation.SCORE_KEYS.map(k=>`<div class="settings-row depth-tier-row"><span class="settings-row-name">${recEsc(Recommendation.SCORE_LABELS[k])}</span>${num(['weights',k],f.weights[k],'min="0" max="100" step="0.5"')}</div>`).join('')}
      </div>
      <div class="dist-card"><div class="dc-title">교통 시간대별 목표 (구역 × 요일 유형당)</div>
        ${TimeConditions.TRAFFIC_PERIOD_IDS.map(id=>`<div class="settings-row depth-tier-row"><span class="settings-row-name">${recEsc(TimeConditions.TRAFFIC_PERIOD_LABELS[id])}</span><span class="depth-tier-input-wrap">${num(['periodTargets',id,'minutes'],f.periodTargets[id].minutes,'min="0" step="10"')}<span class="rec-muted">분</span>${num(['periodTargets',id,'visits'],f.periodTargets[id].visits,'min="0" step="1"')}<span class="rec-muted">회</span></span></div>`).join('')}
      </div>
      <div class="dist-card"><div class="dc-title">Coverage 목표 · 기타</div>
        <div class="settings-row depth-tier-row"><span class="settings-row-name">기본 목표 Coverage(%)</span>${num(['zoneCoverageTargets','default'],f.zoneCoverageTargets.default,'min="1" max="100"')}</div>
        ${zoneNames.map(z=>`<div class="settings-row depth-tier-row"><span class="settings-row-name">${recEsc(z)} 목표 Coverage(%)</span>${num(['zoneCoverageTargets','zones',z],f.zoneCoverageTargets.zones[z]==null?'':f.zoneCoverageTargets.zones[z],'min="1" max="100" placeholder="기본값"')}</div>`).join('')}
        <div class="settings-row depth-tier-row"><span class="settings-row-name">최소 고유 수집일</span>${num(['minUniqueDays'],f.minUniqueDays,'min="0"')}</div>
        <div class="settings-row depth-tier-row"><span class="settings-row-name">오래된 방문 기준(일)</span>${num(['staleDays'],f.staleDays,'min="1"')}</div>
        <div class="settings-row depth-tier-row"><span class="settings-row-name">추천당 최대 권장 횟수</span>${num(['maxVisitsPerRecommendation'],f.maxVisitsPerRecommendation,'min="1"')}</div>
        <div class="settings-row depth-tier-row"><span class="settings-row-name">추천 결과 개수</span>${num(['resultCount'],f.resultCount,'min="1"')}</div>
        <div class="settings-row depth-tier-row"><span class="settings-row-name">기간 제외 일수</span>${num(['snoozeDays'],f.snoozeDays,'min="1"')}</div>
        <div class="settings-row depth-tier-row"><label class="sync-checkbox"><input type="checkbox" id="rec-show-low" ${f.showLowConfidence?'checked':''} onchange="onRecommendationSettingInput(${recEsc(JSON.stringify(['showLowConfidence']))},this.checked)"/> 낮은 신뢰도 추천도 표시</label></div>
      </div>
    </div>
    <div id="rec-settings-errors" class="ir-note warn" style="display:none;margin:0;"></div>
    <div class="settings-actions">
      <button class="btn" type="button" id="rec-settings-save-btn" onclick="saveRecommendationSettings()">저장</button>
      <button class="btn ghost" type="button" id="rec-settings-default-btn" onclick="restoreDefaultRecommendationSettings()">기본값 복원</button>
    </div>`;
  validateRecommendationSettingsForm();
}

function onRecommendationSettingInput(path,value){
  if(!recSettingsForm) return;
  let obj=recSettingsForm;
  for(let i=0;i<path.length-1;i++){ if(obj[path[i]]==null) obj[path[i]]={}; obj=obj[path[i]]; }
  const last=path[path.length-1];
  if(typeof value==='boolean') obj[last]=value;
  else if(path[0]==='zoneCoverageTargets'&&path[1]==='zones'&&String(value).trim()==='') delete obj[last];
  else obj[last]=String(value).trim()===''?'':Number(value);
  validateRecommendationSettingsForm();
}

function validateRecommendationSettingsForm(){
  const v=Recommendation.validateRecommendationSettings(recSettingsForm||{});
  if(typeof showSettingsErrors==='function') showSettingsErrors('rec-settings-errors',v.errors);
  const sumEl=document.getElementById('rec-weight-sum');
  if(sumEl&&recSettingsForm){
    const sum=Recommendation.SCORE_KEYS.reduce((a,k)=>a+(Number(recSettingsForm.weights[k])||0),0);
    sumEl.textContent=`${Math.round(sum*100)/100}%`;
  }
  const btn=document.getElementById('rec-settings-save-btn');
  if(btn) btn.disabled=!v.ok;
  return v;
}

async function saveRecommendationSettings(){
  const v=validateRecommendationSettingsForm();
  if(!v.ok) return false; // 가중치 합계가 100%가 아니거나 값이 잘못되면 저장하지 않는다
  try{
    await RouteDB.setSettings({recommendationSettings:v.settings});
  }catch(err){
    if(typeof showSettingsErrors==='function') showSettingsErrors('rec-settings-errors',err&&err.errors?err.errors:[String((err&&err.message)||err)]);
    showError('추천 설정을 저장하지 못했어요. 기존 설정은 그대로예요.');
    return false;
  }
  recSettingsForm=null;
  showToast('추천 설정을 저장했어요. 추천을 다시 계산해요.');
  await renderRecommendView();
  return true;
}

async function restoreDefaultRecommendationSettings(){
  recSettingsForm=Recommendation.defaultRecommendationSettings();
  return saveRecommendationSettings();
}

function renderRecommendationLimitations(res){
  const el=document.getElementById('rec-limitations');
  if(!el) return;
  el.innerHTML=`
    <div class="stats-section-title">데이터 한계 · 신뢰도 안내</div>
    <ul class="rec-facts">
      <li><b>추천 점수</b>는 "얼마나 먼저 모아야 하는가", <b>신뢰도</b>는 "이 판단에 쓸 데이터가 충분한가"예요. 둘은 따로 계산해요.</li>
      <li>신뢰도 높음: 시각·GPS·구역 판정 비율이 높고 수집 기간·비교 조건·Coverage가 모두 있음 · 보통: 일부 필드 누락, 수집일이 적음, Coverage 계산값 없음 등 · 낮음: 시각/GPS/구역 판정 불가 기록이 많거나 품질 경고가 많음.</li>
      <li>${recEsc(res.edgeCaseDisclaimer)}</li>
      ${res.limitations.map(l=>`<li>${recEsc(l)}</li>`).join('')}
      <li>순위와 수치는 통계·규칙 엔진이 정해요. 나중에 LLM을 연결해도 이 결과를 설명·비교만 하고, 원본 GPS·사람 이름은 넘기지 않아요.</li>
    </ul>`;
}

// ── 카드 동작 — 추천 상태만 바꾸고 주행 기록은 건드리지 않는다 ──
function findRecommendation(id){
  return recCache.result?recCache.result.recommendations.find(r=>r.id===id):null;
}

function toggleRecommendationDetail(id){
  if(recOpenDetails.has(id)) recOpenDetails.delete(id); else recOpenDetails.add(id);
  renderRecommendationResult();
}

function hideRecommendationOnce(id){
  recSessionHidden.add(id);
  renderRecommendationResult();
}

async function snoozeRecommendation(id){
  const days=recCache.result?recCache.result.settings.snoozeDays:7;
  try{
    recStates=await RouteDB.setRecommendationState(id,{status:'snoozed',until:Recommendation.snoozeUntil(recommendationClock(),days)});
    showToast(`${days}일간 이 추천을 제외했어요.`);
  }catch(err){ showError('추천 상태를 저장하지 못했어요. ('+((err&&err.message)||err)+')'); }
  renderRecommendationResult();
}

async function completeRecommendation(id){
  const r=findRecommendation(id);
  if(!r) return;
  try{
    // 지금 실제 수집량을 함께 적어 둔다 — 나중에 새 데이터가 들어오면 이 값과 비교해 다시 평가한다
    recStates=await RouteDB.setRecommendationState(id,{status:'completed',snapshot:{collectionSec:r.current.collectionSec,visitCount:r.current.visitCount}});
    showToast('수집 완료로 표시했어요. 주행 기록은 바뀌지 않고, 새 데이터를 불러오면 실제 수집량으로 다시 평가해요.');
  }catch(err){ showError('추천 상태를 저장하지 못했어요. ('+((err&&err.message)||err)+')'); }
  renderRecommendationResult();
}

async function restoreRecommendation(id){
  recSessionHidden.delete(id);
  try{ recStates=await RouteDB.setRecommendationState(id,null); }
  catch(err){ showError('추천 상태를 되돌리지 못했어요. ('+((err&&err.message)||err)+')'); }
  renderRecommendationResult();
}

// ══════════════════════════════════════════════════════════
//  주행 계획 — "그 시간에 나가면 어디부터 어떻게 돌까"
//
//  추천 카드가 "무엇이 부족한가"라면, 여기는 그걸 하루 일정으로 바꾼 것이다.
//  운행 시간을 바꿔 보면(예: 9시 → 8시 시작) 무엇이 새로 잡히는지 바로 비교해서 보여준다.
//  계산은 recommendation.js 의 buildDrivePlan 이 하고(순수 함수), 여기서는 입력과 표시만 한다.
// ══════════════════════════════════════════════════════════
const REC_PLAN_LS_KEY='rv.drivePlanForm';

function defaultPlanForm(){
  const d=Recommendation.PLAN_DEFAULTS;
  return {
    startTime:d.startTime, endTime:d.endTime,
    baselineStartTime:d.baselineStartTime, baselineEndTime:d.baselineEndTime,
    weekdayType:'weekday', vehicleCount:1, zones:[],
  };
}

let recPlanForm=(function(){
  try{
    const saved=JSON.parse(localStorage.getItem(REC_PLAN_LS_KEY)||'null');
    return saved&&typeof saved==='object'?{...defaultPlanForm(),...saved}:defaultPlanForm();
  }catch(_){ return defaultPlanForm(); }
})();
let recPlanResult=null;

function savePlanForm(){
  try{ localStorage.setItem(REC_PLAN_LS_KEY,JSON.stringify(recPlanForm)); }catch(_){ /* 무시 */ }
}

function onPlanInput(name,value){
  if(name==='vehicleCount') recPlanForm.vehicleCount=Math.max(1,Math.min(8,Number(value)||1));
  else recPlanForm[name]=String(value||'');
  savePlanForm();
  renderDrivePlan();
}

function togglePlanZone(zone,on){
  const set=new Set(recPlanForm.zones||[]);
  if(on) set.add(zone); else set.delete(zone);
  recPlanForm.zones=[...set];
  savePlanForm();
  renderDrivePlan();
}

function renderDrivePlan(){
  const el=document.getElementById('rec-plan');
  if(!el) return;
  const res=recCache.result;
  if(!res||res.empty){ el.innerHTML=''; recPlanResult=null; return; }
  const plan=Recommendation.buildDrivePlan({
    result:res, zones:recCache.zones||[], settings:recCache.appSettings||{},
    plan:{...recPlanForm},
  });
  recPlanResult=plan;

  const zonesAvailable=res.zones.map(z=>z.zone);
  const picked=new Set((recPlanForm.zones||[]).filter(z=>zonesAvailable.includes(z)));
  const zoneChips=zonesAvailable.map(z=>`
    <label class="plan-zone${picked.size===0||picked.has(z)?' on':''}">
      <input type="checkbox" ${picked.has(z)?'checked':''} onchange="togglePlanZone('${recEsc(z)}',this.checked)"/>
      <span>${recEsc(z)}</span>
    </label>`).join('');

  const form=`
    <div class="plan-form">
      <label class="rec-filter"><span>요일</span>
        <select onchange="onPlanInput('weekdayType',this.value)">
          ${TimeConditions.WEEKDAY_TYPE_IDS.map(id=>optionHTML(id,TimeConditions.WEEKDAY_TYPE_LABELS[id],recPlanForm.weekdayType)).join('')}
        </select></label>
      <label class="rec-filter"><span>운행 시작</span>
        <input type="time" value="${recEsc(recPlanForm.startTime)}" onchange="onPlanInput('startTime',this.value)"/></label>
      <label class="rec-filter"><span>운행 종료</span>
        <input type="time" value="${recEsc(recPlanForm.endTime)}" onchange="onPlanInput('endTime',this.value)"/></label>
      <label class="rec-filter"><span>차량</span>
        <input type="number" min="1" max="8" value="${recPlanForm.vehicleCount}" onchange="onPlanInput('vehicleCount',this.value)"/></label>
    </div>
    <div class="plan-form">
      <label class="rec-filter"><span>비교 기준(지금 운행)</span>
        <input type="time" value="${recEsc(recPlanForm.baselineStartTime)}" onchange="onPlanInput('baselineStartTime',this.value)"/></label>
      <label class="rec-filter"><span>~</span>
        <input type="time" value="${recEsc(recPlanForm.baselineEndTime)}" onchange="onPlanInput('baselineEndTime',this.value)"/></label>
      <span class="plan-zones">${zoneChips}<span class="plan-zone-hint">아무것도 고르지 않으면 활성 구역 전부</span></span>
    </div>`;

  if(!plan.ok){
    el.innerHTML=`<div class="rec-section-title">주행 계획</div>${form}
      <div class="ir-note warn">${plan.errors.map(recEsc).join('<br/>')}</div>`;
    return;
  }

  const lanes=plan.lanes.map(lane=>`
    <div class="plan-lane">
      ${plan.lanes.length>1?`<div class="plan-lane-title">차량 ${lane.vehicleIndex}</div>`:''}
      <div class="rec-table-wrap">
        <table class="rec-table plan-table">
          <thead><tr><th>시각</th><th>구역</th><th>조건</th><th>수집(분)</th><th>이동(분)</th><th>이유</th></tr></thead>
          <tbody>
            ${lane.blocks.map(b=>`
              <tr${b.travelMinutes?' class="plan-move"':''}>
                <td class="mono">${recEsc(b.from)}~${recEsc(b.to)}</td>
                <td><b>${recEsc(b.zone)}</b></td>
                <td>${conditionBadgesHTML({trafficPeriod:b.trafficPeriod,lightCondition:b.lightCondition},['trafficPeriod','lightCondition'].filter(k=>b[k]))}</td>
                <td class="mono">${fmtNum(b.collectMinutes)}</td>
                <td class="mono">${b.travelMinutes?fmtNum(b.travelMinutes):'—'}</td>
                <td class="plan-reason">${recEsc(b.reason)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`).join('');

  const byZone=Object.entries(plan.totals.byZone).sort((a,b)=>b[1]-a[1])
    .map(([z,m])=>`${recEsc(z)} ${fmtNum(m)}분`).join(' · ')||'—';
  const cmp=plan.comparison;
  const diffText=cmp
    ? (cmp.collectMinutesDiff>0
        ? `지금(${recEsc(cmp.baselineWindow.start)}~${recEsc(cmp.baselineWindow.end)})보다 <b class="plan-gain">${fmtNum(cmp.collectMinutesDiff)}분</b> 더 모읍니다.`
        : cmp.collectMinutesDiff<0
          ? `지금(${recEsc(cmp.baselineWindow.start)}~${recEsc(cmp.baselineWindow.end)})보다 <b class="rec-bad">${fmtNum(-cmp.collectMinutesDiff)}분</b> 덜 모읍니다.`
          : `지금 운행 시간과 총 수집 시간은 같습니다.`)
    : '지금 운행 시간과 같은 조건이라 비교할 것이 없어요(비교 기준을 바꿔 보세요).';
  const newList=cmp&&cmp.newConditions.length
    ? `<ul class="plan-diff-list">${cmp.newConditions.slice(0,6).map(c=>`
        <li><b>${recEsc(c.label)}</b> +${fmtNum(c.addedMinutes)}분${
          c.shortfallMinutes!=null?` <span class="rec-cond">(이 조건 부족 ${fmtNum(c.shortfallMinutes)}분 중 ${fmtNum(c.coversMinutes||0)}분을 메웁니다)`:''}</span></li>`).join('')}</ul>`
    : '';
  const lostList=cmp&&cmp.lostConditions.length
    ? `<div class="plan-lost">대신 빠지는 시간: ${cmp.lostConditions.slice(0,4).map(c=>`${recEsc(c.label)} ${fmtNum(c.lostMinutes)}분`).join(' · ')}</div>`
    : '';

  el.innerHTML=`
    <div class="rec-section-title">주행 계획 <span class="ds-hint">운행 시간을 바꿔 보고 "어디부터 어떻게 돌지"를 받아보세요</span></div>
    ${form}
    <div class="plan-summary">
      <div class="plan-summary-head">
        <span class="mono">${recEsc(plan.date)} (${recEsc(plan.weekdayLabel)}) · ${recEsc(plan.window.start)}~${recEsc(plan.window.end)}</span>
        ${plan.sun?`<span class="mono plan-sun">일출 ${recEsc(plan.sun.sunrise)} · 일몰 ${recEsc(plan.sun.sunset)}</span>`:''}
        <span class="mono">예상 수집 ${fmtNum(plan.totals.collectMinutes)}분${plan.totals.travelMinutes?` · 이동 ${fmtNum(plan.totals.travelMinutes)}분`:''}</span>
      </div>
      <div class="plan-summary-zones">구역별 ${byZone}</div>
      <div class="plan-diff">${diffText}${newList}${lostList}</div>
    </div>
    ${lanes}
    <details class="rec-llm plan-limits">
      <summary>이 계획을 어떻게 만들었나 · 한계</summary>
      <ul>
        <li>운행 시간을 교통 시간대·일출/일몰 경계로 자르고, 블록마다 그 조건에서 가장 부족한 구역을 고릅니다(추천 점수와 같은 규칙).</li>
        <li>한 조건의 부족분을 채우면 다음으로 부족한 곳으로 옮깁니다. 구역을 옮기면 이동 시간만큼 수집이 줄어드는 것을 감안합니다.</li>
        ${plan.limitations.map(l=>`<li>${recEsc(l)}</li>`).join('')}
      </ul>
    </details>`;
}
