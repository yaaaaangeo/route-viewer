# Route Viewer × nav-app 연계 — 추천 → 수집 주행 → 결과 → 재추천

> 같은 문서가 두 저장소에 있습니다: `nav-app/docs/collection-loop.md`, `route-viewer/docs/collection-loop.md`.
> 서버는 없습니다. 문서는 **파일로만** 오갑니다 (카카오톡·Quick Share·파일 앱·Google Drive 동기화 폴더).
> 두 코드베이스는 합치지 않았습니다 — 같은 규칙(정규 직렬화·SHA-256·좌표 순서·**통과 판정**)을 양쪽이 각자 갖고, 공용 시험 파일과 글자 비교로 같은지 확인합니다.
>
> **가장 중요한 구분**: "계획 경로가 추천 도로를 지나간다"(nav-app 이 TMAP 경로로 확인)와 "수집 목표를 채웠다"(주행 뒤 Route Viewer 가 GPS 원본으로 판정)는 다른 것입니다. 앞의 것으로 뒤의 것을 정하지 않습니다.

## 1. 한눈에

```
Route Viewer (PC)                                   nav-app (휴대폰 · Android Auto)
─────────────────                                   ───────────────────────────────
오늘 추천 Top 3 ─ ☑ 계획에 넣기
  └ 🧭 네비게이션으로 보내기 (예상·부족 확인)
        ──▶ collectionplan_*.json ──▶ 파일 열기 → 📌 주행 경로 관리 › 🎯 추천 수집 주행
            (옆 도로 · 방문별 방향 · 예상)    · 항목·이유·권장 시간대·방문별 방향·방향 가능 여부(확인 필요)
                                             · 🔎 TMAP 경로 만들기·검증 (passJudge · 우회·U턴 검사)
                                             · 안 되는 방향만 빼기 · TMAP 기준 예상(시간대 밖 방문 제외)
                                             · 🔒 확정 → 확정 경로(plan 연결 + 필수 구간·옆 도로 동봉)
                                             · ▶ 주행 — 세션 기록 · 끝: 완료 / 🏁 수동 종료 / 재시작·중단
            ◀── driveresult_*.json (뺀 방향·원인 포함) ── Drive Torres/<n호차>/ ◀──┤
            ◀── 주행기록_*.xlsx (GPS 원본) ── Drive ◀───────────────────────────────┘
자동 가져오기(60초) ─ JSON·엑셀 순서 무관 · 동기화 중 JSON 은 기다림
  └ GPS 원본 + 같은 passJudge 로 계획 대비 판정 (보고값은 참고만)
  └ 계획별 상태(생성·내보냄·전달·결과·GPS 검증·가져오기 실패) · 추천 전후 변화 · 방향 피드백 → 다음 계획
```

## 2. 실제 연결 지점

