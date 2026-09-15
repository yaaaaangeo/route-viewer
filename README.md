# Route Viewer (경로 뷰어) v3.1.2

nav-app 주행기록(.xlsx/.csv)을 **로컬 데이터베이스에 계속 쌓아두고** 달력 · 누적 지도 ·
Coverage · 통계 · GPS 리플레이로 보는 데이터 관리/분석 도구입니다.

- 버전: `package.json` 기준 **3.1.2** (화면 좌측 하단 배지 `APP_VERSION`도 v3.1.2)
- 저장소: 데스크톱 앱 = **SQLite**, 브라우저로 열면 = **IndexedDB** (화면 코드는 같은 `RouteDB` 인터페이스만 씀)

---

## 주요 기능

- **파일 불러오기는 "추가(merge)"** — 새 파일을 넣어도 기존 날짜 기록은 지워지지 않습니다.
  중복 판정 키는 `date | time | vehicle | lat(소수점 6자리) | lng(소수점 6자리)`이고,
  같은 키인데 `place/road/weather/timeOfDay/traffic/speed` 값이 다르면 "충돌"로 따로 집계합니다.
- **Import History** — 파일별 원본/추가/중복/충돌 건수, 대표 차량·거리, 불러온 사람, 충돌 상세.
- **전체 데이터 수집 현황** — 달력 맨 위 표에 KPI·제안 목표 대비 누적 주행 시간·수집 시간과 진행률.
- **달력 · 일자 요약** — 달력 칸마다 그 날의 수집·주행 시간, 날짜를 열면 운행 시간·구역·차량·주행 거리·기록 수·
  주행 시간(첫~마지막 기록)·수집 시간(GPS 실제 기록)·GPS 공백/점프.
- **누적 지도** — 전체 또는 선택한 날짜 범위 기록의 밀도 지도 + 구역별 **Coverage Map**,
  현재 지도 **PNG 캡처**(데스크톱 앱·브라우저 모드).
- **통계** — 지역별/차량별 분포.
- **설정** — 차량/지역 추가·비활성화(삭제 아님), Coverage Depth 등급 기준.
- **데이터 관리** — 날짜별/전체 삭제(삭제는 여기서만), 서버 동기화 설정.
- **백업/복구** — 병합 복구(기본) / 전체 교체 복구(주행 기록만 교체, 설정·수동 셀은 지우지 않음).

---

## 달력 — 전체 데이터 수집 현황

달력 탭 맨 위에 DB에 저장된 **전체 기간** 데이터의 누적 현황을 표로 보여줍니다(보고 있는 달·선택한 날짜와 무관).

| 구분 | 목표 Clip 수 | 목표 시간(분) | 주행 시간(분) | 수집 시간(분) | 진행률(%) |
|---|---:|---:|---:|---:|---:|
| KPI | 8,000 | 4,000 | 자동 계산 | 자동 계산 | 수집 시간 ÷ 4,000 × 100 |
| 제안 | 20,000 | 10,000 | 자동 계산 | 자동 계산 | 수집 시간 ÷ 10,000 × 100 |

- **두 가지 시간을 따로 보여줍니다.**
  - **주행 시간** — 날짜·차량별 첫 기록부터 마지막 기록까지(점심·휴식 등 GPS가 끊긴 시간 포함). "마지막 시각 − 첫 시각"
    단순 계산과 같은 값입니다(`CollectionStats.spanDurationSec`).
  - **수집 시간** — 그중 GPS가 실제로 기록된 시간(아래 규칙). **진행률은 수집 시간 기준**이며, 진행률 아래에 주행 시간
    기준 진행률을 참고로 작게 적습니다(예: "주행 기준 142.7%").

- **목표값**은 `src/js/collection-stats.js`의 `COLLECTION_TARGETS` 한 곳에서 관리합니다(표의 행도 이 목록으로 그림).
  목표 Clip 수는 현재 목표값만 표시하고, 진행률은 **수집 시간 기준**입니다.
- **수집 시간(유효 수집 시간)** 계산 규칙 — SQLite와 IndexedDB가 같은 함수(`CollectionStats.validDurationSec`)를 씁니다.
  1. 날짜별 · 차량별로 기록을 나눕니다.
  2. 차량마다 시각 순으로 정렬하고(같은 시각 기록은 하나로 봄) 연속한 두 기록의 간격을 구합니다.
  3. 간격이 0초 초과 **90초 이하**면 더하고, **90초보다 긴 간격은 GPS 공백으로 보고 뺍니다**
     (기존 품질 검사의 "GPS 공백" 기준과 같은 값). 오전 1시간 + 오후 1시간 = 2시간(마지막−처음 = 9시간이 아님).
  4. 차량별 합계를 더합니다 — 여러 차량이 같은 시간대에 수집하면 각각 따로 셉니다.
  5. 모든 날짜를 더해 초 → 분으로 바꿉니다. 표의 수집 시간은 반올림한 정수 분, 진행률은 초 단위 값으로 계산해
     소수 첫째 자리까지 표시합니다(예: 1,234분 → KPI 30.9%, 제안 12.3%).
