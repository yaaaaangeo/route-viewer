# LOGGERD 로깅 기록 MVP

## 구현 범위와 실행 주의

`collection-loop`의 Electron + SQLite + RouteDB 구조를 확장한다. GPS, 수집 계획, 주행 결과의 스키마와 계산 규칙은 변경하지 않는다.

**현재 인식기는 Mock이다. 사진을 읽지 않는다.** 사진마다 `MOCK-<해시>-1/2` 후보 두 개를 만들고 날짜·시각·용량·개수는 비워둔다. 관리자가 원본을 보고 값을 입력해야 한다. 확정 시 Mock 확인란이 필요하며 모든 기록에 Mock 출처가 유지된다. 실제 통계에는 Mock을 기본 제외한다.

마이그레이션은 앱이 DB를 열 때 실행된다. 운영 DB 반영 승인을 받기 전에는 일반 `npm start`/`run.cmd`로 실행하지 않는다. 아래 테스트는 별도의 임시 DB와 임시 사진 폴더만 사용한다. 이번 구현 작업에서는 운영 DB를 열지 않는다.

## 단계 1 — 공용 모델과 저장소

- `src/js/logging-records.js`: UMD 순수 모델, 날짜/시각/개수 검증, 원문 보존, 단위별 정확한 십진 합산, 전체 크기 라벨 검사.
- `electron/logging-database.js`: 독립 스키마·CRUD·이력·중복 처리. `database.js` 생성자와 prototype에서 연결.
- 기존 테이블 변경 없이 `logging_assets`, `logging_jobs`, `logging_recognition_runs`, `logging_candidates`, `logging_sessions`, `logging_session_evidence`, `logging_session_revisions` 추가.
- `app_meta.logging_schema_version=1`. 반복 DB 열기에 안전한 `CREATE IF NOT EXISTS`.
- 사진 SHA-256과 세션 identity는 별개. 세션 identity는 `[LOGGERD 설치 범위, NFC 정규화 폴더명]`이다. 대소문자나 `0/O`를 임의 치환하지 않는다.
- 장비 범위가 없으면 같은 폴더를 같은 세션의 후보로 취급한다. 다른 장비의 같은 폴더라면 장비/설치 구분을 입력한다.
- 같은 identity 저장은 자동 덮어쓰지 않는다. 동일값 근거 추가 또는 충돌 확인 후 교체를 명시해야 한다.
- 후보 원문은 수정하지 않는다. 사용자가 확정한 값은 별도 `data_json`, 변경은 버전 및 append-only revision에 저장한다.
- SQLite 변경·근거 연결·검토 완료·이력은 한 트랜잭션이다. `expectedVersion`으로 오래된 편집을 차단한다.
- 차량은 기존 `vehicles.name`을 검증한다. 기존 주행 세션 연결 시 `drive_results.session_id`와 차량을 검증한다. 이 기능은 기존 주행 평가를 수정하지 않는다.

검증: `node tests/logging-model-db-test.js`.

## 단계 2 — 원본 보관과 인식기

- `electron/logging-service.js`: 사진 선택 결과를 보관하고 순서대로 처리한다.
- JPEG/PNG, 1회 최대 50장, 사진당 최대 20 MiB, 디코딩 결과 최대 4천만 픽셀.
- 실제 Electron `nativeImage`로 디코딩한 사진만 받는다. 확장자만 신뢰하지 않는다.
- 원본은 `<userData>/logging/originals/<sha256>.<png|jpg>`에 임시 파일을 거쳐 저장한다. 원본 바이트를 변형하지 않는다.
- 원본 읽기는 관리 ID로만 하며 경로 패턴과 SHA-256을 확인한다. 선택한 외부 원본이 지워져도 보관본은 유지된다.
- 같은 바이트를 다시 선택하면 기존 사진을 돌려준다. 원본 보관 파일이 사라진 경우 같은 사진을 재선택하면 파일을 복원한다.
- 작업 상태는 `processing/succeeded/failed`. 중단된 작업은 재시작 시 `failed/INTERRUPTED`가 되고 사용자가 재시도한다. 유료 인식기를 조용히 다시 호출하지 않는다.
- 동일 사진의 동시 인식은 같은 Promise를 사용하고 활성 작업 UNIQUE 인덱스로 보호한다.
- 재시도는 새 작업·새 실행·새 후보를 만든다. 이전 확정값과 원문은 유지된다.
- 에러는 정해진 안전한 메시지로 변환한다. 외부 인식기 오류·요청·사진 텍스트·경로를 로그에 출력하지 않는다.

검증: `node tests/logging-service-test.js`.

### 실제 인식기 연결 계약

`electron/logging-recognizer.js`의 `assertRecognizer()` 계약을 만족하는 객체를 `new LoggingService({ recognizer, ... })`에 주입한다.

```js
{
  id: 'adapter-id',
  version: '1',
  isMock: false,
  async recognize({ imageBytes, mimeType, sha256 }) {
    return {
      schemaVersion: 1,
      sessions: [{
        fields: {
          folder: null, loggingDate: null, startedTime: null,
          durationRaw: null, sizeRaw: null, sizeValue: null,
          sizeUnit: null, fileCount: null, recordingCount: null,
          completion: 'unknown'
        },
        evidence: { sizeValue: { label: '전체 크기', text: '...' } }
      }]
    };
  }
}
```

`sessions`는 최대 100개. 필드는 식별한 원문 문자열 또는 null이다. `completion`은 `unknown/completed/recording/incomplete/failed`를 사용한다. 디스크 여유를 전체 크기로 사용하면 안 된다. 전체 크기 라벨 근거가 없으면 서비스가 용량을 비운다. 응답의 알려진 필드만 저장하므로 인증 헤더 등은 인식기 결과로 전달하지 않는다.