| 단계 | 저장소 · 위치 | 하는 일 |
|---|---|---|
| 계획 만들기 | RV `src/js/collection-loop.js` `buildCollectionPlan` · `planItemFromRecommendation` | 점수·부족분·근거는 추천 그대로. 방향 가능성(`directionFeasibility`), 방문별 방향(`visits`), 반복·예상(`estimatePasses`), 옆 도로(`pickNeighbors`)를 따로 적는다 |
| 계획 보내기 | RV `src/js/plan-loop-view.js` `sendPicksToNavigation` | 예상·부족·제외 이유를 확인한 뒤 저장 → 파일로 실제 저장했을 때만 `markPlanExported` |
| 계획 받기 | nav-app `receiveRoutePackageText` → `detectLinkDocument` → `receiveCollectionPlanText` | 확정 경로와 같은 열기 경로. 형식·SHA-256·비밀정보·좌표·지역 검사 → 미리보기 → "이 계획 쓰기" |
| TMAP 경로 | nav-app `cpVisitLegs` · `cpSearchVisit` · `cpSearchAll` | 방문별 방향대로 탐색. 경유점 = 진입점 + 구간 중간점, 시도 최대 3번 — 단, 방향 자체가 안 되면 1번으로 끝 |
| 필수 구간 검증 | nav-app `validateMustPass` → **`passJudge`** | 계획에 담긴 옆 도로와 함께 Route Viewer 와 같은 규칙으로 판정 + 원인(`cause`) |
| 우회 검사 | nav-app `cpRouteCheck` | 도로 유형별 우회 비율·추가 거리·U턴 → 경고 / 확정 막음 |
| 예상 | nav-app `cpEstimate` | TMAP 경로 시간으로 시간대 안 통과 횟수·분 — 예상이지 달성이 아님 |
| 확정 | nav-app `buildPackageFromPlan` → `buildRoutePackage` | 모든 방문 통과 + 막힘 없음일 때만. 패키지에 필수 구간·옆 도로를 함께 담는다 |
| 받은 패키지 재검증 | nav-app `verifyPlanPackage` (`receiveRoutePackageText` 미리보기) | 보낸 쪽 `mustPassCheck` 는 참고로만, 이 휴대폰에서 다시 판정. 실패·정보 없음이면 "이 경로로 주행" 버튼 없음 |
| 주행 기록 | nav-app `drSync` · `drOnFix` · `drOnOffRoute` · `drOnPause` | 구간 시작·완료는 즉시 저장, 측위는 10초마다 heartbeat |
| 결과 만들기 | nav-app `drFinalize` · `buildDriveResult` · `recoverDriveSession` | `planAdjustments`(뺀 항목·방향·원인) 포함 |
| 결과 올리기 | Android `phone/WebActivity.kt` `saveDriveResult` | 다운로드 폴더 + Drive `Torres/<n호차>/` |
| 결과 받기 | RV `electron/auto-import.js` `_processLinkFile` | 결과 → 저장 · 끝나지 않은 JSON 은 `pending`(동기화 중), 10분 넘게 그대로면 "깨진 JSON" 실패 · 실패는 계획에 연결해 기록 |
| 다시 판정 | RV `electron/database.js` `evaluateDriveResult` → `evaluatePlanExecution` → **`passJudge`** | 결과 시각 범위의 GPS 원본으로. 판정 규칙 판이 바뀌면 다시 계산 |
| 계획별 상태 | RV `listPlanStatuses` → `CollectionLoop.planStatus` | 증거 있는 단계만 ✅ — 전달은 결과가 와야 확인 |
| 방향 피드백 | RV `listDirectionFeedback` → `directionFeedbackFromResults` | 결과의 `planAdjustments` → 다음 계획에서 그 방향 제외(이유 표시) |
| 전후 비교 | RV `compareRecommendations` | 같은 조건(구간·요일·시간대·조도)으로 비교. 목록에 없다고 충족 아님 |

## 3. 공통 규칙

- **정규 직렬화 `nav-app-c14n-v1`**: 키 이름순 정렬, 숫자는 `round(x × 10⁶)` 정수 문자열, 문자열은 JSON 이스케이프, `integrity` 는 빼고 계산.
- **SHA-256**: 위 문자열(UTF-8)의 SHA-256. 검증 코드 = 앞 8자리 `AB12-CD34`.
- **좌표**: `[위도, 경도]`, 대한민국 범위 밖이면 거부. **비밀정보 키 금지**. **개인정보 최소화**(차량 이름만, 결과 파일에 GPS 좌표 없음).

## 4. 통과 판정 공통 규격 — `nav-app-pass-v1`

### 4-1. 예전 두 판정의 차이 (2026-10-17 실주행 검증에서 확인)