- **중복 제외**: import 때 `date|time|vehicle|lat|lng`로 중복 제거돼 DB에 실제로 남은 기록만 씁니다. 같은 파일 재등록,
  동일 GPS 레코드, 삭제된 날짜는 들어가지 않고, 같은 차량·같은 시간대의 겹친 세션은 시각을 합쳐서 한 번만 셉니다.
  (차량 이름이 파일마다 다르게 적혀 있으면 — 예: "토레스 3호"/"토레스 3호차" — 다른 차량으로 셉니다.)
- **목표 초과**: 진행률 숫자는 100%로 자르지 않고 그대로(예: 4,500분 → 112.5%), 진행 막대 너비만 최대 100%입니다.
  데이터가 없으면 수집 시간 `0`, 진행률 `0.0%`입니다. 표 오른쪽 위에 DB의 가장 최신 기록 날짜를 "최근 데이터"로 표시합니다.
- **저장·성능**: 날짜별 유효 수집 시간은 import·삭제·백업 복원·서버 동기화 때 만들어지는 날짜 요약에
  `collectionSec`(수집)·`driveSpanSec`(주행)로 저장되고, 달력은 날짜 요약만 더합니다(원본 GPS 기록을 다시 읽지 않음).
  이 값이 없는 예전 DB는 앱을 처음 켤 때 날짜 요약을 한 번 다시 만듭니다(`summary_version` 3).
- **자동 갱신**: 앱 시작, 파일 import, 날짜/전체 삭제, 백업 복원, 서버 동기화 뒤 날짜 요약을 다시 읽을 때
  (`refreshDateIndex`) 한 번만 다시 합산합니다. 월 이동·날짜 선택으로는 다시 계산하지 않습니다.
- **달력 칸**마다 그 날짜의 `수집 N분 · 주행 N분`을, **일자 요약**(날짜 클릭)에는 주행 시간과 수집 시간을 따로
  보여줍니다(수집 시간 옆에 "공백 N분 제외").
- 참고: 이 저장소의 `주행기록/` 28개 파일(14일)을 넣으면 **주행 5,706분 · 수집 3,093분**입니다
  (진행률 KPI 77.3%·제안 30.9%, 주행 기준 참고값 KPI 142.7%·제안 57.1%). 빠진 2,613분의 대부분은 하루 1~3시간씩
  기록이 통째로 없는 구간입니다 — 30분 넘는 공백 28개가 1,919분, 10~30분 공백 25개가 478분, 90초~10분 공백은
  216분뿐입니다(주행 중 기록 간격은 대부분 10초 이하).

## 누적 지도 — 날짜 필터

- **사용법**: 누적 지도 상단의 시작일·종료일 칸에서 날짜를 고르거나 키보드로 입력합니다(예: `20260901`).
  입력이 멈추고 0.6초 뒤 자동 적용되고, **Enter** 또는 **날짜 적용** 버튼은 바로 적용합니다.
  **지난달**은 지난달 1일~말일, **날짜 초기화**는 날짜 조건을 지우고 전체 기간으로 되돌립니다.
- **표시 기간** 라벨: `표시 기간: 전체 기간` · `표시 기간: 2026-09-01` · `표시 기간: 2026-09-01 ~ 2026-09-05` ·
  `표시 기간: 2026-09-03 ~ (최신)` · `표시 기간: (처음) ~ 2026-09-03`
- 범위는 **시작일과 종료일을 모두 포함**합니다. 시작일만 → 시작일부터 최신까지, 종료일만 → 처음부터 종료일까지.
  날짜 조건이 걸리면 `날짜미상` 기록은 빠집니다. 시작일이 종료일보다 늦으면 서로 바꿔 적용하고 안내하며,
  연·월·일을 끝까지 입력하지 않은 칸은 적용하지 않고 안내합니다. 같은 범위를 다시 적용하면 아무것도 다시
  계산하지 않습니다.
- **같은 날짜 범위가 적용되는 곳**
  - 밀도 지도: 지도 Cell, Cell별 기록 수와 색·크기, 누적 일수, 총 기록 지점, 구역별/차량별 기록 수, 지도 화면 맞춤, 호버 툴팁
  - Coverage Map: 실제 GPS 방문 Cell, GPS 구간 보간으로 방문 처리된 Cell, 방문 횟수, 방문/미방문 판정, 빨간 미방문 칸,
    Coverage %, 전체/방문/미방문 Cell 수, Coverage Depth
  - 조회 조건은 SQLite(`_filterSql`, `getCellVisitCounts`)와 IndexedDB(`matches`)가 같습니다:
    `date >= 시작일 AND date <= 종료일`, `YYYY-MM-DD` 형식 날짜만.
- **"날짜를 바꿔도 전체 기간이 그대로" 보이던 원인**(수정됨): ① 날짜칸에 `max`가 없어 Chromium이 연도를 6자리까지
  받았습니다 — 키보드로 `20260901`을 치면 연도가 202609가 되고 월·일이 비어 값이 `''`로 남아 필터가 적용되지 않았습니다.
  지금은 `min="2000-01-01" max="2099-12-31"`로 연도를 4자리로 제한합니다. ② 날짜칸 `change`가 입력 도중에도(24일을
  치면 "2"에서 2일로) 와서 그때마다 다시 계산하는 사이 이어 치던 숫자가 엉뚱하게 들어갔습니다 — 지금은 debounce.
  ③ 시작일만 걸면 `날짜미상` 기록이 섞였습니다. ④ 브라우저(IndexedDB) 모드는 3.1.2 초기까지 날짜 조건을 무시했습니다
  (커밋 3ce67f5에서 수정).

