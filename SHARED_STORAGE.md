# Route Viewer 공유 저장 사용법

`localStorage`는 브라우저마다 따로 저장됩니다. 모두가 같은 주행 기록을 보려면 이 프로젝트를 서버로 실행해서 `route-viewer-shared-data.json`을 공용 저장소로 쓰면 됩니다.

## 실행

```powershell
node server.js
```

브라우저에서 `http://localhost:8080`으로 접속합니다. 같은 네트워크의 다른 기기에서는 이 PC의 IP 주소로 접속하면 됩니다.

```text
http://PC_IP_ADDRESS:8080
```

## 동작 방식

- `node server.js`로 접속하면 기록을 불러오거나 백업을 복구할 때 서버의 `route-viewer-shared-data.json`에 자동 저장됩니다.
- 다른 사람이 같은 주소로 접속하면 서버에 저장된 기록을 먼저 불러오므로 같은 달력, 누적 지도, 통계를 봅니다.
- `route-viewer.html`을 파일로 직접 열면 서버가 없으므로 기존처럼 내 브라우저의 `localStorage`에만 저장됩니다.

공유 저장에는 주행 기록(`route_viewer_entries_by_date`), 커버리지 갭 구역 경계(`route_viewer_zone_polygons`), 백업 기록(`route_viewer_backup_history`)이 함께 들어갑니다. 브라우저 `localStorage`에는 빠른 복원용 복사본만 남습니다.

외부 인터넷에서도 보려면 이 폴더를 Render, Railway, Fly.io, 사내 서버 같은 Node 실행 가능한 곳에 배포하면 됩니다.

## 저장 암호 선택 사항

공개 주소로 배포한다면 아무나 기록을 덮어쓰지 못하게 저장 암호를 걸 수 있습니다. 읽기는 그대로 열리고, 저장할 때만 암호를 묻습니다.

```powershell
$env:ROUTE_VIEWER_WRITE_TOKEN="원하는암호"
node server.js
```
