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
- **달력 · 일자 요약** — 운행 시간·구역·차량·주행 거리·기록 수·주행 시간·GPS 공백/점프.
- **누적 지도** — 전체(또는 날짜 범위) 기록의 밀도 지도 + 구역별 **Coverage Map**.
- **통계** — 지역별/차량별 분포.
- **설정** — 차량/지역 추가·비활성화(삭제 아님), Coverage Depth 등급 기준.
- **데이터 관리** — 날짜별/전체 삭제(삭제는 여기서만), 서버 동기화 설정.
- **백업/복구** — 병합 복구(기본) / 전체 교체 복구(주행 기록만 교체, 설정·수동 셀은 지우지 않음).

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
- 계산 결과는 구역별로 캐시합니다. 키 = 구역, 경계 polygon 해시, 날짜 필터, Cell 크기, 데이터 revision,
  그 구역의 수동 셀/경계 revision, Coverage 설정 revision. Depth·디버그 보기 전환은 캐시된 결과로 다시 그리기만 합니다.
- **무효화(재계산) 조건**
  - 모든 구역: 주행기록 import, 날짜/전체 삭제, 백업 복원, 서버 동기화, Coverage 설정(`setSettings`) 변경
  - 해당 구역만: 수동 셀 "선택 적용", 구역 경계 추가·수정(꼭짓점 드래그)·삭제
  - 키가 달라져서 새로 계산: 선택 구역 변경, 날짜 필터 변경
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
node server.js     # 브라우저 모드(IndexedDB) + 서버 동기화 서버, http://localhost:8080
```

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
| `node tests/server-sync-test.js` | `server.js` 공유 저장 병합(수동 셀 병합 포함) — 포트 8099로 서버를 띄움 | 25 |
| E2E (`tests/e2e-driver.js`) | 실제 Electron 창을 띄워 화면 조작 | 116 |

`npm test` 합계 291개. `tests/manual-cells-storage-test.js`는 브라우저 IndexedDB 백엔드를
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
