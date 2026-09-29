// ══════════════════════════════════════════════════════════
//  hdmap-priority-view — [통계] 탭의 "HD Map 우선 수집" 현황판
//
//  이 화면은 설정 도구가 아니라 현황판(KPI dashboard)이다. 답해야 하는 건 여섯 가지.
//    1) ⑤ 는 지금까지 얼마나 수집됐나           → 최우선 카드
//    2) ①②⑤⑥⑨⑩ 우선지역은 각각 얼마나        → 막대 그래프 · 비교표
//    3) 우선지역이 일반지역보다 실제로 많은가     → 우선 평균 vs 일반 평균 카드
//    4) 각 구역이 일반 평균보다 몇 분·몇 %·몇 배  → 비교표 마지막 칸
//    5) 우선지역 중 가장 부족한 곳               → 부족 구역 카드
//    6) 우선지역이 차지하는 비중                 → 비중 카드
//
//  계산은 전부 hdmap-priority.js 가 한다(여기서는 그리기만).
//  구역별 수집량은 RouteDB.getSubZoneStats() — 추천 탭의 세부 구역과 같은 집계 함수다.
//
//  "구역 번호 안내" 참고 이미지(src/assets/hdmap-priority-reference.png)는 index.html 에 고정으로 있다.
//    사용자가 ①~⑫ 가 지도의 어디인지 눈으로 확인하는 용도라, 경계(polygon)가 없어도·기록이 없어도
//    언제나 보여야 하기 때문이다. 통계 계산에 쓰는 경계와는 전혀 다른 것이다(섞지 않는다).
//    여기서는 크게 보기(모달)만 맡는다 — openHDMapPriorityReference().
//
//  경계(polygon) 이야기는 이 화면의 주인공이 아니다.
//    · 경계가 없으면 맨 위에 한 줄짜리 상태 표시만 하고, 현황판 자체는 그대로 그린다.
//    · 경계를 어떻게 넣는지(관리)는 [설정] 탭으로 뺐다 — renderHDMapPriorityAreaSettings().
//    · 경계가 없는 구역은 0분이 아니라 '경계 미설정'이고, 평균·비중 계산에서 빠진다
//      ("안 달렸다"와 "잴 수 없다"는 다른 말이라 0분으로 그리면 거짓이 된다).
//    · 경계가 있는데 기록이 없으면 그건 진짜 0분 / 0회 / 0일이다.
// ══════════════════════════════════════════════════════════

let hdmapPriorityResult = null;     // buildComparison 결과
let hdmapPriorityCacheKey = null;   // 같은 조건이면 다시 계산하지 않는다
let hdmapPriorityError = null;
let hdmapPriorityToken = 0;
let hdmapPriorityPolygons = {};     // 직접 그려 저장한 경계 {areaNo:{polygon,updatedAt}}
let hdmapPriorityTotalPoints = null; // 같은 필터의 전체 기록 수 — 경계 밖 건수를 내는 데 쓴다

// 저장된 경계를 읽어 파일 정의 위에 덮어쓴 ①~⑫ 목록을 만든다
async function hdmapPriorityLoadAreas() {
  try {
    hdmapPriorityPolygons = await RouteDB.getHDMapPriorityPolygons();
  } catch (err) {
    console.warn('[경로뷰어] HD Map 우선 구역 경계를 읽지 못했어요:', err);
    hdmapPriorityPolygons = {};
  }
  return HDMapPriority.listAreas(null, hdmapPriorityPolygons);
}

function hdmapPriorityAvailable() {
  return typeof HDMapPriority !== 'undefined' && HDMapPriority && typeof HDMapPriority.listAreas === 'function';
}

