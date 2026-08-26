# database/

실제 주행 기록 데이터베이스는 **이 폴더가 아니라** 사용자 프로필에 저장됩니다.

```
%APPDATA%\Route Viewer\database\route-viewer.db
```

앱에서 [데이터 관리] 탭 → **폴더 열기** 를 누르면 바로 열립니다.

## 왜 프로젝트 폴더가 아닌가요

설치형 앱은 `C:\Program Files\...` 처럼 **쓰기 권한이 없는 곳**에 설치될 수 있고,
앱을 업데이트하거나 다시 설치하면 설치 폴더가 통째로 교체됩니다.
데이터를 설치 폴더에 두면 업데이트 한 번에 그동안 쌓은 기록이 날아갑니다.

사용자 프로필에 두면

- 앱을 껐다 켜도
- PC를 재부팅해도
- 앱을 지웠다 다시 깔아도

기록이 그대로 남습니다.

## 스키마

| 테이블 | 내용 |
|---|---|
| `driving_records` | GPS 기록 한 줄씩. `record_hash` 에 UNIQUE 제약(중복 방지) |
| `imports` | 어떤 파일을 언제 누가 넣었고 몇 건이 추가/중복/충돌됐는지(`conflicts_json`에 상세) |
| `vehicles` | 차량 설정 — [설정] 탭에서 관리(예전엔 소스코드에 하드코딩) |
| `zones` | 지역 설정 · 구역 경계(polygon) — [설정] 탭 + 누적 지도에서 관리 |
| `zone_polygons` | (예전 저장소, v3.1부터 `zones.polygon`이 정본) 업그레이드 시 1회 migration 출처로만 남아있음 |
| `date_summaries` | 달력용 날짜별 요약 캐시 — 거리/품질검사 결과 포함 (import/삭제 때 해당 날짜만 재계산) |
| `app_meta` | 백업 기록 · 서버 동기화 설정 · Coverage Depth 기준 등 |

DB 파일은 표준 SQLite라 DB Browser for SQLite 같은 도구로 열어볼 수 있습니다.