| 항목 | 예전 nav-app (`validateMustPass`) | 예전 Route Viewer (`evaluatePlanExecution`) | 지금 (`passJudge`, 양쪽 같음) |
|---|---|---|---|
| 거리 허용 | 25 m (필수 구간 점 → TMAP 경로) | 25 m (GPS 점 → 도로, `SubZones.matchToRoad`) | 25 m (궤적 점 → 대상 도로) |
| 옆 도로 | 없음 — 반대 차도·나란한 길도 대상 도로로 셈 | 지역 도로망(데스크톱) / 계획 구간만(브라우저) | **계획에 담긴 옆 도로**(대상 40 m 안 다른 구간) — 더 가까운 나란한 길이면 그 길 기록 |
| 진행 방향 | 경로 선분 방위 ±60° | 기준점(3 m) 방위 ±60°·≥120° | 기준점(3 m·20초) 방위 ±60° = 정방향, ≥120° = 역방향, 그 사이 = 방향 모름(세지 않음) |
| 커버리지 | 10 m 간격 점 비율 | 20 m 칸 비율(여러 통과 합침) | 20 m 칸 — 단, **'통과 1회' = 한 번에 이어서 80% 이상** |
| 유효 GPS | — | 점프 > max(3, 2%) 또는 유효 < 50% → 품질 낮음 | 같은 품질 기준 + 점프는 '튐'(되돌아옴)과 '자리 옮김'(다시 잡힘)을 구분 |
| 구간 분할 | — | 60초 끊김 = 새 통과 | 60초 끊김 = 다른 주행 구간(앞뒤를 한 통과로 잇지 않음) · 대상 도로 위 정차는 이어 줌 |
| GPS 공백 시간 | — | 90초까지 시간으로 셈 | 측위 하나당 최대 5초 |
| 결과 | 계획 경로 92% 통과 | 같은 경로 주행 GPS 75%(일부) | 같은 입력이면 같은 결과 (글자 비교 시험) |

판정 코드는 `/* PASS-JUDGE nav-app-pass-v1 BEGIN … END */` 블록이며 nav-app `index.html` 과 Route Viewer `src/js/collection-loop.js` 에 **글자 그대로 같습니다**. 양쪽 시험이 옆 저장소가 있으면 글자를 비교하고, 없으면 공용 사례 파일(`tests/fixtures/pass_judge_cases.json`, 17개 합성 사례)의 숫자 기대값으로 확인합니다.

### 4-2. 두 판정은 다른 질문에 답한다

| | 계획 경로 판정 (nav-app, 확정 전) | 수집 목표 판정 (Route Viewer, 주행 뒤) |
|---|---|---|
| 입력 | TMAP 경로 좌표 → 5 m 간격 궤적(경로 시간 비례) | 주행기록 엑셀 GPS 원본 (이슈 표시 제외) |
| 질문 | 이 경로가 그 방향으로 한 번에 80% 이상 지나는가 | 권장 방향·권장 시간대 안에 몇 번(한 번에 80%↑) 지났고 몇 분 모았나 |
| 결과 | 통과 / 원인(`direction_unreachable` · `parallel_road` · `partial` · `not_on_road`) + 우회 검사 | `achieved` · `passed`(지나감, 목표 미달) · `wrong_direction` · `partial` · `not_driven` · `unverified` |
| 목표 달성 | **판정하지 않음** (예상만) | GPS 검증됨 + 통과 + 시간대 수집 분 ≥ 부족분 + 시간대 안 통과 ≥ 계획 방문 |

GPS 품질이 낮거나(`low_quality`) 원본이 없거나 모두 이슈 표시면(`unverified`) 목표 달성으로 확정하지 않습니다.

## 5. CollectionPlan (`format: "nav-app-collection-plan"`, schemaVersion 1)

계획 전체: `planId`·`planVersion`·`createdAt`·`planDate`·`region`·`regionCode`·`policy`·`source`·`window`·`vehicleCount`·`passJudge`(`nav-app-pass-v1`)·`items[]`·`excludedItems[]`(가능한 방향이 없어 뺀 항목과 이유)·`travel[]`(이동 어림 — 차량 경로 아님)·`feasibility`(`windows[]` 시간대별 필요 분 vs 길이, `warnings[]`)·`totals`(`passes`·`deficitMinutes`·`expectedMinutes`·`shortfallMinutes` …)·`integrity`.

항목(`items[]`)의 주요 필드:

| 필드 | 뜻 |
|---|---|
| `score` · `deficit` · `reasons` · `conditionLabel` · `timeWindow` | 추천 엔진 값 그대로 (nav-app 은 다시 계산하지 않음) |
| `target` | `{targetMinutes, currentMinutes, deficitMinutes, direction, currentVisits, recommendedPasses, recommendedPassMinutes}` — 엔진의 고정 제안(예: 10회 × 6분)도 그대로 남김 |
| `direction` | 추천 방향 `forward`·`backward`·`both` (`forward` = `geometry` 좌표 순서) |
| `directionPlan` | `{feasibility:{forward,backward}, allowed[], excluded[{direction, reason}]}` — 상태 `needs_check`(확인 필요, 기본) · `gps_seen`(기록상 주행 있음, 참고) · `tmap_unreachable`(nav-app 보고 — 이 방향만 제외) |
| `visits[]` · `passes` | 방문별 목표 방향 `[{passNo, direction}]` · 방문 수(1~20) |
| `estimate` | `{speedKmh, passSec, turnSec, neededPasses, fitPasses, plannedPasses, windowMinutes, expectedMinutes, deficitMinutes, shortfallMinutes, limitedBy, note}` |
| `mustPass` | `{path(첫 방문 방향), direction, toleranceM:25, minCoverage:0.8, judge, neighbors[[…]], neighborsKnown}` |

**반복 횟수 (P1-3)** — 예전에는 엔진 제안(모든 추천이 10회)을 5회로 잘랐습니다. 지금은 구간 길이로 1회 시간(30 km/h 기준)을 어림해 `필요 횟수 = ⌈부족분 ÷ 1회⌉`, `시간대에 들어가는 횟수 = ⌊시간대 ÷ (1회 + 돌아오는 시간)⌋`(양방향 60초, 한 방향 반복 max(120초, 1.5×1회)) 중 작은 값, 최대 20회. 다 못 채우면 `shortfallMinutes` 와 원인(`limitedBy`)을 적고 저장 전에 보여 줍니다. 예: 790 m 구간 · 부족 60분 → 필요 38회 · 시간대 46회 → 20회(상한) · 예상 31.7분 · 28.3분 남음.

**방향 가능성 (P1-2)** — HD Map 선에는 일방통행·분리 차도·진입 제한 정보가 없습니다(이름·좌표뿐, 같은 이름 나란한 선이 거의 모든 도로의 97~100% 길이에 있어 분리 차도 판별에도 쓸 수 없음 — 실측). 그래서 지도만으로 가능·불가를 정하지 않고 기본 "확인 필요"로 두며, nav-app TMAP 검증 결과(주행 결과의 `planAdjustments`)로 "이 방향 경로 없음"이 보고된 방향만 다음 계획에서 뺍니다(이유 표시). 두 방향 모두 안 되면 항목을 `excludedItems` 로 옮깁니다.

## 6. nav-app — 계획 → 확정 경로

- **방문 펼치기**: 계획의 `visits` 순서·방향 그대로. 사용자가 뺀 방향(`skippedDirs`)은 넣지 않음. 앞 방문 끝과 이번 끝이 같으면 진입 이동 구간(`CP-n-p-A`).
- **TMAP 재시도**: 중간점 2개 → 4개 → 최단거리 옵션. 원인이 `direction_unreachable`(반대 방향으로만 지남) 또는 `parallel_road`(옆 도로·반대 차도로만 지남)이면 더 시도하지 않음 — 실측 25개 방문에서 이런 실패는 경유점을 늘려도 고쳐지지 않았음. 전체 탐색을 다시 눌러도 이런 방문과 우회 막힘 방문은 부르지 않고, 방문별 "재탐색"으로만 다시 부름.
- **TMAP 오류**: 직선으로 대신하지 않고 "경로 없음". 경로 없음·검증 실패·우회 막힘이 하나라도 있으면 확정 불가 (버튼·함수 모두).
- **우회·U턴 (P2-3)**: `ratio = 경로 길이 ÷ (이전 끝→진입 직선 + 구간 길이)`, `extraM = 차이`.

| 도로 유형 (이름으로) | 경고 | 확정 막음 |
|---|---|---|
| local (골목·일반) | 비율 ≥ 3 · 추가 ≥ 1.5 km · U턴 ≥ 2 | (비율 ≥ 6 이고 추가 ≥ 4 km) 또는 U턴 ≥ 4 |
| arterial (`…대로`) | 비율 ≥ 3 · 추가 ≥ 2.5 km · U턴 ≥ 2 | (비율 ≥ 6 이고 추가 ≥ 6 km) 또는 U턴 ≥ 4 |
| expressway (고속·도시고속·간선) | 비율 ≥ 4 · 추가 ≥ 5 km · U턴 ≥ 1 | (비율 ≥ 10 이고 추가 ≥ 15 km) 또는 U턴 ≥ 3 |

  기준은 localStorage `nav3-route-limits` 에 같은 모양의 JSON 으로 바꿀 수 있습니다(예: `{"local":{"blockUturns":5}}`). 진입 이동 구간은 경고만. 최단거리 옵션으로 찾은 경로는 경고에 표시.