// 통계 탭의 "HD Map 우선 수집" 모드에서 부른다. filter 는 statsFilter() — 다른 통계와 같은 조건.
async function renderHDMapPrioritySection(filter, options) {
  const box = document.getElementById('hdmap-priority-section');
  if (!box) return;
  const total = options && options.totalPoints;
  hdmapPriorityTotalPoints = Number.isFinite(total) ? total : null;
  if (!hdmapPriorityAvailable()) {
    hdmapPriorityShowFailure(new Error('구역 정의(js/hdmap-priority.js)를 불러오지 못했어요'));
    return;
  }

  const areas = await hdmapPriorityLoadAreas();
  if (typeof renderHDMapPriorityEditor === 'function') renderHDMapPriorityEditor(areas);
  const inputs = HDMapPriority.toSubZoneInputs(areas);

  // 경계가 하나도 없으면 집계할 것이 없다 — 현황판은 그대로 그리고 숫자 자리만 비운다
  if (!inputs.length) {
    hdmapPriorityResult = HDMapPriority.buildComparison({ areas, stats: [] });
    hdmapPriorityCacheKey = null;
    hdmapPriorityPaint(hdmapPriorityResult);
    return;
  }

  // 경계를 바꾸면(점 하나라도) 반드시 다시 계산해야 하므로 지문에 넣는다
  const key = JSON.stringify({
    filter: filter || {},
    areas: inputs.map(a => `${a.id}:${a.polygon.length}:${a.polygon[0]}:${a.polygon[a.polygon.length - 1]}`),
  });
  if (key === hdmapPriorityCacheKey && hdmapPriorityResult) {
    hdmapPriorityPaint(hdmapPriorityResult);
    return;
  }

  const token = ++hdmapPriorityToken;
  hdmapPriorityError = null;
  hdmapPriorityPaint(hdmapPriorityResult, { loading: true });
  try {
    // Coverage(구역 안 HD Map 도로 중 실제로 지난 비율)까지 내려면 도로 매칭이 필요하다
    const stats = await RouteDB.getSubZoneStats(inputs, { filter: filter || {} });
    if (token !== hdmapPriorityToken) return;
    hdmapPriorityResult = HDMapPriority.buildComparison({ areas, stats });
    hdmapPriorityCacheKey = key;
  } catch (err) {
    if (token !== hdmapPriorityToken) return;
    console.warn('[경로뷰어] HD Map 우선 구역 집계 실패:', err);
    hdmapPriorityError = err && err.message ? err.message : String(err);
    hdmapPriorityResult = HDMapPriority.buildComparison({ areas, stats: [], error: true });
    hdmapPriorityCacheKey = null;
  }
  if (token !== hdmapPriorityToken) return;
  hdmapPriorityPaint(hdmapPriorityResult);
}

// 어디서 실패했든 빈 화면이 아니라 '계산 실패'와 이유를 보여준다(통계 탭이 부르는 곳에서도 쓴다)
function hdmapPriorityShowFailure(err) {
  console.warn('[경로뷰어] HD Map 우선 구역 현황판 실패:', err);
  hdmapPriorityError = err && err.message ? err.message : String(err);
  hdmapPriorityResult = null;
  hdmapPriorityCacheKey = null;
  hdmapPriorityPaint(null);
}

// 현황판은 두 자리에 나눠 그린다.
//   #hdmap-priority-section — 상태 한 줄 + KPI 카드 4개. 참고 이미지 옆(좁은 화면에서는 아래)에 붙는다.
//   #hdmap-priority-detail  — 막대 그래프 + 비교표. 폭을 다 쓴다.
// 참고 이미지는 index.html 에 고정으로 있어서 여기서 지우지 않는다.
function hdmapPriorityPaint(result, options) {
  const box = document.getElementById('hdmap-priority-section');
  const detail = document.getElementById('hdmap-priority-detail');
  // 처음 계산하는 동안(앞선 결과가 없을 때)에도 빈 화면으로 두지 않는다 — 무엇을 하고 있는지 적는다
  if (!result) {
    const loading = options && options.loading;
    if (box) {
      box.innerHTML = loading
        ? `<div class="hp-status-bar"><span class="hp-status hp-status-wait">①~⑫ 구역 집계하는 중… (기록이 많으면 몇 초 걸려요)</span></div>`
        : (hdmapPriorityError
          ? `<div class="hp-status-bar"><span class="hp-status hp-status-warn">계산 실패 — ${escapeHtml(hdmapPriorityError)} · [↻ 다시 계산]</span></div>`
          : '');
    }
    if (detail) detail.innerHTML = '';
    return;
  }
  if (box) box.innerHTML = `${hdmapPriorityStatusHTML(result, options)}${hdmapPriorityCardsHTML(result)}`;
  if (detail) detail.innerHTML = `${hdmapPriorityChartHTML(result)}${hdmapPriorityTableHTML(result)}`;
}

