# 설치 · 실행 · 빌드 · 테스트

> Route Viewer 문서 · [← README 목차로](../README.md#문서-목차)

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
| `tests/coverage-manual-cells-test.js` | 현재 선택/확정 분리·선택 초기화·선택 적용·저장 실패·미방문·Coverage 캐시/무효화·늦은 비동기 결과, 지도 데이터 서버가 막혔을 때 재시도 쿨다운 | 84 |
| `tests/accum-date-filter-test.js` | 날짜 범위별 밀도 지도·통계·Coverage 방문/%/Depth, 기본값은 전체 기간(되살아난 입력값도 비움), 날짜 캐시 키·Geometry 재사용·debounce·늦은 결과 차단, SQLite↔IndexedDB 동등성 | 51 |
| `tests/map-capture-test.js` | 캡처 파일명·영역 계산, 버튼 활성 조건·IPC 요청·취소/실패·중복 클릭·pending 제외·UI 복원·날짜 변경 직후, 브라우저 모드 합성(타일 z-index 순서·페이드 투명도·CSS filter·다운로드/저장 창·CORS 오류) | 51 |
| `tests/collection-progress-test.js` | 수집 시간 규칙(90초 공백·차량/날짜 합산·중복)과 주행 시간(첫~마지막 기록), 진행률·목표 초과·주행 기준 참고값, 재등록·삭제·복원·동기화·재시작·요약 마이그레이션, SQLite↔IndexedDB(실제 `core.js` 요약 함수) 동등성, 실제 주행기록의 주행 시간 = 단순 계산 합, 달력 표·달력 칸·일자 요약·월 이동 시 재계산 없음 — 입력·기대·실제값 출력 | 55 |
| `tests/tile-proxy-test.js` | `server.js` 타일 프록시 — 가짜 OSM 서버로: 앱 식별 UA·서브도메인, MISS→HIT 캐시, 동시 요청 1회로 합침, 차단 이미지(200+`x-blocked`)·403 → 502·캐시 안 함·거절 로그, 차단 시 오래된 캐시(STALE), 잘못된 좌표·경로 404 (인터넷 불필요) | 15 |
| `tests/time-conditions-test.js` | 교통 시간대 경계(초 단위·24:00·86,400초 전부 한 구간)·설정 검증(겹침/공백/형식/자정 넘김/순서·이름 무관), 조도 조건(USNO 일출·일몰 1분 이내, ±30분 경계, 날짜/GPS/시각 누락, 극지방, 캐시), **TZ=UTC·LA·서울 결과 동일**, 교통 야간 ≠ 조도 야간, 조건 칸 수집 시간 합 = 날짜 수집 시간(실제 주행기록 16일), 집계 API·복합 조건·추천용 질문 예시 | 101 |
| `tests/time-conditions-storage-test.js` | 구버전 DB(SQLite·IndexedDB)·구버전 Excel(시간대/날씨 열 없음)·구버전 백업 호환, 중복 판정·충돌 집계 불변, 설정 저장 검증(두 저장소), 재분류(진행률·중복 실행 방지·중간 실패 시 보존·재시작 후 이어서), **SQLite ↔ IndexedDB 조건 칸 일치(실제 주행기록 전체, 설정 변경 전후)**, 실제 `server.js` 동기화 후 분류 유지(포트 8096, `ROUTE_VIEWER_DATA_FILE`로 임시 공유 파일 — 저장소 루트의 실제 공유 데이터를 건드리지 않음), 실제 `settings.js`/`statistics.js`/`calendar.js` 화면(저장 거부 이유·재분류 후 통계 갱신·기본값 복원·일자 요약 두 축·이슈 현황 표는 '전체'일 때만) | 76 |
| `tests/recommendation-test.js` | 추천 엔진(순수 함수)과 **주행 계획**(시간 블록·부족분 장부·이동 시간·구역 선택·차량 여러 대·운행 시간 비교) — 점수 0/100 경계·기본 가중치·가중치 합계 검증·범위·같은 입력 같은 결과, 순위(부족 시간대/낮은 Coverage/오래된 미방문/차량 편중)·내림차순·동점 규칙, 데이터 누락(없는 날씨 안 만듦·GPS/시각 누락 신뢰도 하향·빈 데이터 안내), Edge Case 규칙 적용/미적용·가능성 표현, 권장 시간(일출·일몰 계산)·횟수·단계 상한, LLM payload(GPS·이름 제외) | 73 |
| `tests/recommendation-storage-test.js` | Coverage 스냅샷·추천 상태 저장(두 저장소)과 지문에 따른 오래됨 판정, 누적 지도 계산 → 스냅샷 → 추천 점수로 이어지는 경로(실제 `accum.js`), 추천 설정 검증(가중치 합계 등)·원본 기록 불변, 화면(실제 `recommend-view.js`) 카드·근거 상세·필터/정렬·숨김/제외/완료, 갱신과 캐시(Import·삭제·설정 변경 후 재계산, 탭 왕복 시 재계산 없음, 늦은 결과 무시), **SQLite ↔ IndexedDB 동일 결과**·백업 복원·서버 동기화·구버전 DB, 주행 계획 화면(타임라인·1시간 일찍 비교·프리셋) | 58 |
| `npm run test:browser-capture` → `tests/browser-capture-e2e.js` | 실제 브라우저 모드(`server.js` + IndexedDB, preload 없는 창) — 달력 수집 현황 표, 화면 타일이 `/tiles` 프록시로 오고 차단 이미지가 아님(픽셀), 지도 캡처 → 다운로드된 PNG 크기·타일·흑백 필터·밀도 원·빨간 칸 픽셀 검사, 추천 주행 탭 카드·근거 상세·탭 왕복 캐시 (인터넷 필요) | 19 |
| `node tests/server-sync-test.js` | `server.js` 공유 저장 병합(수동 셀 병합 포함) — 포트 8099로 서버를 띄움 | 25 |
| `tests/auto-analysis-test.js` | 지도 기반 자동 분석 — 등록 없이 자동 생성·안정적인 id·분할 기준(교차로/도로명/최대 길이), 근거로만 분류(공식 보호구역 ↔ 학교 인접 도로 구분·본선/램프 분리·합류 후보는 가능성으로)·없는 이름 생성 금지, 25m Map Matching·방향별/시간대별/조도별/요일별 집계·중복 집계 없음·이슈 필터, 구체적 구간/방향/시간/횟수·부족 근거·신뢰도·안전 문구·가중치 검증, **캐시(탭 전환 시 재분석 없음)·GPS Import 후 부분 갱신·보정 유지·오프라인·SQLite ↔ IndexedDB 일치** | 42 |
| `tests/subzone-recommendation-test.js` | 세부 구역 추천 — 공간 3단계 분리·수동 등록/수정/비활성화·검증, 실제 HD Map 도로만 사용(이름 없는 도로에 이름 만들지 않음·도로 등급 단정 금지), 장소 유형별 후보 시간대(업무지구·학교 인접 도로 등하교 후보·본선/램프 분리)·보호구역 단정 금지·안전 안내, 부족한 조건만 우선(충분하면 하향)·방향별 추천과 방향 신뢰도, 카드↔지도 구간 일치·거리/시작/끝 계산·근거와 출처 표시, 이슈 필터 적용·**SQLite ↔ IndexedDB 집계 일치**·기존 기능 회귀 없음 | 31 |
| `tests/recommendation-ops-test.js` | 추천 주행 운영 개선 — **지도 POI** 파싱·분류 연결·경계 기반 인접·POI 없을 때 fallback·`poiDataRevision` 지문(SQLite·IndexedDB)·POI 만 바뀌면 무거운 단계 재사용, **평일/주말 후보**, **Priority Policy**(정책별 사업 우선도·단계 경계·기간 겹침·정책 없음·초기 정책·보존/이력·잘못된 정책 거부·추천 상태에 당시 정책 저장), 사업 우선도가 1위를 만들지 않음, **Road Graph** 이동 거리·직선 fallback·구역 변경 비용(A→B→A 억제), **오늘 추천 Top 3**(요일·운행 시간·숨김/완료·어디/언제/왜·같은 도로 구간 이름 구분), Edge Case = 가능성 × 부족, **추천·설정·통계가 같은 정책·같은 분류**, 원본 기록 불변 | 66 |
| `tests/hdmap-priority-test.js` | 2차년도 HD Map 우선 구축 구역 ①~⑫ — 우선순위는 코드가 아니라 **활성 Priority Policy** 에서(⑤ 중심 ↔ ⑩ 중심 ↔ 정책 없음 = 모두 비우선 · 단계 경계 · 고정 우선 목록 상수 없음 · 초기 정책 변환), 일반/비우선 지역 평균·차이(분)·퍼센트·배수와 **0으로 나누기 처리**, 우선지역 비중·가장 부족한 우선지역, 수집 세션(같은 차량 10분 경계·차량/날짜 분리)과 기존 방문 횟수 불변, 경계 밖 GPS 제외·경계 겹침 정책(양쪽 계상 + 경고)·맞댄 경계선 위의 점은 한 번만, **경계가 없으면 0분이 아니라 '잴 수 없음'으로 두고 통계를 켜지 않음**, Coverage 는 도로 데이터 없으면 null, **SQLite ↔ IndexedDB 일치**(경계 저장 규칙 포함)·기존 데이터 회귀 없음, 직접 그린 경계 저장/재시작/백업복원/삭제·검증 거부와 **저장 즉시 기존 기록 재분류**, 못 센 이유 구분(경계 미설정/기록 0건/계산 실패/Coverage 미계산), 구역 번호 안내 이미지가 앱 자산으로 들어 있고 경계·기록과 무관하게 남으며 위치 안내 전용(우선순위와 무관)이라고 밝히는지 | 59 |
| `tests/import-issue-test.js` | Import 이슈 기록·이슈 데이터 분리(회색 표시 포함) — 입력 검증(체크 시 메모 필수·200자·공백 정리), 이슈 필드 저장·파일별 독립·출처 관계(중복 레코드 포함), 세 가지 데이터 상태 필터 의미(예전 값 호환 포함)와 **SQLite ↔ IndexedDB 동일 결과**, 상태 변경(확인 완료↔확인 필요·메모 수정·이슈 해제)과 날짜 요약 자동 재생성, 조건 칸 이슈 마스크·부분 필터(주행 시간 제외), Coverage 캐시 키(정적 Geometry 키는 불변)·재계산/재사용, 통계 이슈 현황·추천 계산 기준, 백업 복원·실제 `server.js` 병합(최신 수정 우선·충돌 기록·출처 합집합), 출처 없는 예전 데이터 안전성, 누적 지도 회색 점 겹쳐 그리기(실제 `accum.js` 렌더)·통계 막대 회색 몫 | 72 |
| E2E (`tests/e2e-driver.js`) | 실제 Electron 창을 띄워 화면 조작 — 달력 수집 현황 표(날짜 삭제 후 갱신), 날짜 키보드 입력, 실제 `capturePage` PNG 저장(Coverage·Density, 픽셀 검사), **Import 이슈 확인 창(메모 검증 포함)·달력 배지·데이터 상태 필터·일자 요약 이슈사항·누적 지도 회색 점·통계 이슈 현황과 회색 막대·데이터 관리 이슈 관리·주행 계획(1시간 일찍 비교)·세부 구역 등록 후 도로 구간 추천·자동 분석(구간 추천·지도·캐시)** 포함 | 158 |

`npm test` 는 2026-09-30 기준 25개 파일입니다(`tests/recommendation-ops-test.js` 추가). 이날 실행에서 `collection-progress-test`
1건(실제 기록 주행 시간 합)과 `subzone-recommendation-test` 1건(SQLite↔IndexedDB 세부 구역 집계)이 실패하는데, 둘 다 이 추천
개선 이전 `main` 에서도 같게 실패하는 기존 이슈입니다. `recommendation-storage-test` · `time-conditions-storage-test` 는 로컬
`server.js` 동기화 단계에서 간헐적으로 `fetch failed` 가 납니다(그 전 항목은 모두 통과).
2026-09-17 기준(919개 · 19개 파일 전부 통과) 데스크톱 E2E 158개 중 157개 통과·1개 실패 —
실패 1건은 아래 알려진 이슈의 "지역별 Coverage 요약 패널"(Overpass 건물 데이터를 못 받은 경우)이고,
화면 콘솔 에러 1건도 Overpass 미러 접속 실패 경고입니다. 브라우저 모드 E2E 19/19 ·
`node tests/server-sync-test.js` 25/25 는 이 기능 이전 실행 기준입니다. `tests/manual-cells-storage-test.js`는 브라우저 IndexedDB 백엔드를
`tests/helpers/fake-indexeddb.js`(테스트 전용 최소 구현)로 Node에서 실행하고,
`tests/coverage-manual-cells-test.js`는 실제 `accum.js`/`storage.js`를 vm으로 로드해 SQLite로 돌립니다
(지도·DOM만 가짜, `tests/helpers/accum-harness.js`).

E2E 실행 — 매번 새 **임시 폴더 DB**에서 돌고, 실제 주행 DB(`%APPDATA%\Route Viewer`)는 건드리지 않습니다:

```powershell
npm.cmd run test:e2e               # 전체 화면 E2E (tests/e2e-driver.js)
npm.cmd run test:e2e:auto-import   # 자동 가져오기 화면 E2E (tests/auto-import-e2e.js)
```

E2E 는 기록을 넣고 날짜를 지우므로 안전장치를 세 겹 둡니다 — 실행기(`tests/run-e2e.js`)가 임시 `--user-data-dir` 을 주고,
`ROUTE_VIEWER_E2E` 가 켜져 있으면 `electron/main.js` 가 userData 를 임시 폴더로 강제하고, `tests/e2e-driver.js` 는
DB 경로가 임시 폴더가 아니면 아무것도 하지 않고 끝냅니다.

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
│   ├─ data/            강남/서초 HD map 도로 (window.HDMAP_*_ROADS) · ①~⑫ 우선 구역 경계 GeoJSON
│   ├─ assets/          화면에 그대로 띄우는 참고 이미지 — hdmap-priority-reference.png(①~⑫ 위치 안내 전용 · 흑백 표시 · 우선순위와 무관)
│   └─ js/
│       ├─ coverage-grid.js 방문 칸 계산 · 수동 셀 형식/병합 · Cell 크기 (SQLite·브라우저·서버 공용)
│       ├─ map-capture.js   지도 캡처 파일명 · 캡처 영역 계산 (화면·메인 프로세스 공용)
│       ├─ collection-stats.js 유효 수집 시간 · 수집 목표(COLLECTION_TARGETS) · 진행률 (SQLite·브라우저 공용)
│       ├─ time-conditions.js  교통 시간대 · 조도 조건(일출·일몰 계산) · 요일 분류 규칙 · 설정 검증 (SQLite·브라우저 공용)
│       ├─ issue-filter.js    Import 이슈 · 데이터 상태 필터의 단일 원천 — 마스크 판정 · 메모 검증 (SQLite·브라우저 공용)
│       ├─ condition-stats.js  날짜 요약의 조건 칸 만들기 · 조건별 집계 API (SQLite·브라우저 공용)
│       ├─ road-graph.js    지도 도로 데이터 → 도로망 Graph·Segment 자동 분할(교차로/도로명/최대 길이) · 최단 거리 라우터(주행 계획)
│       ├─ auto-subzones.js  자동 분류(근거 기반·POI 연결)·자동 세부 구역 묶기·사용자 보정 덮어쓰기 · POI 지문
│       ├─ poi-data.js      지도 POI — Overpass 응답/아파트 단지 캐시 → 자동 분류 입력(받지 않은 종류는 "확인 안 됨")
│       ├─ priority-policy.js HD Map 우선 수집 정책 — 활성 정책 선택·단계(최우선~비우선)·검증·보존/이력·초기 정책 (공용)
│       ├─ priority-policy-view.js [설정] 탭 정책 편집 화면 + 모든 화면이 읽는 활성 정책(getActivePriorityPolicy)·변경 알림
│       ├─ auto-analysis-view.js 자동 분석 화면 — 구역 선택·지도·추천 카드·근거 상세·보정
│       ├─ subzones.js      세부 수집 구역·도로 구간 — 장소 유형/후보 시간·경계 판정·HD Map 구간 추출·Map Matching (공용)
│       ├─ hdmap-priority.js  HD Map 우선 구축 구역 ①~⑫ 경계·활성 정책 기준 분류·정책 우선지역/일반·비우선 비교 통계 (공용)
│       ├─ hdmap-priority-view.js [통계] 탭 "HD Map 우선 수집" 현황판(카드·막대·비교표) + [설정] 탭 ①~⑫ 배지·경계 상태
│       ├─ hdmap-priority-editor.js ①~⑫ 경계를 지도에서 직접 그려 저장(WGS84) — 저장 즉시 기존 기록 재분류
│       ├─ subzone-view.js  세부 구역 관리 화면 · 세부 추천 카드 · 추천 지도
│       ├─ recommendation.js  추천 주행 엔진 — 부족도 점수 · 사업 우선도 결합 · 권장 시간/횟수 · Edge Case · 신뢰도 · 주행 계획 · 오늘 Top 3 · LLM payload (순수 함수)
│       ├─ recommend-view.js  추천 주행 탭 화면 — 오늘 추천 Top 3 · 카드 · 근거 상세 · 필터/정렬 · 설정 · 주행 계획 · 캐시
│       ├─ storage.js       저장소 파사드 RouteDB (SQLite ↔ IndexedDB) + 변경 알림
│       ├─ accum.js         누적 지도 · 구역 경계 · Coverage 계산/캐시 · 수동 셀 편집
│       ├─ app.js           탭 전환 · 시작 절차
│       └─ …                parser/core/quality/ui/auth/calendar/statistics/replay/importer/backup/sync/datamanager/settings
├─ tests/                자동 테스트 (helpers/ = 테스트 전용 도구)
├─ tools/                빌드 보조 스크립트
├─ server.js             브라우저 모드 정적 서버 + 공유 저장(동기화) + /updates
└─ route-viewer.html     v2 단일 파일 버전 (참고용)
```