- **방향만 빼기**: 항목별 "형상 순서 빼기 / 형상 반대 빼기". 뺄 때 그 방향의 마지막 TMAP 원인을 기억해 주행 결과 `planAdjustments.skippedDirections` 로 보냄.
- **TMAP 기준 예상**: 권장 시간대 시작부터 TMAP 경로 시간을 이어 붙여(시간대 전이면 기다림) 방문마다 `passJudge` 로 통과 횟수·초를 셈. 시간대가 끝난 뒤 방문·일부만 지나는 통과는 넣지 않음. 확정 확인 창에 항목별 예상·부족·경로 경고를 보여 줌.
- **확정 패키지**: 기존 Route Package 규격에 `plan`, 구간별 `planItemId`·`segmentId`·`passNo`·`legKind`·`mustPassCheck`(보낸 쪽 결과)·**`mustPass`(경로 방향 필수 구간·옆 도로·기준)**를 더함. Android 는 모르는 필드를 그대로 해시에 넣어 같은 값으로 검증(호환).
- **받은 패키지 재검증 (P2-1)**: `verifyPlanPackage` — 계획 연결 패키지면 구간마다 `passJudge` 로 다시 판정. 보낸 쪽 값은 "보낸 쪽 n% / 이 휴대폰 m%"로 나란히 표시. `mustPass` 가 없거나(예전 v4.3 초판) 하나라도 실패하면 "이 경로로 주행" 버튼이 없고, 적용 함수도 거부. 계획 연결이 아닌 확정 경로는 예전 그대로.

## 7. DriveResult (`format: "nav-app-drive-result"`, schemaVersion 1)

`resultId`·`sessionId`·`driveDate`·`vehicle`·`app`·`device`·`plan`·`routePackage`·`startedAt`·`endedAt`·`lastHeartbeatAt`·`endReason`(`completed`·`manual_stop`·`interrupted`·`app_restart`)·`summary`(보고값 — 참고용)·`legs[]`(`kind`·`planItemId`·`passNo`·`status`·`maxProgressPct`·`offRouteCount`)·`events[]`·`issues[]`·**`planAdjustments`**(`skippedItems[]`, `skippedDirections[{itemId, segmentId, direction, cause, attempts, coveragePct}]` — `cause`: `direction_unreachable`·`parallel_road`·`route_blocked`·`user`)·`gpsSource`·`integrity`.

## 8. Route Viewer — 결과 처리