## 📷 현재 지도 캡처

- 누적 지도 상단 **📷 현재 지도 캡처**를 누르면 지금 보이는 지도가 PNG로 저장됩니다.

| | 데스크톱 앱 (Electron) | 브라우저 모드 (`node server.js` → `/src/index.html`) |
|---|---|---|
| 방식 | 메인 프로세스가 `webContents.capturePage(지도 영역)` | 화면에서 배경 타일 `<img>` + Leaflet Canvas Layer를 캔버스에 합성 → `toBlob` |
| 저장 | 저장 대화상자(기본 위치: 사진 폴더) | 파일 저장 창(`showSaveFilePicker`, Chrome/Edge)으로 위치·이름 선택 — 지원하지 않거나 띄울 수 없으면 브라우저 다운로드 폴더 |
| 창보다 큰 지도 | 보이는 부분만(안내) | 지도 전체 |

- **데스크톱 방식**: 화면이 지도 DOM의 화면 좌표와 기본 파일명을 IPC(`routeAPI.captureMap`)로 넘기면 메인 프로세스가
  `webContents.capturePage(지도 영역)` → PNG 변환 → 저장 대화상자 → 파일 쓰기를 합니다. 화면에 실제로 그려진 픽셀을
  찍으므로 CORS나 Canvas Layer 누락 문제가 없습니다. 화면 코드는 파일 경로를 직접 다루지 않고, preload에는
  `captureMap` 하나만 추가됐습니다.
- **브라우저 방식**: `html2canvas` 같은 DOM 복제 대신 Leaflet이 이미 그려 둔 것만 합친다 —
  ① 줌 단계별 타일 묶음을 z-index 순서로(이전 줌 단계의 확대된 타일이 위에 겹치지 않게), 화면과 같은 CSS filter
  (`.leaflet-tile-pane`의 흑백·밝기)를 걸어서 ② 그 위에 Leaflet Canvas Layer(`preferCanvas` — 칸·원·경계선 전부)
  ③ 지도 저작권 표시를 글자로. 화면 배율(`devicePixelRatio`)만큼 선명하게 만듭니다.
  - 배경 타일(`tile.openstreetmap.org`)은 `Access-Control-Allow-Origin: *`를 보내므로 누적 지도 타일을
    `crossOrigin:'anonymous'`로 받아 캔버스가 오염되지 않습니다. 타일 서버를 CORS를 허용하지 않는 곳으로 바꾸면
    "CORS를 허용하지 않아 이미지를 만들 수 없어요" 오류가 납니다.

#### 배경 타일 서버 — 왜 OSM 이고, 왜 User-Agent 를 바꾸나