// 참고 이미지 크게 보기 — 공용 모달(js/ui.js)을 그대로 쓴다
function openHDMapPriorityReference() {
  if (typeof openModal !== 'function') return;
  openModal({
    title: '구역 번호 안내 — ①~⑫ 우선 수집 구역 참고 이미지',
    wide: true,
    body: `<img class="hp-ref-full" src="assets/hdmap-priority-reference.png"
             alt="강남 지도 위에 ①~⑫ 우선 수집 구역의 위치를 번호로 표시한 참고 이미지">
           <div class="modal-detail">최우선 ⑤ · 우선 ①②⑥⑨⑩ · 일반(비교군) ③④⑦⑧⑪⑫.
             구역 번호 위치를 확인하는 참고용 이미지이고, 통계 계산에 쓰는 경계(polygon)가 아니에요.</div>`,
  });
}

function refreshHDMapPriority() {
  hdmapPriorityCacheKey = null;
  if (typeof renderStatsView === 'function') renderStatsView();
}

// ── 한 줄 상태 표시 ───────────────────────────────────
// 경계 이야기는 여기 한 줄로 끝낸다. 자세한 건 [설정] 탭.
function hdmapPriorityStatusHTML(result, options) {
  const o = options || {};
  const v = result.validation;
  const chips = [];
  if (o.loading) chips.push('<span class="hp-status hp-status-wait">집계하는 중…</span>');
  if (hdmapPriorityError) chips.push(`<span class="hp-status hp-status-wait">집계 실패 — ${escapeHtml(hdmapPriorityError)}</span>`);
  if (!v.ready) {
    chips.push('<span class="hp-status hp-status-wait">①~⑫ 구역 경계 미설정 — 통계 계산 대기</span>');
    chips.push('<span class="hp-status-hint">위 <b>구역 경계 설정</b>에서 지도에 경계를 그리면 기존 기록 전체로 바로 계산돼요</span>');
  } else if (!v.allReady) {
    chips.push(`<span class="hp-status hp-status-wait">경계 미설정 ${v.missingPolygon.length}개 (${v.missingPolygon.join(', ')}) — 평균·비중에서 제외</span>`);
  }
  const s = result.summary;
  if (s.errorAreaNos && s.errorAreaNos.length) {
    chips.push(`<span class="hp-status hp-status-warn">계산 실패 ${s.errorAreaNos.length}개 — 다시 계산 필요</span>`);
  }
  if (s.noDataAreaNos && s.noDataAreaNos.length) {
    chips.push(`<span class="hp-status">경계 안 기록 0건 ${s.noDataAreaNos.length}개 (${s.noDataAreaNos.join(', ')}) — 0분으로 셉니다</span>`);
  }
  if (s.noCoverageAreaNos && s.noCoverageAreaNos.length) {
    chips.push(`<span class="hp-status" title="구역 안에 HD Map 도로 데이터가 없어요">Coverage 미계산 ${s.noCoverageAreaNos.length}개</span>`);
  }
  if (v.warnings.length) chips.push(`<span class="hp-status hp-status-warn" title="${escapeHtml(v.warnings.join(' / '))}">경계 겹침 확인 필요</span>`);
  v.errors.forEach(e => chips.push(`<span class="hp-status hp-status-warn">${escapeHtml(e)}</span>`));
  if (!chips.length) return '';
  return `<div class="hp-status-bar">${chips.join('')}<span class="hp-status-hint">경계는 위 <b>구역 경계 설정</b> 버튼에서 그리고 고쳐요</span></div>`;
}

// ── 카드 4개 ─────────────────────────────────────────
const hpMin = m => `${fmtNum(Math.round(m || 0))}<small> 분</small>`;
const hpDash = '<span class="hp-na">—</span>';

function hdmapPriorityDateOf(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(stamp || ''));
  return m ? m[1] : null;
}