- **받기**: 자동 가져오기·직접 불러오기 모두 같은 저장 함수. 같은 `resultId`·같은 내용은 중복(`already`), 같은 세션의 나중 결과가 앞 결과를 대체.
- **동기화 중 JSON (P3)**: 끝나지 않은 JSON 이 방금(10분 안) 바뀐 파일이면 `pending` "동기화 중 — 다음 확인 때 다시 읽음", 10분 넘게 그대로면 `failed` "JSON 이 깨졌어요 — 다시 보내 주세요". 파일이 바뀌면 다시 읽음.
- **판정**: 계획 항목마다 결과 시각 범위 GPS 원본 + 계획의 옆 도로로 `passJudge`. 수집으로 세는 방향 = 계획이 허용한 방향 − nav-app 에서 뺀 방향. 계획 방문 수 = 뺀 방향·항목을 뺀 방문. 판정 근거(`roadIndex`)를 결과마다 표시: `plan_neighbors`(nav-app 과 같은 입력) · `region`(예전 계획 — 지역 도로망에서 골라 씀, 데스크톱) · `plan_only`(옆 도로 정보 없음 — 수집이 부풀 수 있다는 경고).
- **화면**: 항목 표에 "경로 따라감(보고)"(nav-app 보고, 판정에 안 씀)과 "GPS 판정"·"통과(한 번에 80%↑)"·"시간대 수집"을 따로 둠.
- **계획별 상태 (P2-2)**: 계획 생성 ✅ → 파일로 내보냄 ✅/❔(기록 없음) → nav-app 전달 ❔("상태 확인 불가" — 결과가 그 계획을 가리키면 ✅) → 결과 수신 ✅/⏳/⚠️ → GPS 검증 ✅/⏳/⚠️. 상태 라벨: 계획 생성(전달 상태 확인 불가) · 결과 대기(전달 확인 불가) · 가져오기 실패 · 결과 수신·GPS 미검증 · GPS 품질 낮음 · GPS 검증 완료. 어느 계획 것인지 알 수 없는 실패 파일은 따로 셈. 동기화(폴더 접근) 문제는 자동 가져오기 상태("폴더에 접근할 수 없어요"), 파일 문제는 이 표.
- **추천 전후**: 같은 조건(구간·요일·시간대·조도, 방향 제외)으로 비교. 한 방향 항목인데 엔진이 반대 방향을 권하게 되면 그 부족분은 반대 방향 것이라 견주지 않음. **목록에 없다고 충족이 아님** — GPS 로 `achieved` 일 때만 `resolved`, 아니면 `unknown`(이유에 GPS 판정 수치).
- **브라우저 모드**: 같은 `passJudge` 를 쓰고, 계획에 옆 도로가 있으면 데스크톱과 같은 결과. 옆 도로가 없는 예전 계획은 계획 구간만으로 판정(화면에 경고).

## 9. 자동 · 수동 범위

자동은 **"앱이 실행 중이고 공유 파일에 접근할 수 있을 때"** 만입니다.

| 일 | 자동 | 사람이 할 일 |
|---|---|---|
| 추천 → 계획 파일 | 옆 도로·방향·예상 계산 | ☑ 고르기, 예상·부족 확인, 파일 저장·휴대폰으로 보내기 |
| 계획 열기 | 미리보기 | "이 계획 쓰기" |
| TMAP 탐색·검증 | 전 방문 탐색·검증·필요한 재시도·우회 검사·예상 | 🔎, 안 되는 방향·항목 빼기, 필요하면 재탐색, 🔒 확정 확인 |
| 받은 확정 경로 | 필수 구간 재검증 | 검증 통과 시 "이 경로로 주행" |
| 주행 기록·결과 | 세션·heartbeat·마감·저장·업로드 | 중간에 끝낼 때 🏁 |
| GPS 원본 | 기존 엑셀 업로드 | 엑셀 올리기 — 결과 파일만으로는 달성 판정 안 함 |
| RV 반영 | 60초마다 가져오기·재판정·상태·피드백 | 아니면 "결과 파일 불러오기" |

## 10. 시험

| 저장소 | 명령 | 내용 |
|---|---|---|
| nav-app | `node --test tests/*.test.js` (`collection_plan.test.js` 23개) | 공통 판정 사례 17개 숫자 일치 · Route Viewer 와 판정 코드 글자 비교 · 경로 판정 = 같은 궤적 GPS 판정 · 우회·U턴(경고/막음/유형/기준 바꾸기) · 막힌 방문 확정 거부 · 같은 조건 재호출 없음 · 방향만 빼기 → 주행 결과 `planAdjustments` · 시간대 밖 방문 예상 제외 · 받은 패키지 재검증(위조 경로·정보 없음·일반 패키지 호환) · 기존 계획·결과·세션 시험 |
| Android | `gradlew testDebugUnitTest` (`RoutePackageTest`) | 계획 연결 패키지(필수 구간 동봉)를 같은 SHA-256 으로 검증 · 끝까지 주행 |
| Route Viewer | `npm run test:loop` = `collection-loop-test.js` + `loop-integration-test.js` (`npm test` 에도 포함) | 판정 사례 17개 · nav-app 결과·패키지 수용 · 반복 상한·예상·부족 · 방향 확인 필요·피드백 제외 · 옆 도로 동봉 · 계획별 상태 흐름 · 동기화 중/깨진 JSON · 나란한 반대 차도 · 같은 구간 두 시간대 · 잡음·공백·점프 · 전후 비교 |
| 통합(TMAP 없음) | `node tests/loop-integration-test.js` (옆에 nav-app 필요, 없으면 건너뜀) | 합성 도로 세계(양방향·일방통행·분리 차도·옆길·과도한 우회)로 RV 계획 → nav-app 탐색·검증·제외·확정 → 합성 GPS(잡음·90초 공백·튐·옆길·역주행) → 결과·엑셀 → RV 가져오기(결과 먼저·중복·재시작) → 판정·상태·피드백 → 다음 계획 (26개) |

