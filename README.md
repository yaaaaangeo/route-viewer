# Route Viewer (경로 뷰어) v3

nav-app 주행기록(.xlsx/.csv)을 **로컬 데이터베이스에 계속 쌓아두고** 달력 · 누적 지도 ·
통계 · GPS 리플레이로 보는 데이터 관리/분석 도구입니다.

---

## v3.1 — 데이터 관리/분석 도구로 확장

파일을 불러올 때마다 중복/충돌을 검사하고, 얼마나 새로 추가됐는지 정확히 보여주고,
지역별 Coverage를 %로 확인할 수 있습니다. 차량/지역은 더 이상 코드에 하드코딩돼
있지 않고 [설정] 탭에서 추가/관리합니다.

- **값 충돌 검사** — 같은 GPS record인데 값이 다르면(예: speed) "중복"과 구분해서
  "충돌"로 따로 집계하고, 어떤 필드가 어떻게 달랐는지 [중복 상세]에서 볼 수 있습니다.
- **Import History 강화** — 어떤 파일을 언제 누가 불러왔는지, 원본/추가/중복/충돌
  건수와 대표 차량·거리까지 [데이터 관리] 탭에 남습니다.
- **Coverage %** — 그동안 그려온 "빨간 칸 = 미방문"을 숫자로도 보여줍니다.
  지역별 Coverage %, 전체/방문/미방문 Cell 수를 누적 지도에서 바로 확인합니다.
- **Coverage Depth** — 각 Cell을 몇 번 "방문 세션"으로 지나갔는지 등급(미수집/부족/
  보통/충분)으로 나눠서 봅니다. 연속으로 찍힌 GPS는 방문 1회로 묶습니다.
- **설정 탭** — 차량/지역을 UI에서 추가하고 비활성화합니다(삭제 아님 — 과거 기록은
  그대로 남습니다). 추가하면 누적 지도·통계·Coverage·파일 불러오기에 바로 나타납니다.
- **일자 요약 강화** — 달력에서 날짜를 열면 운행 시간·구역·차량뿐 아니라 **주행
  거리·기록 수·주행 시간·GPS 공백·GPS 점프**까지 한 번에 보입니다(v3.1.1 — 별도
  "비교" 탭으로 시작했다가, 날짜 하나를 볼 때 바로 보이는 게 더 유용해서 통합했습니다).

자세한 사용법은 [SHARED_STORAGE.md](SHARED_STORAGE.md)를, 구현 배경은 이 문서 하단의
"v3.1 구현 노트"를 참고하세요.

## v3.0에서 바뀐 것

### 1. 파일 불러오기가 "교체"가 아니라 "추가"가 됐습니다 ★

예전에는 새 파일을 넣을 때마다 기존 데이터가 초기화됐습니다.

```
8/23 불러오기 → 8/23만 보임
8/24 불러오기 → 8/23이 사라지고 8/24만 보임   ← 버그
```

이제는 이렇게 동작합니다.

```
8/23.xlsx → DB ├─ 2026-08-23
8/24.xlsx → DB ├─ 2026-08-23
                └─ 2026-08-24
8/25.xlsx → DB ├─ 2026-08-23
                ├─ 2026-08-24
                └─ 2026-08-25
```

**기존 날짜의 데이터는 [데이터 관리] 탭에서 직접 지우지 않는 한 절대 사라지지 않습니다.**

### 2. 중복은 자동으로 걸러집니다

같은 파일을 실수로 두 번 넣어도 GPS 포인트가 2배가 되지 않습니다.
레코드 하나하나를 아래 값으로 구분합니다.

```
date | time | vehicle | latitude(소수점 6자리) | longitude(소수점 6자리)
```

같은 날짜라도 GPS 기록이 다르면(오전 주행 / 오후 주행) 모두 합쳐지고,
합쳐진 뒤에는 시간순으로 정렬됩니다.

### 3. 저장소가 SQLite / IndexedDB 로 바뀌었습니다