// 일반지역 평균과 비교하지 못하는 이유 — "일반 경계가 없다"와 "일반지역 기록이 0분이다"는 할 일이 다르다
function hdmapPriorityNoCompareReason(summary) {
  if (!summary.normalAreaCount) return '비교 불가 — 일반지역(③④⑦⑧⑪⑫) 경계 미설정';
  return '비교 불가 — 일반지역 평균 0분(0으로 나눌 수 없음)';
}

function hdmapPriorityCardsHTML(result) {
  const s = result.summary;
  const primary = s.primary;
  const weakest = s.weakestPriority;

  // 1. ⑤ 최우선
  const primaryCard = primary && primary.hasPolygon
    ? `<div class="stat-cell hp-kpi hp-kpi-primary">
         <div class="k">⑤ 최우선 지역</div>
         <div class="v">${hpMin(primary.collectionMinutes)}</div>
         <div class="hp-kpi-rows">
           <span>방문 <b>${fmtNum(primary.visitCount)}</b>회</span>
           <span>세션 <b>${fmtNum(primary.sessionCount)}</b>회</span>
           <span>수집일 <b>${fmtNum(primary.uniqueDays)}</b>일</span>
         </div>
         ${primary.state === 'no_data'
           ? '<div class="hp-kpi-note"><span class="hp-state hp-state-no_data">경계 안 기록 0건</span> — 경계는 있지만 그 안을 달린 기록이 없어요(진짜 0분).</div>' : ''}
         <div class="hp-kpi-note">일반지역 평균 대비 ${primary.comparable
           ? `<b>${HDMapPriority.formatRatio(primary.ratioVsNormalAvg)}</b> · ${HDMapPriority.formatPercentDiff(primary.percentVsNormalAvg)}`
           : `<span class="hp-state">${escapeHtml(hdmapPriorityNoCompareReason(s))}</span>`}</div>
       </div>`
    : `<div class="stat-cell hp-kpi hp-kpi-primary">
         <div class="k">⑤ 최우선 지역</div>
         <div class="v hp-state hp-state-${primary ? primary.state : 'no_polygon'}">${primary ? escapeHtml(primary.stateLabel) : '경계 미설정'}</div>
         <div class="hp-kpi-note">${primary && primary.state === 'error'
           ? '집계가 실패했어요 — [↻ 다시 계산]' : '[구역 경계 설정]에서 ⑤ 경계를 그리면 바로 집계돼요.'}</div>
       </div>`;

  // 2. 우선지역 전체 비중
  const shareCard = `<div class="stat-cell hp-kpi">
      <div class="k">우선지역 전체 비중</div>
      <div class="v">${s.prioritySharePercent == null ? hpDash : `${s.prioritySharePercent.toFixed(1)}<small> %</small>`}</div>
      ${s.prioritySharePercent == null ? '' : `<div class="hp-meter"><span style="width:${Math.min(100, s.prioritySharePercent)}%"></span></div>`}
      <div class="hp-kpi-note">①②⑤⑥⑨⑩ ${fmtNum(s.priorityTotalMinutes)}분 / ①~⑫ ${fmtNum(s.allAreaMinutes)}분</div>
    </div>`;

  // 3. 우선 평균 vs 일반 평균
  // 경계가 있는 구역이 한쪽에 하나도 없으면 그쪽 평균은 0분이 아니라 '경계 미설정'이다
  const vs = s.priorityVsNormal;
  const avgSide = (count, minutes) => count
    ? `${fmtNum(Math.round(minutes))}<small> 분</small>`
    : '<span class="hp-na hp-state hp-state-no_polygon" style="font-size:12px">경계 미설정</span>';
  const avgCard = `<div class="stat-cell hp-kpi">
      <div class="k">우선 평균 vs 일반 평균</div>
      <div class="v hp-vs">${avgSide(s.priorityAreaCount, s.priorityAvgMinutes)}<span class="hp-vs-sep">vs</span>${avgSide(s.normalAreaCount, s.normalAvgMinutes)}</div>
      <div class="hp-kpi-rows">
        <span class="${vs.comparable && vs.percentVsNormalAvg >= 0 ? 'hp-up' : (vs.comparable ? 'hp-down' : '')}">
          ${vs.comparable ? `<b>${HDMapPriority.formatPercentDiff(vs.percentVsNormalAvg)}</b>` : `<span class="hp-state">${escapeHtml(hdmapPriorityNoCompareReason(s))}</span>`}</span>
        <span>${vs.comparable ? HDMapPriority.formatRatio(vs.ratioVsNormalAvg) : ''}</span>
      </div>
      <div class="hp-kpi-note">우선 ${fmtNum(s.priorityAreaCount)}개 · 일반 ${fmtNum(s.normalAreaCount)}개 구역 평균</div>
    </div>`;

  // 4. 현재 가장 부족한 우선지역
  const lastDate = weakest ? hdmapPriorityDateOf(weakest.lastVisitedAt) : null;
  const weakCard = weakest
    ? `<div class="stat-cell hp-kpi hp-kpi-weak">
         <div class="k">가장 부족한 우선지역</div>
         <div class="v">${escapeHtml(weakest.name)}<small> ${escapeHtml(weakest.priorityLabel)}</small></div>
         <div class="hp-kpi-rows">
           <span><b>${fmtNum(weakest.collectionMinutes)}</b>분</span>
           <span class="${weakest.comparable && weakest.percentVsNormalAvg < 0 ? 'hp-down' : ''}">일반 평균 대비 ${weakest.comparable
             ? `<b>${HDMapPriority.formatPercentDiff(weakest.percentVsNormalAvg)}</b>`
             : `<span class="hp-state">${escapeHtml(hdmapPriorityNoCompareReason(s))}</span>`}</span>
         </div>
         <div class="hp-kpi-note">마지막 수집 ${lastDate ? escapeHtml(lastDate) : '기록 없음'}</div>
       </div>`
    : `<div class="stat-cell hp-kpi hp-kpi-weak">
         <div class="k">가장 부족한 우선지역</div>
         <div class="v">${hpDash}</div>
         <div class="hp-kpi-note">경계가 있는 우선지역이 없어요.</div>
       </div>`;

  return `<div class="rec-summary-grid hp-kpi-grid">${primaryCard}${shareCard}${avgCard}${weakCard}</div>`;
}