공용 시험 파일: `collection_plan_sample.json`(RV → nav-app), `pass_judge_cases.json`(RV `tools/make-pass-judge-cases.js` → nav-app), `drive_result_sample.json`(nav-app → RV), `route_package_sample.json`·`route_package_plan_sample.json`(nav-app → Android·RV). 규칙을 바꾸면 다시 만들어 상대 저장소에 복사하세요. 실제 TMAP 응답은 시험 파일로 저장하지 않습니다(TMAP 경로 보관 24시간 원칙).

## 11. 한계와 실기기·실제 TMAP 으로 확인할 것

- 방향 가능 여부는 지도로 알 수 없어 첫 계획에서는 TMAP 검증이 실패해야 알 수 있습니다(실측: 강남 평일 오전 상위 후보 8개 모두 고속·간선 반대 방향 실패, 일반 도로 10개 중 5개 확정 가능).
- 반복 예상은 30 km/h·고정 회전 시간 어림이라 실제 신호·정체와 다릅니다. TMAP 기준 예상도 TMAP 시간이며 실제 주행이 아닙니다.
- 우회·U턴 기준 숫자는 실측 몇 건(366 m 구간 3.9 km·U턴 6회 등)을 보고 정한 시작값입니다 — 현장에서 조정 필요.
- 옆 도로는 HD Map 이 있는 지역(강남·서초)만 담깁니다. 판교·시흥은 계획을 만들 HD Map 자체가 없습니다.
- 휴대폰 화면 잠금·백그라운드에서 세션 기록, 실제 차량 GPS 로 같은 판정, Drive 왕복, 차량 화면 완료 전달, 메신저 파일 열기는 실기기에서만 확인할 수 있습니다.

## 12. 실현 가능성 — 목표 수집량 · 반복 · 방향 · 대안 (2026-10-18)

### 12-1. '10회 × 6분'의 원인
추천 엔진 `src/js/recommendation.js` 의 구간 추천(`makeSegmentRecommendation`)이 편도 시간을 `max(6분, 길이÷20km/h)` 로 잡았습니다. 2 km 보다 짧은 구간은 모두 6분이 되고, 목표 60분(`targetMinutesPerCell`) · 현재 0분이면 ⌈60÷6⌉ = **10회**. 실제 강남 추천 4,906개가 모두 10회였던 이유입니다(구간 중앙값 199 m — 실제 편도는 약 36초).

### 12-2. 지금 계산식
| 값 | 출처 · 식 |
|---|---|
| 목표 조건 | 구간 · 요일 유형 · 교통 시간대 · 조도 · 방향 (`id`) |
| 목표 수집 시간 | 설정 `targetMinutesPerCell` (기본 60분) |
| 현재 인정 시간 | GPS 원본 집계(`cellStateOf` — 그 조건·방향 칸의 수집 분) |
| 부족 시간 | `max(0, 목표 − 현재)` |
| 편도 1회 | `passSec = 길이 ÷ collectionSpeedKmh`(기본 20 km/h, 설정 5~80) — 바닥값 없음 |
| 엔진 반복 제안 | `need.passes = ⌈부족 × 60 ÷ passSec⌉`, `need.plansNeeded = ⌈passes ÷ maxPassesPerPlan(20)⌉`, `need.basis`(식) |
| 계획 반복 | `min(필요, 시간대에 들어가는 횟수 = ⌊시간대 ÷ (passSec + 돌아오는 시간)⌋, 20)` |
| 예상 수집 | `계획 반복 × passSec` — **예상 필드(`estimate`)에만**, 달성량으로 저장하지 않음 |
| 속도 가정별 | 15·20·30 km/h 로 다시 계산한 예상·부족 (`estimate.speedSensitivity`) — 빨리 달리면 구간 위 머문 시간이 줄어 수집이 준다 |
| 실제 경로 기준 예상 | nav-app `cpEstimate` — TMAP 경로 시간·passJudge(한 번에 80%)로, 일부만 지나는 통과·시간대 밖 방문 제외 |