| 실행 방법 | 저장소 | 위치 |
|---|---|---|
| 데스크톱 앱 (권장) | **SQLite** | `%APPDATA%\Route Viewer\database\route-viewer.db` |
| 브라우저 (`node server.js`) | IndexedDB | 그 브라우저 프로필 안 |

예전처럼 `localStorage`에 전체 GPS 데이터를 JSON 한 덩어리로 넣지 않습니다.
(용량 한계 약 5MB에 금방 걸려서 수십만 포인트를 감당할 수 없었습니다.)

달력 · 누적 지도 · 통계는 전체 포인트를 화면으로 끌어오지 않고
**DB에서 집계(GROUP BY)한 결과만** 받아 그립니다. 데이터가 몇 년치 쌓여도
화면 여는 속도가 느려지지 않습니다.

> 예전 버전에서 `localStorage`에 쌓아둔 기록이 있으면 앱을 처음 열 때 자동으로 옮겨옵니다.

### 4. 설치형 데스크톱 앱

바탕화면 아이콘을 더블클릭해서 실행합니다. Chrome 주소창이나 HTML 파일을 찾을 필요가 없습니다.

### 5. 데이터 관리 탭이 생겼습니다

삭제는 오직 여기서만 가능합니다. 전체 삭제는 확인창을 거칩니다.

### 6. 백업 복구에 방식 선택이 생겼습니다

- **병합 복구**(기본) — 지금 데이터는 그대로 두고 백업 내용을 추가
- **전체 교체 복구** — 지금 데이터를 지우고 백업 내용으로 교체 (확인창 필수)

### 7. 서버 동기화 — 여러 명이 같은 기록을 봅니다

[데이터 관리] 탭에 서버 주소를 넣고 "지금 동기화"를 누르면, 그 서버에
연결된 다른 데스크톱 앱들과 기록을 주고받습니다. 서버에 있는 기록을
받아서 내 SQLite에 병합하고, 병합된 내 기록을 다시 서버로 올려서
서버도 병합합니다 — 양쪽 다 "추가"만 하므로 몇 번을 눌러도, 누가
먼저 눌러도 기록이 지워지거나 부풀지 않습니다. 자세한 사용법은
[SHARED_STORAGE.md](SHARED_STORAGE.md)를 참고하세요.

### 8. 코드를 고치면 자동으로 업데이트됩니다

`npm run dist`로 새 버전을 만들어 `release/` 를 서버로 올려두면(위와
같은 서버가 그대로 `/updates`로 내려줍니다), 이미 설치된 앱들이 앱을
켤 때 자동으로 새 버전이 있는지 확인하고, [도움말] → "업데이트 확인"
으로 수동으로도 확인할 수 있습니다. 설치되지 않은 개발 모드
(`npm start`)에서는 업데이트를 확인하지 않습니다.

---

## 설치해서 쓰기

`release/` 폴더에 두 가지가 만들어집니다.

| 파일 | 설명 |
|---|---|
| `Route Viewer Setup 3.0.0.exe` | 설치 프로그램. **바탕화면 바로가기 + 시작 메뉴**에 등록됩니다. |
| `RouteViewer-portable-3.0.0.exe` | 설치 없이 바로 실행하는 단일 실행 파일 |

설치 후:

```
바탕화면
┌────────────────┐
│   ⌁            │
│  Route Viewer  │   ← 더블클릭
└────────────────┘
```

데이터는 앱과 따로 보관되므로 앱을 지웠다 다시 깔아도, PC를 재부팅해도 그대로 남습니다.

---

## 개발자용

### 폴더 구조