행 단위 라벨/값 연결, 반사·원근·밝기 보정, OCR 정확도 평가, timeout/취소/외부 서비스 재시도는 후속 실제 인식기 작업이다. 현재 Mock에서 이미지 판독 정확도를 주장하지 않는다. API 키 설정이나 외부 API 호출은 구현하지 않았다.

## 단계 3 — IPC·RouteDB·검토 UI

- `electron/logging-ipc.js`: 기존 `{ok,value}` / `{ok:false,error}` 형식을 유지하고 오류 코드를 추가한다. 현재 메인 창의 sender만 허용한다.
- `preload.js`: `call()`이 오류 코드를 보존하고 로깅 메서드·구독 해제 가능한 이벤트를 노출한다.
- `storage.js`: 기존 데스크톱 백엔드로 전달한다. 브라우저는 capability에 `DESKTOP_ONLY`, 쓰기에는 `UNSUPPORTED_PLATFORM`을 반환한다. IndexedDB 버전은 바꾸지 않는다.
- `index.html`: 데이터 관리 안에 전용 패널을 추가한다.
- `datamanager.js`: GPS 기록 0건일 때의 early return보다 먼저 패널을 그린다.
- `app.js`: 한 번만 이벤트를 연결한다.
- `logging-records-view.js`/CSS: 사진 목록·검토함·원본 보기·확정·상세·수정·충돌 비교·실패 재시도.
- `logging:changed` 전용 알림을 사용한다. GPS Coverage/추천/KPI 무효화 알림으로 위장하지 않는다.

IPC 서비스: `logging:getCapabilities`, `pickPhotos`, `readAsset`, `listJobs`, `retryJob`.

RouteDB/IPC DB 메서드: `listLoggingAssets`, `listLoggingCandidates`, `getLoggingCandidate`, `confirmLoggingCandidate`, `rejectLoggingCandidate`, `listLoggingSessions`, `getLoggingSession`, `updateLoggingSession`, `getLoggingTotals` (`db:<메서드>`).

사진 선택 후 모든 후보는 검토 대기다. 모르는 항목은 비워둘 수 있으나 세션 폴더와 날짜는 확정에 필수다. Mock 출처는 수정으로 실제 출처로 바뀌지 않는다. 후보 제외에는 사유가 필요하다.

검증: `node tests/logging-ipc-test.js`, `node tests/run-logging-e2e.js`.

## 합계와 분리 원칙

- 완료 상태의 고유 확정 세션만 단위별 용량 합계에 포함한다.
- 날짜는 확정한 `loggingDate`, 차량 미연결은 별도 그룹이다.
- 원본 문자열·숫자의 소수 자릿수·단위를 보존한다. `sizeBasis=unknown`, `sizeBytes=null`이다.
- GB/TB를 합치거나 바이트로 환산하지 않는다. 단위별 표기값 합계와 용량 확인된 세션 수를 함께 표시한다.
- Mock은 기본 제외. 사용자가 테스트 합계 포함을 켤 수 있다.
- 기존 GPS `collectionSec`, 주행 거리, Collection Loop 결과에 반영하지 않는다.
- 기존 GPS 날짜/전체 삭제는 로깅 기록을 지우지 않는다.
- 기존 JSON 백업·서버 동기화에는 포함하지 않는다. **현재 로깅 전용 백업·복구는 아직 없다.** 운영 도입 전 원본과 DB를 함께 보존하는 백업 절차가 필요하다.

## 테스트 명령

```powershell
npm.cmd run test:logging
npm.cmd run test:e2e:logging
npm.cmd test
```

Node가 PATH에 없으면 저장소 `tooling/node-v24.19.0-win-x64`의 Node/npm을 사용한다.

`npm test`의 `posttest`에서도 LOGGERD 모델·서비스·IPC 테스트를 실행한다.

2026-10-21 구현 검증 결과:

- 공용 모델·SQLite: 11개 검사 통과
- 사진 보관·Mock·실패 복구: 6개 검사 통과
- 실제 preload/IPC·RouteDB·브라우저 분기·확정 전 원본 검사: 5개 검사 통과
- Electron 임시 프로필 E2E: 사진 선택/중복/검토/저장, 상세 수정/이력, 중복 비교/근거 추가의 3개 시나리오 통과
- 변경 소스 9개 문법 검사 및 `git diff --check` 통과
- 기존 `npm test` 전체 회귀 테스트 종료 코드 0. GPS·Collection Loop·조건 분류·추천·서버 동기화·자동 가져오기·업데이트 검증 통과.

E2E는 기존 `ROUTE_VIEWER_E2E` 안전장치를 사용하고 userData가 OS 임시 폴더 밖이면 중단한다. 원본·DB·스크린샷은 테스트 임시 폴더에 남긴다. 테스트의 GPU 비활성 옵션은 실행기에만 적용한다.

## 후속 작업

- 실제 LOGGERD 평가 사진·용량 단위 기준·장비 식별 범위 확정
- 실제 OCR/AI 어댑터와 이미지 전처리, 필드별 위치/신뢰 정보
- 기간 필터·월별 추이·차트·예정 기준에 따른 누락 판정
- 로깅 전용 사진 포함 백업·복구, 보존/제외 정책
- 대규모 목록 페이지 처리, 사진 확대·기울기 보정 도구
- 필요 시 사진 폴더 가져오기. 기존 `electron/auto-import.js`는 이번 MVP에서 변경하지 않음
- 카카오톡 연계는 별도 후속 단계

이번 단계에서는 운영 DB 실행, 실제 배포, Git push를 하지 않는다.
