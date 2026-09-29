// ══════════════════════════════════════════════════════════
//  priority-policy — HD Map 우선 수집지역 정책(Priority Policy)
//
//  사업 요청에 따라 "어느 구역을 얼마나 우선 수집할지"가 수시로 바뀐다(이번 달은 ⑤, 다음 달은 ⑩ …).
//  그래서 구역별 우선도를 코드에 두지 않고 "정책 데이터"로 관리한다.
//
//    policy = { policyId, policyName, effectiveFrom, effectiveTo, areaPriorities:{구역번호: 0~100},
//               createdAt, updatedAt, history:[이전 버전], source }
//
//  · 추천 엔진은 "오늘(한국 날짜)에 적용되는 정책" 하나를 골라 구역 우선도를 읽는다(activePolicy).
//    기간이 겹치면 시작일이 늦은(더 구체적인) 정책 → 최근 수정한 정책 순으로 고른다.
//  · 정책은 지우지 않는다. 저장할 때 목록에서 빠진 정책도 그대로 보존하고(mergePolicyPatch),
//    내용이 바뀐 정책은 이전 버전을 history 에 남긴다 — 과거 추천이 어떤 정책 때문이었는지 추적할 수 있다.
//  · 저장된 정책이 아예 없으면(처음 설치) 구역 데이터 파일(hdmap-priority-areas.json)의 priority 값으로
//    초기 정책 하나를 만든다(seedFromAreas). 코드가 아니라 데이터에서 온 값이다.
//  · 적용되는 정책이 없으면 사업 우선도는 0 — 추천은 데이터 부족도만으로 정한다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PriorityPolicy = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRIORITY_POLICY_VERSION = 1;
  // 단계(배지) — 모든 화면(추천·설정·통계)이 이 분류 하나만 쓴다. 값에서 나오고 구역 번호와는 무관하다.
  //   100 최우선 · 70~99 우선 · 40~69 보조 · 1~39 일반 · 0 비우선
  const TIERS = Object.freeze({
    primary: Object.freeze({ id: 'primary', label: '최우선', min: 100, rank: 5 }),
    priority: Object.freeze({ id: 'priority', label: '우선', min: 70, rank: 4 }),
    secondary: Object.freeze({ id: 'secondary', label: '보조', min: 40, rank: 3 }),
    normal: Object.freeze({ id: 'normal', label: '일반', min: 1, rank: 2 }),
    none: Object.freeze({ id: 'none', label: '비우선', min: 0, rank: 1 }),
  });
  const TIER_ORDER = Object.freeze(['primary', 'priority', 'secondary', 'normal', 'none']);
  // 통계의 "우선지역" 묶음 — 최우선·우선·보조(40 이상). 일반·비우선은 비교군("일반지역")
  const PRIORITY_GROUP_MIN = 40;
  // 설정 화면에서 고르는 단계(값은 사용자가 0~100 으로 직접 바꿀 수 있다)
  const PRESETS = Object.freeze([
    Object.freeze({ id: 'primary', label: '최우선', value: 100 }),
    Object.freeze({ id: 'priority', label: '우선', value: 70 }),
    Object.freeze({ id: 'secondary', label: '보조', value: 40 }),
    Object.freeze({ id: 'normal', label: '일반', value: 10 }),
    Object.freeze({ id: 'none', label: '비우선', value: 0 }),
  ]);
  const SEED_SOURCE_LABEL = '기존 HD Map 우선구역 설정';
  const SEED_POLICY_ID = 'seed-hdmap-area-file';
  const MAX_AREA_NO = 99;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const circledNo = n => (Number(n) >= 1 && Number(n) <= 20 ? String.fromCharCode(0x2460 + Number(n) - 1) : String(n));
  const presetById = id => PRESETS.find(p => p.id === id) || null;
  const presetOfValue = v => PRESETS.find(p => p.value === Number(v)) || null;
  // 값 → 단계. 100 최우선 · 70~99 우선 · 40~69 보조 · 1~39(0 초과) 일반 · 0 비우선
  function tierOf(value) {
    const v = Number(value) || 0;
    if (v >= 100) return TIERS.primary;
    if (v >= 70) return TIERS.priority;
    if (v >= 40) return TIERS.secondary;
    if (v > 0) return TIERS.normal;
    return TIERS.none;
  }
  const inPriorityGroup = value => (Number(value) || 0) >= PRIORITY_GROUP_MIN;
  // 정책에서 그 구역의 값(없으면 0 = 비우선). 정책이 없으면 모든 구역 0.
  function areaValue(policy, areaNo) {
    const v = policy && policy.areaPriorities ? Number(policy.areaPriorities[String(areaNo)]) : 0;
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  }
  // 구역 하나의 분류 — 화면 배지·통계 묶음·추천 라벨이 모두 이것을 쓴다
  function classifyArea(policy, areaNo) {
    const value = areaValue(policy, areaNo);
    const tier = tierOf(value);
    return { value, tier: tier.id, label: tier.label, group: inPriorityGroup(value) ? 'priority' : 'normal' };
  }
  // 우선지역 묶음(40 이상) 구역 번호 — 값 큰 순, 같으면 번호 순
  function priorityGroupAreaNos(policy, areaNos) {
    const nos = areaNos || Object.keys((policy && policy.areaPriorities) || {}).map(Number);
    return nos.filter(n => inPriorityGroup(areaValue(policy, n)))
      .sort((a, b) => areaValue(policy, b) - areaValue(policy, a) || a - b);
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  const validDate = d => DATE_RE.test(String(d)) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  const dateOrNull = v => (v == null || String(v).trim() === '' ? null : String(v).trim());

  // 한 정책 검증·정리 — 잘못된 값이 있으면 errors 에 이유를 담는다(저장하지 않는다)
  function normalizePolicy(input, options) {
    const o = options || {};
    const p = input && typeof input === 'object' ? input : {};
    const errors = [];
    const name = String(p.policyName || '').trim();
    if (!name) errors.push('정책 이름을 적어주세요.');
    if (name.length > 80) errors.push('정책 이름은 80자까지예요.');
    const from = dateOrNull(p.effectiveFrom), to = dateOrNull(p.effectiveTo);
    if (from && !validDate(from)) errors.push(`${name || '정책'}: 시작일은 YYYY-MM-DD 형식이어야 해요.`);
    if (to && !validDate(to)) errors.push(`${name || '정책'}: 종료일은 YYYY-MM-DD 형식이어야 해요.`);
    if (from && to && validDate(from) && validDate(to) && from > to) errors.push(`${name || '정책'}: 시작일(${from})이 종료일(${to})보다 늦어요.`);
    const areaPriorities = {};
    Object.entries(p.areaPriorities || {}).forEach(([k, v]) => {
      const no = Number(k);
      if (!Number.isInteger(no) || no < 1 || no > MAX_AREA_NO) { errors.push(`${name || '정책'}: 구역 번호 "${k}"가 올바르지 않아요.`); return; }
      if (v === '' || v == null) return;                          // 비워 두면 0(일반)
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) { errors.push(`${name || '정책'}: ${circledNo(no)} 우선도는 0~100 이어야 해요.`); return; }
      if (n > 0) areaPriorities[String(no)] = Math.round(n * 10) / 10;
    });
    const now = o.now || new Date().toISOString();
    const value = {
      policyId: String(p.policyId || `pp-${fnv1a(`${name}|${now}|${Math.random()}`)}`),
      policyName: name,
      effectiveFrom: from,
      effectiveTo: to,
      areaPriorities,
      createdAt: p.createdAt || now,
      updatedAt: p.updatedAt || now,
      source: p.source || 'user',
      sourceLabel: p.sourceLabel || null,
      history: Array.isArray(p.history) ? p.history.slice(-50) : [],
    };
    return { ok: !errors.length, errors, value: errors.length ? null : value };
  }

  const contentKey = p => JSON.stringify([p.policyName, p.effectiveFrom, p.effectiveTo,
    Object.keys(p.areaPriorities || {}).sort((a, b) => a - b).map(k => [k, p.areaPriorities[k]])]);

  // 저장 패치 — next 를 검증하고, prev 에 있던 정책은 목록에서 빠져도 보존한다(삭제 없음).
  // 내용이 바뀐 정책은 updatedAt 을 새로 찍고 이전 버전을 history 에 남긴다.
  function mergePolicyPatch(prevList, nextList, options) {
    const now = (options && options.now) || new Date().toISOString();
    const prev = new Map((Array.isArray(prevList) ? prevList : []).filter(p => p && p.policyId).map(p => [p.policyId, p]));
    const errors = [];
    const out = [];
    const seen = new Set();
    (Array.isArray(nextList) ? nextList : []).forEach(raw => {
      const before = raw && raw.policyId ? prev.get(raw.policyId) : null;
      const v = normalizePolicy({ ...raw, createdAt: (before && before.createdAt) || raw.createdAt, history: before ? before.history : raw.history }, { now });
      if (!v.ok) { errors.push(...v.errors); return; }
      const p = v.value;
      if (seen.has(p.policyId)) return;
      seen.add(p.policyId);
      if (before && contentKey(before) !== contentKey(p)) {
        p.history = (before.history || []).concat([{
          policyName: before.policyName, effectiveFrom: before.effectiveFrom, effectiveTo: before.effectiveTo,
          areaPriorities: { ...before.areaPriorities }, updatedAt: before.updatedAt,
        }]).slice(-50);
        p.updatedAt = now;
        if (p.source === 'seed') p.source = 'user';
      } else if (before) {
        p.updatedAt = before.updatedAt;
      } else if (!raw.updatedAt) {
        p.updatedAt = now;
      }
      out.push(p);
    });
    prev.forEach((p, id) => { if (!seen.has(id)) out.push(p); });   // 빠진 정책도 보존
    return { ok: !errors.length, errors, value: errors.length ? null : out };
  }

  // 날짜(YYYY-MM-DD)에 적용되는 정책 — 없으면 null
  function activePolicy(policies, date) {
    const list = (policies || []).filter(p => p && (!p.effectiveFrom || p.effectiveFrom <= date) && (!p.effectiveTo || date <= p.effectiveTo));
    if (!list.length) return null;
    return list.slice().sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || ''))
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  }

  // 겹치는 기간 알림(저장은 막지 않는다 — 겹치면 시작일이 늦은 정책이 이긴다는 규칙을 보여준다)
  function overlaps(policies) {
    const list = (policies || []).filter(Boolean);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const aFrom = a.effectiveFrom || '0000-01-01', aTo = a.effectiveTo || '9999-12-31';
        const bFrom = b.effectiveFrom || '0000-01-01', bTo = b.effectiveTo || '9999-12-31';
        if (aFrom <= bTo && bFrom <= aTo) out.push([a.policyName, b.policyName]);
      }
    }
    return out;
  }

  // 처음 설치 — 기존 구역 데이터 파일(hdmap-priority-areas.json)의 priority 를 값으로 옮긴 초기 정책.
  //   primary → 100(최우선) · priority → 70(우선) · 그 밖(normal = 비교군) → 0(비우선)
  //   (normal 을 0 으로 두는 이유: 예전 추천 점수에서 비교군 구역의 사업 우선도는 0 이었다 — 점수가 그대로 유지된다)
  const SEED_VALUES = Object.freeze({ primary: 100, priority: 70, secondary: 40 });
  function seedFromAreas(areas, meta) {
    const areaPriorities = {};
    (areas || []).forEach(a => {
      const v = SEED_VALUES[a && a.declaredPriority];
      if (v > 0) areaPriorities[String(a.areaNo)] = v;
    });
    if (!Object.keys(areaPriorities).length) return null;
    return {
      policyId: SEED_POLICY_ID,
      policyName: '초기 정책',
      sourceLabel: SEED_SOURCE_LABEL,
      effectiveFrom: null, effectiveTo: null,
      areaPriorities,
      createdAt: (meta && meta.generatedAt) || null,
      updatedAt: (meta && meta.generatedAt) || null,
      source: 'seed', history: [],
    };
  }

  // 저장된 정책 목록(없으면 초기 정책 하나) — 저장한 적이 없을 때만 seed 를 쓴다(빈 목록은 "정책 없음")
  function resolvePolicies(saved, areas, meta) {
    if (Array.isArray(saved)) return saved;
    const seed = seedFromAreas(areas, meta);
    return seed ? [seed] : [];
  }
  // 모든 화면이 부르는 한 곳 — 설정값(settings.priorityPolicies) + 구역 목록 + 날짜 → 활성 정책
  function resolveActive(saved, areas, meta, date) {
    const policies = resolvePolicies(saved, areas, meta);
    return { policies, policy: activePolicy(policies, date) };
  }
  // 화면에 적는 출처 — 초기 정책은 "기존 HD Map 우선구역 설정"
  const sourceText = p => (p && p.source === 'seed' ? `출처: ${p.sourceLabel || SEED_SOURCE_LABEL}` : (p ? '출처: 설정에서 직접 입력' : ''));

  // "⑩ 100 · ⑨ 80 · ⑥ 50" — 값 큰 순
  function summarize(policy) {
    if (!policy) return '적용 정책 없음';
    const rows = Object.entries(policy.areaPriorities || {}).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return rows.length ? rows.map(([k, v]) => `${circledNo(k)} ${v} ${tierOf(v).label}`).join(' · ') : '모든 구역 0(비우선)';
  }

  // 추천 결과·추천 상태에 남기는 참조(과거 추천을 다시 볼 때 "당시 적용 정책")
  function reference(policy) {
    if (!policy) return null;
    return {
      policyId: policy.policyId, policyName: policy.policyName,
      effectiveFrom: policy.effectiveFrom, effectiveTo: policy.effectiveTo,
      updatedAt: policy.updatedAt, summary: summarize(policy),
      areaPriorities: { ...(policy.areaPriorities || {}) },
    };
  }

  // 캐시 키용 지문 — 정책이 바뀌면 값이 달라진다
  function fingerprint(policies) {
    return fnv1a(JSON.stringify((policies || []).map(p => [p.policyId, p.updatedAt, contentKey(p)])));
  }

  function periodText(p) {
    if (!p) return '—';
    if (!p.effectiveFrom && !p.effectiveTo) return '기간 제한 없음';
    return `${p.effectiveFrom || '처음부터'} ~ ${p.effectiveTo || '종료일 없음'}`;
  }

  return {
    PRIORITY_POLICY_VERSION, PRESETS, SEED_POLICY_ID, SEED_SOURCE_LABEL, TIERS, TIER_ORDER, PRIORITY_GROUP_MIN,
    circledNo, presetById, presetOfValue, tierOf, inPriorityGroup, areaValue, classifyArea, priorityGroupAreaNos,
    normalizePolicy, mergePolicyPatch, activePolicy, overlaps,
    seedFromAreas, resolvePolicies, resolveActive, sourceText, summarize, reference, fingerprint, periodText,
  };
}));