// ── 가로 막대 그래프 ──────────────────────────────────
// 구분은 색과 함께 반드시 글자 badge 로도 적는다 — 색만으로 뜻을 전하지 않는다.
function hdmapPriorityChartHTML(result) {
  // 경계가 없는 구역은 막대로 그릴 값 자체가 없다 — 아래 비교표에만 '경계 미설정'으로 남긴다
  // (빈 막대 12개가 화면을 채우면 현황판이 아니라 설정 안내처럼 보인다).
  const rows = hdmapPrioritySortedRows(result).filter(r => r.hasPolygon);
  if (!rows.length) return '';
  const max = Math.max(1, ...rows.map(r => r.collectionMinutes));
  const bars = rows.map(r => {
    const width = Math.max(r.collectionMinutes > 0 ? 1.5 : 0, (r.collectionMinutes / max) * 100);
    const value = `${fmtNum(r.collectionMinutes)}분`;
    return `<div class="hp-chart-row">
      <span class="hp-chart-name">${escapeHtml(r.name)}</span>
      <span class="hp-tag hp-${r.priority}">${escapeHtml(r.priorityLabel)}</span>
      <span class="hp-chart-track" title="${escapeHtml(r.name)} ${escapeHtml(r.priorityLabel)} ${value}">
        <span class="hp-chart-bar hp-bar-${r.priority}" style="width:${width}%"></span>
      </span>
      <span class="hp-chart-value mono">${value}</span>
    </div>`;
  }).join('');
  const avgNote = result.summary.normalAvgMinutes > 0
    ? `<div class="hp-chart-legend">기준선: 일반지역 평균 <b>${fmtNum(Math.round(result.summary.normalAvgMinutes))}분</b></div>` : '';
  return `<div class="hp-chart"><div class="hp-block-title">구역별 수집 시간</div>${bars}${avgNote}</div>`;
}