```
route-viewer/
├─ electron/
│   ├─ main.js          앱 창 · 메뉴 · IPC · 자동 업데이트(electron-updater)
│   ├─ preload.js       화면에 노출하는 API (window.routeAPI)
│   └─ database.js      SQLite 스키마 · import/merge/중복제거 · 집계 쿼리
│
├─ src/
│   ├─ index.html
│   ├─ css/
│   │   ├─ style.css        기존 디자인 (그대로)
│   │   └─ additions.css    v3 추가 UI
│   └─ js/
│       ├─ parser.js        .xlsx/.csv 파싱 (브라우저·Node 공용)
│       ├─ core.js          버전 · 시계 · 거리/날짜 유틸
│       ├─ quality.js       데이터 품질 검사
│       ├─ storage.js       저장소 파사드 (SQLite ↔ IndexedDB)
│       ├─ ui.js            공용 모달
│       ├─ auth.js          로그인
│       ├─ calendar.js      달력
│       ├─ accum.js         누적 지도 · 구역 경계 · 커버리지 갭
│       ├─ statistics.js    지역별/차량별 통계
│       ├─ replay.js        리플레이 콘솔 · 테이프
│       ├─ importer.js      파일 불러오기(추가/병합) · 결과 리포트
│       ├─ backup.js        백업 저장/복구
│       ├─ sync.js          서버 동기화 (여러 데스크톱 앱이 기록 공유)
│       ├─ datamanager.js   데이터 관리(삭제) · 동기화 패널 · Import History 상세
│       ├─ settings.js      설정 — 차량/지역 관리 · Coverage Depth 기준
│       └─ app.js           탭 전환 · 시작 절차
│
├─ vendor/               leaflet · xlsx (오프라인용 로컬 사본)
├─ build/icon.ico        앱 아이콘
├─ tests/                자동 테스트
├─ tools/                빌드 보조 스크립트
├─ server.js             브라우저로 열고 싶을 때 (선택)
└─ route-viewer.html     v2 단일 파일 버전 (참고용으로 남겨둠)
```

### 실행 · 빌드

Node.js가 없으면 `tools/setup-node.ps1`이 프로젝트 안 `tooling/`에
포터블 Node를 받아옵니다(시스템에는 아무것도 설치하지 않습니다).

```powershell
powershell -ExecutionPolicy Bypass -File tools\setup-node.ps1
$env:Path = "$PWD\tooling\node-v24.19.0-win-x64;" + $env:Path

npm install
npm start          # 개발 실행
npm test           # DB · 파서 단위 테스트
npm run dist       # release/ 에 설치 파일 생성
```

브라우저로 열고 싶으면:

```powershell
node server.js     # http://localhost:8080
```

### 테스트

| 명령 | 내용 |
|---|---|
| `npm test` | `주행기록/` 안의 실제 엑셀로 DB 계층 검증 — 충돌/Coverage/Depth/설정 포함 (91개) |
| `powershell -File tools\e2e.ps1` | 실제 앱 창을 띄워 화면 조작 검증, 서버 동기화·설정·일자 요약 포함 (110개) |
| `node tests/server-sync-test.js` | `server.js` 공유 저장 병합 로직만 따로 검증 (21개) |

E2E는 `tests/screenshots/` 에 화면 캡처도 남깁니다.

### v3.1 구현 노트

**중복/충돌 판정** — key는 여전히 `date|time|vehicle|lat(6자리)|lng(6자리)`. 같은 key가
이미 있으면 "중복"이고, 그중 `place/road/weather/timeOfDay/traffic/speed` 값이 하나라도
다르면 "충돌"(대표 레코드는 먼저 들어온 값을 유지, 값을 덮어쓰지 않음). 어느 값이
어떻게 달랐는지는 `imports.conflicts_json`에 최대 500건까지 남습니다.

**Coverage 계산** — 기존 커버리지 갭과 같은 50m 격자·같은 폴리곤 판정(cell 중심점이
polygon 안이면 유효 cell)을 그대로 씁니다. `Coverage % = 방문 cell / 전체 유효 cell`.
차량이 지나갈 수 없는 건물 내부 때문에 100%를 영원히 못 채우는 문제가 있어서,
cell 중심점이 건물(OSM `building`, Overpass API로 구역 bbox 안만 조회) 위에 있으면
그 cell은 애초에 "유효 cell"에서 뺍니다. 구역별로 결과를 캐싱해서(경계가 바뀌기
전까진) 다시 받아오지 않고, 오프라인이면 예전 캐시나 건물 제외 없이(예전 방식)로
조용히 넘어갑니다.

