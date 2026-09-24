# 🚕 MEET — 택시 합승 매칭 플랫폼

같은 방향으로 가는 사람들을 연결해 택시비를 N분의 1로 나누는 서비스입니다.
현재는 모바일 우선 웹앱(MVP)이며, 서버 API는 이후 네이티브 앱에서도 그대로 사용할 수 있습니다.

## 주요 기능

| 기능 | 설명 |
| --- | --- |
| 회원가입 / 로그인 | 이메일 + 비밀번호(scrypt 해시), JWT 인증 |
| 합승방 만들기 | 출발지·도착지·출발 시간(7일 이내)·정원(2~4명)·성별 조건·메모 |
| 합승 찾기 | 출발지/도착지 좌표 기준 반경 검색, 경로가 가까운 순 정렬 |
| 요금 분담 계산 | 서울 중형택시 요금 기준 예상 요금, 현재 인원/만석 기준 1인 부담금 |
| 참여 / 나가기 | 정원·성별 조건 검사, 방장이 나가면 다음 멤버에게 자동 위임 |
| 실시간 채팅 | Socket.IO, 합승 멤버만 입장 가능 |
| 진행 상태 | 모집 중 → 이동 중 → 완료 (또는 취소), 방장만 변경 가능 |

## 실행

Node.js 22.13 이상이 필요합니다 (내장 `node:sqlite` 사용, 별도 DB 설치 불필요).

```bash
npm install
JWT_SECRET=아무-긴-비밀값 npm start     # http://localhost:3000
npm test                               # API·실시간 채팅 테스트
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `DB_PATH` | `meet.db` | SQLite 파일 경로 |
| `JWT_SECRET` | (임시 랜덤값) | 토큰 서명 키. 운영 환경에서는 반드시 설정 |

## 구조

```
src/
  index.js          서버 진입점
  app.js            Express 앱 + HTTP 서버 구성
  db.js             SQLite 스키마
  auth.js           비밀번호 해시, JWT, 인증 미들웨어
  rides.js          합승 도메인 로직 (생성/검색/참여/나가기/상태/채팅)
  geo.js            거리 계산, 택시 요금 추정, 분담금 계산
  realtime.js       Socket.IO (방 구독, 채팅, 상태 변경 알림)
  routes/           REST API 라우터
public/             모바일 웹 클라이언트 (빌드 과정 없는 Vanilla JS)
test/               node:test 기반 테스트
```

## API

모든 `/api/rides` 요청은 `Authorization: Bearer <token>` 헤더가 필요합니다.

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ email, password, nickname, gender }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | 내 정보 |
| GET | `/api/rides?originLat&originLng&destLat&destLng&radiusKm` | 모집 중인 합승 검색 |
| GET | `/api/rides/mine` | 내가 참여한 합승 |
| POST | `/api/rides` | 합승방 생성 |
| GET | `/api/rides/:id` | 합승방 상세 (멤버 포함) |
| POST | `/api/rides/:id/join` | 참여 |
| POST | `/api/rides/:id/leave` | 나가기 |
| PATCH | `/api/rides/:id/status` | `{ status: 'departed' \| 'completed' \| 'cancelled' }` |
| GET | `/api/rides/:id/messages?after=<id>` | 채팅 내역 |

Socket.IO (`auth: { token }`로 연결):
`ride:subscribe(rideId, ack)`, `chat:send({ rideId, body }, ack)` →
서버 이벤트 `chat:message`, `ride:updated`, `rides:changed`.

## 다음 단계 (로드맵)

- **지도/장소 검색**: 지금은 주요 거점 목록(`public/places.js`)만 지원 → 카카오맵/네이버 지도 API 연동
- **정산**: 토스페이먼츠·카카오페이 등으로 도착 후 1/N 자동 정산
- **신뢰·안전**: 휴대폰 본인인증, 탑승 후 상호 평가, 신고/차단, 동승자 정보 공유
- **알림**: 참여·출발 임박 푸시 알림 (PWA / FCM)
- **네이티브 앱**: React Native 또는 Flutter 클라이언트 (현재 API 재사용)
- **운영 인프라**: PostgreSQL + PostGIS(위치 검색), Redis 어댑터(Socket.IO 다중 서버)