// 수집 시간이 많은 순 — 경계가 없어 못 센 구역은 맨 아래
function hdmapPrioritySortedRows(result) {
  return result.rows.slice().sort((a, b) =>
    (a.hasPolygon === b.hasPolygon ? 0 : (a.hasPolygon ? -1 : 1))
    || b.collectionMinutes - a.collectionMinutes
    || a.areaNo - b.areaNo);
}

// ── 비교표 ───────────────────────────────────────────
function hdmapPriorityTableHTML(result) {
  const s = result.summary;
  // 숫자가 없을 때 왜 없는지를 칸마다 그대로 적는다 — "—" 하나로 합치지 않는다.
  const body = hdmapPrioritySortedRows(result).map(r => {
    const head = `<th scope="row">${escapeHtml(r.name)}</th>
      <td><span class="hp-tag hp-${r.priority}">${escapeHtml(r.priorityLabel)}</span></td>`;
    if (r.state === 'no_polygon') {
      return `<tr class="rec-excluded"><td class="hp-state hp-state-no_polygon" colspan="8">
        경계 미설정 — 경계를 그려야 셀 수 있어요(평균·비중 계산에서 제외)</td></tr>`
        .replace('<tr class="rec-excluded">', `<tr class="rec-excluded">${head}`);
    }
    if (r.state === 'error') {
      return `<tr class="rec-excluded">${head}
        <td class="hp-state hp-state-error" colspan="8">계산 실패 — [↻ 다시 계산]을 눌러 주세요(평균·비중 계산에서 제외)</td></tr>`;
    }
    // state === 'ok' | 'no_data'. 'no_data' 는 진짜 0분/0회/0일이다(잴 수 없는 것과 다르다).
    const zero = r.state === 'no_data';
    const last = hdmapPriorityDateOf(r.lastVisitedAt);
    return `<tr${zero ? ' class="hp-row-zero"' : ''}>
      ${head}
      <td class="mono">${fmtNum(r.collectionMinutes)}분</td>
      <td class="mono">${fmtNum(r.visitCount)}</td>
      <td class="mono">${fmtNum(r.sessionCount)}</td>
      <td class="mono">${fmtNum(r.uniqueDays)}</td>
      <td class="mono">${zero ? '<span class="hp-state hp-state-no_data">경계 안 기록 0건</span>' : fmtNum(r.recordCount)}</td>
      <td class="mono">${last ? escapeHtml(last) : '—'}</td>
      <td class="mono">${r.coveragePct == null
        ? '<span class="hp-state hp-state-no_cov" title="구역 안에 HD Map 도로 데이터가 없어 Coverage 를 재지 않았어요">Coverage 미계산</span>'
        : `${r.coveragePct.toFixed(1)}%`}</td>
      <td class="mono ${r.comparable ? (r.percentVsNormalAvg >= 0 ? 'hp-up' : 'hp-down') : ''}">${
        r.comparable
          ? `${HDMapPriority.formatPercentDiff(r.percentVsNormalAvg)} / ${HDMapPriority.formatRatio(r.ratioVsNormalAvg)}`
          : `<span class="hp-state">${escapeHtml(hdmapPriorityNoCompareReason(s))}</span>`}</td>
    </tr>`;
  }).join('');

  const basis = s.normalAvgBasis;
  // 경계 안/밖 건수 — "정말 기존 기록이 분류되고 있나"를 화면에서 바로 확인하게 한다.
  // 구역을 서로 독립으로 판정하므로 경계가 겹치면 합계에 중복이 들어간다(그때는 밖 건수를 단정하지 않는다).
  const inside = result.rows.reduce((acc, r) => acc + (r.recordCount || 0), 0);
  const total = hdmapPriorityTotalPoints;
  const overlapped = result.validation.overlaps.some(o => o.confirmed);
  const countLine = !result.validation.ready ? ''
    : `<div class="cond-note hp-foot hp-count-line">
        ①~⑫ 경계 안 기록 <b>${fmtNum(inside)}건</b>${total == null ? '' : ` / 전체 ${fmtNum(total)}건 · 경계 밖 <b>${
          overlapped ? '계산 보류(경계 겹침)' : `${fmtNum(Math.max(0, total - inside))}건`}</b>`}
        ${overlapped ? ' — 겹친 자리의 기록은 두 구역에 모두 세어져 합계가 부풀어 있어요' : ''}
      </div>`;
  return `
    <div class="hp-panel">
    <div class="hp-block-title">지역별 비교</div>
    <div class="rec-table-wrap">
      <table class="rec-table hp-table">
        <thead><tr>
          <th scope="col">지역</th><th scope="col">구분</th>
          <th scope="col">수집시간</th><th scope="col">방문</th><th scope="col">세션</th>
          <th scope="col">수집일</th><th scope="col">기록 수</th><th scope="col">마지막 수집</th><th scope="col">Coverage</th>
          <th scope="col">일반지역 평균 대비</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${countLine}
    <div class="cond-note hp-foot">
      수집시간은 90초 넘는 GPS 공백을 뺀 <b>유효 수집 시간</b>, 방문은 (날짜 × 차량),
      세션은 같은 차량이 그 구역에서 10분 이상 끊겼다 다시 들어온 횟수,
      Coverage 는 구역 안 HD Map 도로를 20m 칸으로 나눠 실제로 지난 비율이에요.
      일반지역 평균 <b>${fmtNum(Math.round(s.normalAvgMinutes))}분</b>은 ③④⑦⑧⑪⑫ 중 경계가 있는 ${fmtNum(basis.areaCount)}개 구역 기준이에요.
    </div>
    </div>`;
}