**Coverage Depth 계산** — GPS point 개수가 아니라 "방문 세션" 기준입니다. SQLite
`LAG()` 윈도우 함수로 `(date, vehicle)`별 시간순 정렬 후 직전 행과 cell이 다를 때만
새 방문으로 셉니다 — 연속으로 찍힌 점은 방문 1회, cell을 벗어났다 돌아오거나 다른
날짜/차량이면 새 방문입니다. 등급 기준은 [설정] 탭에서 바꿀 수 있고 `app_meta`에
저장됩니다.

**차량/지역 migration** — `vehicles`/`zones` 테이블은 첫 실행(또는 기존 DB 업그레이드)
시 한 번만 하드코딩 기본값(토레스 1~4호, 강남/판교/시흥)으로 채워집니다. 이미 그려둔
구역 경계(예전 `zone_polygons` 테이블)가 있으면 `zones.polygon`으로 그대로 옮겨옵니다.
비활성화는 필터 버튼에서만 빠지고 `driving_records`의 zone/vehicle은 자유 텍스트라
기존 데이터에는 전혀 영향이 없습니다.

**일자 요약** — 달력에서 날짜를 클릭하면 `dateSummaryIndex`에 이미 캐시된 거리·품질
검사 결과(둘 다 `buildDaySummary()`가 import/삭제 시 미리 계산해둔 값)를 그대로 읽어
보여줍니다. GPS 공백/점프는 새 알고리즘이 아니라 기존 `analyzeDayQuality()`와 같은
기준(`src/js/quality.js`)으로 계산된 값입니다 — 처음엔 별도 "비교" 탭으로
두 날짜를 나란히 보는 화면이었는데, 날짜 하나를 볼 때 바로 보이는 게 더 유용해서
v3.1.1에서 일자 요약에 통합하고 비교 탭은 없앴습니다.

**백업 호환성** — `vehicles`/`zones`/`settings`는 v3.1에서 추가된 선택 필드입니다. 이
필드가 없는 v2/v3.0 백업을 복구해도 있는 필드만 쓰고 없는 필드는 건너뛰므로 깨지지
않습니다(`tests/run-tests.js`의 "v2 백업 복구" 테스트로 확인).

### 왜 Electron인가 (Tauri 대신)

- 화면이 이미 HTML/CSS/JS + Leaflet + SheetJS라 **그대로 재사용**됩니다. 다시 쓴 코드가 없습니다.
- Tauri는 Rust 툴체인 + MSVC 빌드 도구(수 GB)를 깔아야 하고, SQLite도 플러그인 + IPC를 새로 붙여야 합니다.
- SQLite는 `node-sqlite3-wasm`을 씁니다. **네이티브 컴파일이 없어서** 빌드 도구 없이도
  설치 파일이 만들어지고, Electron 버전을 올려도 재빌드가 필요 없습니다.

---

## 알려진 이슈

**지도 타일에 "API KEY REQUIRED" 워터마크가 보입니다.**
CARTO가 기존 무료 basemap(`basemaps.cartocdn.com`)에 API 키를 요구하도록 정책을 바꿔서
생긴 일이며, v3 작업과는 무관하게 v2에서도 동일하게 나타납니다.

고치려면 `src/js/core.js`와 `src/js/accum.js`의 타일 URL 두 곳을 바꾸면 됩니다.

```js
// 지금
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {...})

// 대안 1 — CARTO 키 발급 후 URL 뒤에 ?api_key=... 추가 (지금 디자인 그대로 유지)
// 대안 2 — 키 없이 쓰는 무료 타일 (밝은 지도라 화면 톤이 달라짐)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxZoom: 19, attribution: '© OpenStreetMap' })
```

어느 쪽으로 갈지는 결정이 필요해서 그대로 두었습니다.