추천 점수(`score`)는 바꾸지 않았습니다.

### 12-3. 상태
| 상태 | 언제 (계획 생성 시 Route Viewer → 탐색 뒤 nav-app 이 다시 정함) |
|---|---|
| `achievable` 달성 가능 | 이번 계획으로 부족분 예상 충족 · 방향 확인됨 |
| `conditional` 조건부 가능 | 충족하지만 더 빠른 속도면 부족 · 시간대를 80% 이상 씀 · 막다른 끝(지도) · 시간대 밖 방문·일부 통과·경로 경고(탐색 뒤) |
| `shortfall` 목표 미달 예상 | 최대 방문·시간대로도 부족. `unsuitable` = 필요 방문이 한 계획 최대의 2배 초과 → 대안 확인 |
| `direction_unknown` 방향 확인 필요 | 수량은 되지만 방향이 TMAP·GPS 로 확인되지 않음 |
| `route_failed` 경로 탐색 실패 | (nav-app) 방문 중 경로 없음·검증 실패·우회 막힘 |
계획 전체가 목표에 못 미쳐도 방문을 막지 않습니다 — 상태와 부족량을 보여 주고 확정은 사람이 정합니다.

### 12-4. 대안
목표 미달·부적합 항목에 **같은 조건(요일·시간대·조도)** 의 후보를 붙입니다: 같은 도로로 바로 이어진 구간(`chain`, 함께 넣으면 한 번에 두 목표) · 2 km 안의 다른 구간(`longer`, 채울 수 있거나 필요한 주행일이 절반 이하). 대안의 수집은 **그 대안 구간의 목표로만** 셉니다. Route Viewer 는 저장 전에 "대안으로 바꿀까요?"를 묻습니다.

### 12-5. 첫 계획의 방향
HD Map 선은 이름·좌표·교차점(`startNode/endNode`, `startJunction/endJunction`)뿐이라 방향·분리 차도는 알 수 없습니다(조사 결과). 끝이 다른 도로와 이어지지 않으면 "막다른 길이거나 지도 범위 끝 — 돌아 나오기 확인 필요"만 적습니다. 방향은 nav-app TMAP 탐색으로 확인하고, 결과를 **구간·방향별**(`directionChecks`: ok · direction_unreachable · parallel_road · partial · not_on_road · tmap_error)로 기록해 주행 결과에 담거나, 확정·주행하지 않아도 `📤 탐색 결과 보내기` → `routecheck_*.json`(봉인)으로 보냅니다. Route Viewer 는 이를 받아 다음 계획에서 확인된 방향은 "TMAP 경로 확인", 안 되는 방향은 이유와 함께 뺍니다.

### 12-6. 실패 방문만 빼기
`실패한 방문만 빼기` — 경로 없음·검증 실패·우회 막힘 방문만 빼고 나머지는 그대로. 출발점이 바뀐 방문만 다시 탐색하고, 이미 통과한 방문은 다시 부르지 않습니다(방문 ID 는 계획 순서 자리로 고정). 뺀 방문과 원인은 `planAdjustments.skippedVisits` 로 Route Viewer 에 가고, Route Viewer 는 그 방문을 계획 방문 수에서 뺍니다.

### 12-7. 판단할 수 없는 것
- 실제 주행 속도·신호·정체 (속도 가정별로만 보여 줌) · 일방통행·분리 차도·진입 제한 (TMAP 탐색 전에는 확인 필요) · 막다른 끝인지 지도 범위 끝인지
- 목표 60분/칸 자체의 적절성 — 실데이터에서 한 계획으로 채울 수 있는 추천은 4,906개 중 39개. 목표 단위(구간 길이 비례 등)는 따로 정해야 할 결정입니다.