OSM 공식 타일 서버는 자원봉사가 운영해서 [타일 사용 정책](https://operations.osmfoundation.org/policies/tiles/)이
**앱을 식별할 수 있는 User-Agent** 를 요구합니다. Electron 기본 UA 로 요청하면 타일 대신 "Access blocked" 403
이미지가 오고(응답에 `x-blocked: Access denied` 헤더) 지도가 노란 빗금으로 덮입니다. 그래서 데스크톱 앱은
`electron/osm-tile-ua.js` 의 `applyOsmTileUserAgent()` 로 **타일 요청에만** UA 를 바꿔서 보냅니다
(Overpass 등 다른 요청은 건드리지 않습니다).

**브라우저 모드는 브라우저가 OSM 에 직접 가지 않습니다.** `server.js` 가 `/tiles/z/x/y.png` 로 타일을 대신 받아
주는 프록시를 둡니다 — 앱 식별 UA 로 OSM 에 요청하고, 받은 타일은 `tile-cache/`(git 제외)에 7일간 캐시합니다.
브라우저가 직접 받던 때에는 **새 프로필 Edge 는 통과하는데 사용자 PC 의 Edge 는 "Access blocked"** 를 받는 일이
있었고, 그 차이(프로필·캐시·Referer 등)는 밖에서 관찰도 수정도 할 수 없었습니다. 프록시를 거치면 브라우저 상태와
무관해집니다. OSM 이 거절하면(`x-blocked` 헤더 · 4xx/5xx · 이미지 아닌 응답) 캐시하지 않고 502 를 주며 서버 창에
`[tiles] OSM 이 타일 z/x/y 를 거절: …` 로그를 남깁니다(10초에 한 줄로 묶음). 예전에 받아 둔 타일이 있으면 오래됐어도
그걸 줍니다. 프록시가 못 준 칸만 화면이 OSM 에서 직접 받아 봅니다.

실측값(강남 z14 타일): 차단 이미지 **6,987바이트** / 정상 타일 **43,121바이트**.

- 지도가 노란 빗금 + "Access blocked" 로 덮이면 → 데스크톱은 UA 주입이 빠진 것, 브라우저 모드는 서버 창의
  `[tiles]` 로그부터 봅니다(로그가 없으면 화면이 `/tiles` 를 쓰지 않는 것 — 서버 없이 연 경우 등).
- 타일에 **"API KEY REQUIRED"** 워터마크가 찍히면 → 키가 필요한 상용 타일(CARTO 등)로 바뀐 것입니다.
- **둘 다 HTTP 200 으로 옵니다.** 상태 코드만 확인해서는 절대 못 잡고, 타일 그림을 직접 봐야 압니다
  (실제로 겪은 회귀: 200 만 보고 CARTO 로 바꿨다가 지도 전체에 워터마크가 찍혔습니다).
  - `ctx.filter`를 지원하지 않는 브라우저(Safari)에서는 배경 지도가 흑백 필터 없이 원본 색으로 저장됩니다.
- **포함**: 지금 중심·줌·범위, 선택 구역, 날짜 범위, 밀도 지도 또는 Coverage Map(방문/미방문 칸, 적용 완료된 수동
  방문·미방문·제외 상태), 구역 경계, 배경 지도 타일, 지도 저작권 표시.
- **제외**(캡처하는 동안만 숨기고 끝나면 `finally`에서 되돌림): 적용 전 선택(pending) 미리보기, 확대/축소 버튼,
  호버 툴팁, 로딩 표시, 경계 꼭짓점 핸들. 날짜 입력칸·편집 버튼은 지도 영역 밖이라 들어가지 않습니다.
- **파일명**: `RouteViewer_<구역>_<기간>_<모드>_<YYYYMMDD_HHMMSS>.png`
  - 기간: `전체기간` · `20260901` · `20260901-20260905` · `20260901부터` · `20260905까지`
  - 모드: `Density` · `Coverage` · `CoverageDepth`
  - 예: `RouteViewer_강남_전체기간_Coverage_20260911_142530.png`. 파일명에 쓸 수 없는 문자는 지웁니다.
- **상태 처리**: 지도를 그리는 중(날짜를 바꾼 직후 포함)에는 버튼이 비활성이라 이전 지도를 찍지 않습니다. 캡처 직전
  `invalidateSize()`를 하고 줌/이동 애니메이션과 배경 타일 로딩이 끝나기를 최대 8초 기다립니다(그래도 로딩 중이면
  저장 후 안내). 지도가 스크롤 아래에 걸쳐 있으면 잠시 화면 안으로 스크롤했다가 되돌립니다(창보다 큰 지도는 보이는
  부분만 저장하고 안내). 중복 클릭은 무시하고, 저장 취소는 오류로 표시하지 않으며, 저장 실패는 오류 메시지로 알립니다.
- 캔버스 PNG를 만들 수 없는 아주 오래된 브라우저에서만 버튼이 비활성이고 안내만 합니다.
- 인터넷이 끊겨 배경 타일을 못 받으면 캡처에도 타일이 비어 있습니다(지도에 보이는 그대로 저장).

---

## Coverage Map

### 판정 규칙

- **Coverage Cell 크기: 20m 고정.** 화면(`src/js/accum.js`의 `GAP_CELL_SIZE_M`), SQLite, IndexedDB가 모두
  `src/js/coverage-grid.js`의 `DEFAULT_CELL_SIZE_M = 20` 하나를 기준으로 씁니다. 사용자 설정값이 아닙니다 —
  설정(`getSettings()`)의 `coverageCellSizeM`은 항상 20을 돌려주고, 예전 버전이 50을 저장해 뒀어도 무시하며,
  `setSettings()`는 이 값을 저장하지 않습니다.
- **유효 Cell** = 구역 경계(직접 그린 polygon) 안 + 주행 도로 칸 − (아파트 단지 ∪ 주차장 ∪ 건물 mask) − 수동 제외 칸.
  - 도로: 강남(및 사용자가 만든 "서초")은 `src/data/hdmap_*_roads.js`의 HD map, 그 외 구역은 OSM Overpass에서
    주행 도로(`highway` whitelist)를 받아 씁니다. 끊긴 도로 끝점은 자동 연결(gap healing)합니다.
  - 건물/아파트/주차장: Overpass에서 구역 bbox만 받아 `localStorage`에 캐시합니다.
- **방문 횟수**: 같은 `(date, vehicle)` 안에서 시간순으로 이어진 두 GPS 점 사이 이동 경로가 지나간 칸을 모두
  방문으로 셉니다(`CoverageGrid.accumulatePartitionVisits`, SQLite·IndexedDB 공용). 같은 칸에 연속으로 찍힌 점은
  방문 1회, 칸을 벗어났다 돌아오면 새 방문입니다. 시간차 30초 초과 또는 150km/h 초과면 사이를 잇지 않습니다.
- **Coverage % = 방문 Cell / 유효 Cell.** Coverage Depth는 방문 횟수를 등급(기본 미수집 0 / 부족 1 / 보통 2~4 /
  충분 5+)으로 나눠 보여줍니다.

### 수동 셀 편집 (⚙️ 패널)

| 버튼 | 의미 |
|---|---|
| 🗑️ 제외 셀 선택 | 이 칸은 도로가 아님 → Coverage 대상(유효 Cell)에서 뺌 |
| ✅ 방문 셀 선택 | 이 칸은 방문한 것으로 침 → 방문 횟수 최소 1 |
| 🔴 미방문 셀 선택 | GPS가 지나갔거나 실수로 방문 처리된 칸을 미방문으로 침 → 방문 횟수 0 (빨간 칸, Depth "미수집") |
| 선택 적용 (N) | **이번에 찍은 칸(N개)만** 저장하고 그 구역 Coverage만 다시 계산 |
| 현재 구역 선택 초기화 | **아직 적용하지 않은 이번 선택(미리보기)만** 지움 |

- 상태는 두 층으로 나뉩니다.
  - **확정 상태** — DB에 저장된 `{excluded, visited, unvisited}`. 칸을 클릭해도 바뀌지 않습니다.
  - **현재 선택(pending)** — `cellKey → {lat, lng, targetState}` (`targetState`: `exclude | visited | unvisited | none`).
    지도에는 확정 상태 위에 미리보기로 겹쳐 그립니다.
- 칸 클릭은 pending만 토글합니다. 같은 모드로 다시 누르면 취소되고, 이미 그 상태로 확정된 칸을 누르면
  "해제 예정(none)"이 됩니다. 클릭 자체는 DB에 저장하지 않습니다.
- **선택 적용**: pending이 비어 있으면 아무것도 안 함 → 확정 상태 복사본에 pending만 병합 → 한 칸이 여러 상태에
  들어가지 않게 정규화 → **DB 저장 1회** → 저장 성공 후에만 확정 상태 교체 → pending 비움 → 편집 모드 종료 →
  그 구역 캐시만 무효화 후 재계산. **저장이 실패하면** 확정 상태와 pending을 그대로 두고 오류를 보여주며, 다시
  적용할 수 있습니다.
- **현재 구역 선택 초기화**: pending과 미리보기만 지웁니다. DB 저장·확정 상태 변경·Coverage 재계산을 하지 않고,
  과거에 적용한 제외/방문/미방문 칸은 그대로 남습니다. (확정된 수동 설정을 전부 지우는 버튼은 없습니다.)
- **수동 상태 우선순위** — 한 칸은 셋 중 하나의 수동 상태만 가집니다.

  ```
  excluded  → Coverage 대상에서 제외 (가장 먼저)
  unvisited → 유효 셀, 방문 0회 (실제 GPS 기록은 지우지 않음)
  visited   → 유효 셀, 방문 max(1, 실제)
  (없음)    → 실제 GPS 방문 횟수
  ```

### Coverage 캐시 · 탭 전환

- 다른 탭에 갔다가 누적 지도로 돌아오면, 그사이 바뀐 게 없는 한 **다시 계산하지도 다시 그리지도 않습니다** —
  기존 지도와 Layer를 그대로 두고 `accumMap.invalidateSize()`와 버튼/안내 문구만 갱신합니다(`enterAccumView()`).
- 캐시는 두 층입니다.
  - **정적 Geometry**(날짜와 무관): 구역 polygon 안의 도로 칸, gap healing, 건물·아파트·주차장 제외.
    키 = 구역, 경계 polygon 해시, Cell 크기, 경계/지도 데이터 revision.
  - **동적 결과**(날짜별): 방문 횟수, 방문/미방문 판정, 수동 셀 반영. 키 = 구역, **정규화된 시작일·종료일**, 경계
    polygon 해시, 데이터 revision, 수동 셀 revision, Cell 크기, Coverage 설정 revision.
    그래서 "전체 기간"과 "2026-09-01 ~ 2026-09-05"는 서로 다른 캐시이고, 날짜를 바꾸면 방문 집계만 새로 하고
    Geometry는 재사용합니다. 이전에 본 날짜 범위로 돌아가면 캐시를 그대로 씁니다.
  - Coverage %·Cell 수·Depth 분포와 지도 색은 동적 결과로부터 계산하며, Depth·디버그 보기 전환은 다시 그리기만 합니다.
- **무효화(재계산) 조건**
  - 모든 구역: 주행기록 import, 날짜/전체 삭제, 백업 복원, 서버 동기화, Coverage 설정(`setSettings`) 변경
  - 해당 구역만: 수동 셀 "선택 적용", 구역 경계 추가·수정(꼭짓점 드래그)·삭제
  - 키가 달라져서 새로 계산: 선택 구역 변경, 날짜 필터 변경(방문 집계만 — Geometry 재사용, 같은 범위 재적용은 무시)
  - 날짜를 바꾸는 동안 이전 범위로 진행 중이던 계산은 `accumRenderToken`으로 버려져 새 결과를 덮지 않습니다.
  - 도로/건물 데이터를 못 받아 대체값(예전 캐시/빈 목록)으로 계산한 결과는 "임시"로만 두고, 다음에 탭으로
    들어올 때 다시 받아서 계산합니다.
- 저장소 쪽 변경은 `RouteDB.onChange()` 알림으로 전달되고(서버 동기화는 `sync.js`가 `RouteDB.notifyChange('sync')`),
  늦게 끝난 비동기 계산은 `accumRenderToken` 확인 후에만 지도에 그려서 최신 화면을 덮지 않습니다.

### 저장 형식 · 호환성

| | 위치 | 형식 |
|---|---|---|
| SQLite | `zones.manual_cells` (TEXT, JSON) | `{"excluded":[[lat,lng],...],"visited":[...],"unvisited":[...]}` |
| IndexedDB | `zones` 스토어 행의 `manualCells` | 같은 객체 |

- 칸은 gy/gx가 아니라 **칸 중심 위경도**로 저장하고, 매번 그 시점 격자로 다시 칸을 계산합니다.
- `getZoneManualCells()`는 두 저장소 모두 항상 세 배열을 돌려줍니다. `unvisited`가 없는 **구버전 데이터**
  (`excluded`/`visited`만)는 별도 DB 마이그레이션 없이 `unvisited: []`로 읽힙니다. 깨진 값은 빈 목록으로 처리합니다.
- **백업**: `zones[].manualCells`로 함께 저장됩니다(SQLite `listZones()`도 이제 포함).
- **복원**: 병합/전체 교체 모두 수동 셀은 **칸 단위 병합** — 백업에 있는 칸은 백업 상태로, 백업에 없는 지금 칸은
  유지. `manualCells`가 없는 옛 백업은 수동 셀을 건드리지 않습니다.
- **서버 동기화**: `server.js`가 구역을 이름 기준으로 병합할 때 `manualCells`도 칸 단위 병합하고, `manualCells`를
  보내지 않는 구버전 기기가 기존 값을 지우지 못하게 합니다. 받아온 쪽은 위의 복원 규칙으로 저장합니다.

---

## 설치 파일

`npm run dist`(electron-builder)가 `release/`에 만듭니다. `package.json` 설정상 파일명 규칙:

| 대상 | 파일명 규칙 |
|---|---|
| NSIS 설치 프로그램 (x64 + ia32) | `RouteViewer-${version}-${os}-${arch}.exe` |
| 포터블 (x64 + ia32) | `RouteViewer-portable-${version}-${arch}.exe` |

이번 작업에서는 `npm run dist`를 실행하지 않았습니다. 지금 `release/`에 들어 있는 마지막 산출물은 3.1.1
(`RouteViewer-3.1.1-win-x64.exe`, `RouteViewer-portable-3.1.1.exe` 등)입니다.
데이터는 `%APPDATA%\Route Viewer\database\route-viewer.db`에 따로 저장되므로 앱을 다시 설치해도 남습니다.

---

## 실행 · 빌드 · 테스트

Node.js가 없으면 `tools/setup-node.ps1`이 프로젝트 안 `tooling/`에 포터블 Node를 받습니다.

```powershell
powershell -ExecutionPolicy Bypass -File tools\setup-node.ps1
$env:Path = "$PWD\tooling\node-v24.19.0-win-x64;" + $env:Path

npm install
npm start          # 데스크톱 앱 개발 실행 (SQLite)
npm test           # 단위/통합 테스트 (아래 표의 npm test 항목 전부)
npm run pack       # release/win-unpacked 만 생성
npm run dist       # release/ 에 설치 파일 + 포터블 생성
node server.js     # 브라우저 모드(IndexedDB) + 서버 동기화 서버 → http://localhost:8080/src/index.html
npm run test:browser-capture   # 브라우저 모드 지도 캡처 E2E (Electron 창을 브라우저로 사용, 인터넷 필요)
```

브라우저 모드는 저장소 루트의 **`브라우저로 열기.bat` 을 더블클릭**해도 됩니다 — 서버를 띄우고 포트가 열릴 때까지
기다렸다가 브라우저를 엽니다. 서버가 이미 떠 있으면 브라우저만 엽니다. 서버 설정(`HOST` 등)은 바꾸지 않고
접속 주소만 `127.0.0.1` 을 씁니다.

> `src\index.html` 을 탐색기에서 더블클릭해 `file://` 로 열면 서버를 거치지 않으므로 타일 프록시·서버 동기화를 쓰지
> 못하고, 타일을 브라우저가 OSM 에서 직접 받습니다 — 그 브라우저 상태에 따라 차단될 수 있습니다. 브라우저 모드는
> 런처로 여세요. (예전 README 에 "file:// 은 Referer 가 없어 원리적으로 차단된다"고 적었던 것은 curl 로 헤더를 흉내 낸
> 측정에서 나온 틀린 결론이었습니다 — 실제 Edge 는 file:// 에서도 통과했습니다.)

### 테스트

| 명령 / 파일 | 내용 | 개수 |
|---|---|---|
| `npm test` → `tests/run-tests.js` | `주행기록/` 실제 엑셀로 SQLite 계층: 누적 import·중복·충돌·백업·설정·삭제 | 102 |
| `tests/coverage-grid-test.js` | GPS 사이 이동 경로 칸 계산(20m 격자) | 12 |
| `tests/coverage-gap-healing-test.js` | 도로 gap healing · 아파트/주차장 제외 · 수동 제외/방문 | 24 |
| `tests/apartment-shinhyundai-test.js` | 신현대아파트 단지 제외 | 10 |
| `tests/apartment-eunma-test.js` | 은마아파트 단지 제외 | 6 |
| `tests/hdmap-data-test.js` | 강남/서초 HD map 데이터 | 25 |
| `tests/manual-cells-storage-test.js` | 수동 셀 저장 형식·구버전 호환·백업/복원·20m 기준·날짜 필터 — **SQLite ↔ IndexedDB 동등성** | 30 |
| `tests/coverage-manual-cells-test.js` | 현재 선택/확정 분리·선택 초기화·선택 적용·저장 실패·미방문·Coverage 캐시/무효화·늦은 비동기 결과 | 82 |
| `tests/accum-date-filter-test.js` | 날짜 범위별 밀도 지도·통계·Coverage 방문/%/Depth, 날짜 캐시 키·Geometry 재사용·debounce·늦은 결과 차단, SQLite↔IndexedDB 동등성 | 50 |
| `tests/map-capture-test.js` | 캡처 파일명·영역 계산, 버튼 활성 조건·IPC 요청·취소/실패·중복 클릭·pending 제외·UI 복원·날짜 변경 직후, 브라우저 모드 합성(타일 z-index 순서·페이드 투명도·CSS filter·다운로드/저장 창·CORS 오류) | 51 |
| `tests/collection-progress-test.js` | 수집 시간 규칙(90초 공백·차량/날짜 합산·중복)과 주행 시간(첫~마지막 기록), 진행률·목표 초과·주행 기준 참고값, 재등록·삭제·복원·동기화·재시작·요약 마이그레이션, SQLite↔IndexedDB(실제 `core.js` 요약 함수) 동등성, 실제 주행기록의 주행 시간 = 단순 계산 합, 달력 표·달력 칸·일자 요약·월 이동 시 재계산 없음 — 입력·기대·실제값 출력 | 55 |
| `tests/tile-proxy-test.js` | `server.js` 타일 프록시 — 가짜 OSM 서버로: 앱 식별 UA·서브도메인, MISS→HIT 캐시, 동시 요청 1회로 합침, 차단 이미지(200+`x-blocked`)·403 → 502·캐시 안 함·거절 로그, 차단 시 오래된 캐시(STALE), 잘못된 좌표·경로 404 (인터넷 불필요) | 15 |
| `npm run test:browser-capture` → `tests/browser-capture-e2e.js` | 실제 브라우저 모드(`server.js` + IndexedDB, preload 없는 창) — 달력 수집 현황 표, 화면 타일이 `/tiles` 프록시로 오고 차단 이미지가 아님(픽셀), 지도 캡처 → 다운로드된 PNG 크기·타일·흑백 필터·밀도 원·빨간 칸 픽셀 검사 (인터넷 필요) | 16 |
| `node tests/server-sync-test.js` | `server.js` 공유 저장 병합(수동 셀 병합 포함) — 포트 8099로 서버를 띄움 | 25 |
| E2E (`tests/e2e-driver.js`) | 실제 Electron 창을 띄워 화면 조작 — 달력 수집 현황 표(날짜 삭제 후 갱신), 날짜 키보드 입력, 실제 `capturePage` PNG 저장(Coverage·Density, 픽셀 검사) 포함 | 133 |

`npm test` 합계 462개(12개 파일). 최근 실행: 브라우저 모드 E2E 16/16 통과, 데스크톱 E2E 132개 통과·1개 실패
(건물 데이터를 못 받은 날에는 탭 복귀 재사용 검사 1개를 설계상 건너뜀) —
실패 1건은 아래 알려진 이슈의 "지역별 Coverage 요약 패널"이며, Overpass 경고가 콘솔 에러로 집계돼 종료 코드는 1입니다. `tests/manual-cells-storage-test.js`는 브라우저 IndexedDB 백엔드를
`tests/helpers/fake-indexeddb.js`(테스트 전용 최소 구현)로 Node에서 실행하고,
`tests/coverage-manual-cells-test.js`는 실제 `accum.js`/`storage.js`를 vm으로 로드해 SQLite로 돌립니다
(지도·DOM만 가짜, `tests/helpers/accum-harness.js`).

E2E 실행(`tools/e2e.ps1`은 다른 PC 경로가 하드코딩돼 있어 그대로는 안 됩니다 — 알려진 이슈 참고):

```powershell
$env:ROUTE_VIEWER_E2E = "$PWD\tests\e2e-driver.js"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& .\node_modules\electron\dist\electron.exe . --user-data-dir="$env:TEMP\rv-e2e"
```

---

## 폴더 구조

```
route-viewer/
├─ electron/
│   ├─ main.js          앱 창 · 메뉴 · IPC · 서버 동기화 · 자동 업데이트(electron-updater)
│   ├─ preload.js       화면에 노출하는 API (window.routeAPI)
│   └─ database.js      SQLite 스키마 · import/merge/중복제거 · 집계 · 백업/복원
├─ src/
│   ├─ index.html
│   ├─ data/            강남/서초 HD map 도로 (window.HDMAP_*_ROADS)
│   └─ js/
│       ├─ coverage-grid.js 방문 칸 계산 · 수동 셀 형식/병합 · Cell 크기 (SQLite·브라우저·서버 공용)
│       ├─ map-capture.js   지도 캡처 파일명 · 캡처 영역 계산 (화면·메인 프로세스 공용)
│       ├─ collection-stats.js 유효 수집 시간 · 수집 목표(COLLECTION_TARGETS) · 진행률 (SQLite·브라우저 공용)
│       ├─ storage.js       저장소 파사드 RouteDB (SQLite ↔ IndexedDB) + 변경 알림
│       ├─ accum.js         누적 지도 · 구역 경계 · Coverage 계산/캐시 · 수동 셀 편집
│       ├─ app.js           탭 전환 · 시작 절차
│       └─ …                parser/core/quality/ui/auth/calendar/statistics/replay/importer/backup/sync/datamanager/settings
├─ tests/                자동 테스트 (helpers/ = 테스트 전용 도구)
├─ tools/                빌드 보조 스크립트
├─ server.js             브라우저 모드 정적 서버 + 공유 저장(동기화) + /updates
└─ route-viewer.html     v2 단일 파일 버전 (참고용)
```

---

## 알려진 이슈

- **`release/win-unpacked`의 패키지 앱은 3.1.1**이라 날짜 필터·지도 캡처가 들어 있지 않습니다(그 `app.asar`에는
  날짜 입력칸과 `fromDate` 조건이 없음). 3.1.2 설치 파일은 이번에 빌드하지 않았습니다 — `npm run dist`가 필요합니다.
- 데스크톱 앱의 지도 캡처는 창보다 큰 지도면 보이는 부분만 저장됩니다(브라우저 모드는 지도 전체).
  브라우저 모드 캡처는 배경 타일 서버의 CORS 허용(현재 OSM은 허용)에 기대고, Safari에서는 타일 흑백 필터가 빠집니다.
- **지역별 Coverage 요약 패널이 비어 있습니다.** `index.html`에 `#coverage-summary` 자리가 있고 E2E도 이 요약을
  확인하지만, 현재 코드에는 이 영역을 채우는 함수가 없습니다(선택한 한 구역의 상세 패널 `#coverage-detail`만 동작).
  그래서 E2E의 "요약에 강남 Coverage %가 표시된다" 1건은 이번 변경 전 코드에서도 실패합니다.
- **건물 데이터(Overpass) 대기가 길 수 있습니다.** 미러 4곳을 순서대로 각 15초 제한으로 시도해서, 미러가 응답하지
  않으면 첫 Coverage 계산이 수십 초 걸립니다(이번 점검 중 `overpass-api.de`는 HTTP 406을 반환). 이 경고가 E2E의
  "화면 콘솔 에러"로 집계돼 E2E 종료 코드가 1이 됩니다.
- **동기화로는 "지우기"가 전파되지 않습니다.** 수동 셀·구역 경계는 병합만 하므로, 한 기기에서 해제한 칸이 다른
  기기/서버에 남아 있으면 다음 동기화 때 다시 돌아옵니다.
- `tools/e2e.ps1`에 다른 PC의 경로(`c:\Users\User\Downloads\...`)가 하드코딩돼 있습니다.
- `release/`, `node_modules/`, `tooling/`이 `.gitignore`에 있어도 이미 Git에 추적되고 있고, `주행기록/`·`백업/`의
  실제 GPS 기록도 커밋돼 있습니다(`.gitignore`에서 주석 처리됨). 정리 방법은 아래 보안 주의사항 참고.

---

## 서버 동기화 보안 주의사항

`server.js`는 **신뢰할 수 있는 내부망 전용** 도구로 만들어져 있습니다. 현재 동작:

- 기본 `HOST`가 `0.0.0.0`이라 같은 네트워크의 모든 기기에서 접속됩니다.
- `GET /api/route-data`는 **인증이 없습니다** — 서버에 모인 모든 GPS 기록·구역·설정을 누구나 받을 수 있습니다.
- `ROUTE_VIEWER_WRITE_TOKEN`을 설정하지 않으면 **누구나 PUT으로 데이터를 넣을 수 있고**, 그 데이터는 동기화하는
  모든 데스크톱 앱에 병합됩니다.
- 정적 파일 핸들러가 프로젝트 폴더 전체를 내려주므로, 이 폴더에서 서버를 띄우면 `/.git/…`, `/백업/*.json`,
  `/주행기록/*.xlsx` 같은 파일도 그대로 다운로드됩니다.
- 자동 업데이트는 입력한 서버 주소(`<주소>/updates`, 보통 `http://`)에서 받으며, 설치 파일에 코드 서명이 없습니다
  (`signAndEditExecutable: false`). 같은 네트워크의 공격자가 업데이트 파일을 바꿔치기할 수 있습니다.

권장: `HOST=127.0.0.1` 또는 방화벽으로 접근 제한, `ROUTE_VIEWER_WRITE_TOKEN` 필수 설정, 가능하면 HTTPS 리버스
프록시 뒤에서 운영하고, 개인 데이터가 없는 별도 폴더에서 서버를 실행하세요.