// ══════════════════════════════════════════════════════
//  [설정] 탭 — 구역 경계 관리
//
//  통계 화면은 "현황 확인"만 한다. 경계가 무엇이고 어떻게 넣는지는 여기에 모은다.
//  ①~⑫ 는 사업에서 정해진 고정 목록이라 앱에서 그려 만들지 않고 데이터 파일로 받는다
//  (직접 그려 만드는 구역은 [추천 주행] 탭의 세부 수집 구역이 따로 있다).
// ══════════════════════════════════════════════════════
async function renderHDMapPriorityAreaSettings() {
  const el = document.getElementById('settings-hdmap-priority');
  if (!el) return;
  if (!hdmapPriorityAvailable()) { el.innerHTML = ''; return; }
  const areas = await hdmapPriorityLoadAreas();
  const v = HDMapPriority.validateAreas(areas);
  const rows = areas.map(a => `
    <div class="settings-row">
      <span class="settings-row-name">${escapeHtml(a.name)}</span>
      <span class="hp-tag hp-${a.priority}">${escapeHtml(a.priorityLabel)}</span>
      <span class="settings-row-poly${a.hasPolygon ? '' : ' muted'}">${a.hasPolygon
        ? `경계 설정됨 · ${a.polygon.length}점${a.polygonSource === 'drawn' ? ' (직접 그림)' : ''}` : '경계 미설정'}</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="ir-note" style="margin:0 0 6px;">
      경계가 있는 구역만 [통계] 탭의 <b>HD Map 우선 수집</b>에서 집계돼요
      (지금 ${fmtNum(v.readyCount)} / ${fmtNum(v.areaCount)}개).
      경계가 없는 구역은 0분이 아니라 '경계 미설정'이고, 일반지역 평균과 우선지역 비중 계산에서 빠져요.
    </div>
    ${rows}
    <div class="cond-note" style="margin-top:8px;">
      <b>기본 경계</b> — 협의체 도로 데이터의 간선도로 중앙선
         (강남대로·논현로·언주로·선릉로·삼성로 × 도산대로·학동로·봉은사로·테헤란로)으로 둘러싼 블록이에요.
         <span class="mono">node tools/derive-hdmap-priority-areas.js</span> 로 다시 만들 수 있어요.<br>
      <b>고치기</b> — [통계] → <b>HD Map 우선 수집</b> 탭의 <b>구역 경계 설정</b> 버튼에서 다시 그려 저장하면
         그 구역은 직접 그린 경계가 우선이고, 기존 기록 전체로 바로 다시 셉니다(지우면 기본 경계로 돌아가요).
      ${v.warnings.length ? `<br><b>확인 필요:</b> ${escapeHtml(v.warnings.join(' / '))}` : ''}
      ${v.errors.length ? `<br><b>오류:</b> ${escapeHtml(v.errors.join(' / '))}` : ''}
    </div>`;
}
