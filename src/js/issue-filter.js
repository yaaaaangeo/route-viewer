// ══════════════════════════════════════════════════════════
//  issue-filter — Import 이슈 · 이슈 데이터 필터의 단일 원천
//
//  파일 하나를 불러올 때 "이 파일에 이슈가 있었는지"와 한 줄 메모를 Import 이력에 남긴다.
//  그 이슈는 메모로만 끝나지 않고, 그 파일에서 들어온 GPS 레코드와 출처 관계(record_sources)로 이어진다.
//
//  중복 제거 때문에 한 레코드가 여러 파일에서 왔을 수 있다(A.xlsx 이슈 있음 / B.xlsx 이슈 없음).
//  그래서 레코드마다 "출처 묶음"을 3비트 마스크로 요약해 두고, 필터는 그 마스크로 판정한다.
//
//    1 NON_ISSUE  이슈 없는 파일에서도 왔다
//    2 OPEN       확인 필요(open) 이슈 파일에서 왔다
//    4 RESOLVED   확인 완료(resolved) 이슈 파일에서 왔다
//    0            출처 기록이 없다(이 기능 이전에 들어온 예전 데이터) → 이슈 정보 없음으로 본다
//
//  필터 의미
//    all             전부
//    clean           "확인 필요 이슈 파일에만" 연결된 레코드를 뺀다.
//                    정상 파일이나 확인 완료 파일에서도 왔다면 남긴다(정상 출처가 있으므로).
//                    출처 기록이 없는 예전 데이터도 남긴다 — 지도에서 갑자기 사라지면 안 되므로.
//    issue_all       이슈가 등록된 파일에서 온 레코드(정상 파일에도 있어도 포함 — 영향 확인용)
//
//  확인 필요(open)/확인 완료(resolved)는 이슈의 처리 상태일 뿐 따로 보는 필터가 아니다.
//  상태는 달력 배지·일자 요약·데이터 관리에서 보고 바꾼다.
//
//  레코드는 어떤 필터에서도 한 번만 센다(여러 Import 에 연결돼 있어도 중복 집계하지 않는다).
//  SQLite(electron/database.js)는 같은 의미를 EXISTS SQL 로, IndexedDB(src/js/storage.js)는 같은 의미를
//  이 파일의 maskMatches() 로 판정한다.
// ══════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IssueFilter = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ISSUE_NOTE_MAX = 200;

  const MASK = Object.freeze({ NON_ISSUE: 1, OPEN: 2, RESOLVED: 4 });

  const ISSUE_STATUSES = Object.freeze(['open', 'resolved']);
  const ISSUE_STATUS_LABELS = Object.freeze({ open: '확인 필요', resolved: '확인 완료' });

  // 필터는 셋뿐이다. '확인 필요'·'확인 완료'는 이슈의 처리 상태이지 따로 볼 데이터 묶음이 아니다 —
  // 상태별로 나눠 놓으면 '이슈 없음'·'이슈만'과 뜻이 겹쳐서 어느 걸 보고 있는지 헷갈린다.
  // 상태는 달력 배지·데이터 관리 목록에서 확인하고 바꾼다.
  const ISSUE_FILTERS = Object.freeze(['all', 'clean', 'issue_all']);
  const ISSUE_FILTER_LABELS = Object.freeze({
    all: '전체 데이터', clean: '이슈 없는 데이터', issue_all: '이슈 데이터만',
  });
  // 화면 버튼처럼 짧게 쓰는 이름
  const ISSUE_FILTER_SHORT_LABELS = Object.freeze({
    all: '전체', clean: '이슈 없음', issue_all: '이슈만',
  });
  // 예전에 저장해 둔 값(확인 필요만/확인 완료만)은 '이슈만'으로 본다 — 화면이 빈 목록으로 뜨지 않게
  const LEGACY_FILTER_ALIASES = Object.freeze({ issue_open: 'issue_all', issue_resolved: 'issue_all' });

  function isIssueFilter(v) { return ISSUE_FILTERS.includes(v); }
  function normalizeFilter(v) {
    if (isIssueFilter(v)) return v;
    return LEGACY_FILTER_ALIASES[v] || 'all';
  }
  function filterLabel(v) { return ISSUE_FILTER_LABELS[normalizeFilter(v)]; }
  function statusLabel(status) { return ISSUE_STATUS_LABELS[status] || '이슈 없음'; }

  // import 한 건 → 그 파일이 레코드에 씌우는 마스크 비트
  function maskBitOf(imp) {
    if (!imp || !imp.hasIssue) return MASK.NON_ISSUE;
    return imp.issueStatus === 'resolved' ? MASK.RESOLVED : MASK.OPEN;
  }

  // sources: 그 레코드가 나온 import 들 [{hasIssue, issueStatus}]
  function maskFromSources(sources) {
    let mask = 0;
    (sources || []).forEach(s => { mask |= maskBitOf(s); });
    return mask;
  }

  function maskMatches(mask, filter) {
    const m = Number(mask) || 0;
    switch (normalizeFilter(filter)) {
      case 'clean': return m === 0 || (m & (MASK.NON_ISSUE | MASK.RESOLVED)) !== 0;
      case 'issue_all': return (m & (MASK.OPEN | MASK.RESOLVED)) !== 0;
      default: return true;
    }
  }

  // 화면에 보여줄 한 레코드의 상태 — 'legacy'(출처 기록 없음) · 'clean' · 'open' · 'resolved'
  function maskLabel(mask) {
    const m = Number(mask) || 0;
    if (m === 0) return '이슈 정보 없음';
    if (m & MASK.OPEN) return (m & MASK.NON_ISSUE) ? '확인 필요 이슈 파일 + 정상 파일' : '확인 필요 이슈';
    if (m & MASK.RESOLVED) return (m & MASK.NON_ISSUE) ? '확인 완료 이슈 파일 + 정상 파일' : '확인 완료 이슈';
    return '이슈 없음';
  }

  // ── Import 화면 입력 검증 ─────────────────────────────
  // 이슈를 체크했으면 한 줄 메모가 필수. 공백만 있는 메모는 허용하지 않는다. 최대 200자.
  function validateIssueInput(input) {
    const hasIssue = !!(input && input.hasIssue);
    const raw = input && input.issueNote != null ? String(input.issueNote) : '';
    const note = raw.replace(/\s+/g, ' ').trim();
    const errors = [];
    if (hasIssue && !note) errors.push('이슈 내용을 한 줄로 적어주세요.');
    if (note.length > ISSUE_NOTE_MAX) errors.push(`이슈 내용은 ${ISSUE_NOTE_MAX}자까지 쓸 수 있어요(지금 ${note.length}자).`);
    if (errors.length) return { ok: false, errors, value: null };
    return {
      ok: true,
      errors: [],
      value: hasIssue
        ? { hasIssue: true, issueNote: note, issueStatus: 'open' }
        : { hasIssue: false, issueNote: '', issueStatus: '' },
    };
  }

  // 저장소가 Import/수정 때 쓰는 정규화 — 잘못된 값이면 이유를 담아 던진다
  function normalizeIssueForStorage(input, previous) {
    const prev = previous || {};
    const wantsIssue = input && input.hasIssue !== undefined ? !!input.hasIssue : !!prev.hasIssue;
    const note = input && input.issueNote !== undefined ? input.issueNote : (prev.issueNote || '');
    const v = validateIssueInput({ hasIssue: wantsIssue, issueNote: note });
    if (!v.ok) {
      const err = new Error(v.errors.join('\n'));
      err.errors = v.errors;
      throw err;
    }
    const status = input && input.issueStatus !== undefined ? input.issueStatus : (prev.issueStatus || 'open');
    if (v.value.hasIssue) {
      if (!ISSUE_STATUSES.includes(status)) {
        const err = new Error(`이슈 상태는 ${ISSUE_STATUSES.join(' 또는 ')} 여야 해요.`);
        err.errors = [err.message];
        throw err;
      }
      v.value.issueStatus = status;
    }
    return v.value;
  }

  // imports 목록 → 이슈 현황 요약(데이터 관리·통계 화면 공용)
  function summarizeImports(imports) {
    const list = imports || [];
    const issue = list.filter(i => i && i.hasIssue);
    return {
      importCount: list.length,
      cleanImportCount: list.length - issue.length,
      issueImportCount: issue.length,
      openCount: issue.filter(i => i.issueStatus === 'open').length,
      resolvedCount: issue.filter(i => i.issueStatus === 'resolved').length,
      conflictCount: list.filter(i => i && i.issueConflict).length,
    };
  }

  // 날짜별 이슈 배지 — 같은 Import 가 여러 번 세지 않도록 importId 로 묶는다
  function summarizeDateIssues(dateImports) {
    const seen = new Set();
    let open = 0, resolved = 0, records = 0;
    (dateImports || []).forEach(im => {
      if (!im || !im.hasIssue || seen.has(im.importId)) return;
      seen.add(im.importId);
      if (im.issueStatus === 'resolved') resolved++; else open++;
      records += im.recordCount || 0;
    });
    return { open, resolved, total: open + resolved, records };
  }

  return {
    ISSUE_NOTE_MAX,
    MASK,
    ISSUE_STATUSES,
    ISSUE_STATUS_LABELS,
    ISSUE_FILTERS,
    ISSUE_FILTER_LABELS,
    ISSUE_FILTER_SHORT_LABELS,
    LEGACY_FILTER_ALIASES,
    isIssueFilter,
    normalizeFilter,
    filterLabel,
    statusLabel,
    maskBitOf,
    maskFromSources,
    maskMatches,
    maskLabel,
    validateIssueInput,
    normalizeIssueForStorage,
    summarizeImports,
    summarizeDateIssues,
  };
}));
