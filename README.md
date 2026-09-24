# 🚕 MEET — 택시 합승 매칭 플랫폼

같은 방향으로 가는 사람들을 연결해 택시비를 N분의 1로 나누는 서비스입니다.
현재는 모바일 우선 웹앱(MVP)이며, 서버 API는 이후 네이티브 앱에서도 그대로 사용할 수 있습니다.

## 합승 흐름

```
찾기 ──▶ 참여 ──▶ 만나기 ──▶ 출발 ──▶ 정산 ──▶ 평가
```

| 단계 | 기능 |
| --- | --- |
| **찾기** | ⚡ 지금 바로(30분 안 출발) / 🕐 시간 지정(±30분) 검색. 출발지·도착지 반경 매칭에 더해, 내 도착지가 경로 중간이면 **"가는 길에 하차"** 로도 매칭. 경로 차이 + 시간 차이가 작은 순 정렬, 카드마다 **내 예상 부담금** 표시 |
| | 결과가 없으면 **이 조건으로 방 만들기** 또는 **🔔 경로 알림 받기** (그 경로로 방이 생기면 푸시) |
| **참여** | 최종 도착지까지 / 가는 길에 먼저 내리기 선택. 성별·소속 조건, 차단 관계, 만석, **같은 시간대 중복 참여**(노쇼 원인)를 서버에서 차단 |
| **만나기** | 방장이 정한 **만남 장소**(멤버에게만 공개, 변경 시 알림), 출발 10분 전 알림, 출발 1시간 전부터 **📍 도착했어요** 체크인 |
| **출발** | 방장이 출발 처리하며 **체크인 안 한 사람만 노쇼로 표시** 가능. 출발 10분 전 이후 나가면 **직전 취소** 기록. 출발 30분이 지나도 처리 안 된 방은 자동 정리(2명 이상 체크인 → 출발, 아니면 취소), 3시간 뒤 자동 도착 완료 |
| **정산** | 결제한 사람이 실제 요금과 계좌를 입력 → **탄 거리 비례로 각자 몫 계산**해서 알림 → 송금했어요 / 받았어요 → 정산 완료 |
| **평가** | 도착 완료 후 동승자 👍/👎. 평가 3건 이상부터 매너 점수 공개, 노쇼·직전취소 횟수와 함께 모든 카드에 표시 |

### 신뢰·안전
- **이메일 인증 필수**: 인증해야 방 만들기/참여/알림 등록 가능. 인증번호 10분 만료, 5회 실패 시 재발급, 재발송 1분 제한
- **학교·회사 소속 인증**: `@snu.ac.kr` 같은 기관 메일로 인증하면 소속이 표시되고, **같은 소속끼리만 타는 합승**을 만들 수 있음 (gmail·naver 등 공용 메일 제외)
- **차단 / 신고**: 차단하면 서로의 방이 보이지 않고 같은 방에 참여 불가. 신고는 `reports` 테이블에 쌓임
- 만남 장소·하차 지점·정산 계좌는 **멤버에게만** 공개. 나가거나 노쇼 처리되면 실시간 채널에서도 즉시 제외

### 요금 분담 (거리 비례)
하차 지점마다 경로를 구간으로 나누고, 각 구간 요금은 그 구간에 타고 있던 사람끼리 똑같이 나눕니다.
예) 12,000원, A·B는 끝까지, C는 절반 지점에서 하차 → 앞 절반 6,000원 ÷ 3 + 뒤 절반 6,000원 ÷ 2 → **A 5,000 · B 5,000 · C 2,000원**.
모두 같은 곳에서 내리면 1/N과 같습니다.

### 알림
참여·나감·방장 위임·만남 장소 변경·도착 체크인·출발 10분 전·출발·노쇼·정산 요청/송금/완료·도착 완료·경로 알림·채팅.
- 앱을 보고 있으면 화면 토스트 + 🔔 배지, 닫혀 있으면 **웹 푸시** (PWA 서비스워커)
- 채팅은 그 채팅방을 보고 있는 사람에게는 푸시하지 않음
- 아이폰은 Safari → 공유 → **홈 화면에 추가** 한 앱에서 알림을 켤 수 있음 (iOS 16.4+)

### 장소 / 지도
네이버 장소·주소 검색 자동완성, 현재 위치, 지도에서 선택, 길찾기 실제 요금 (키가 없으면 주요 거점 목록 + 직선거리 추정으로 동작 — 아래 참고)

## 실행

Node.js 22.13 이상이 필요합니다 (내장 `node:sqlite` 사용, 별도 DB 설치 불필요).

```bash
npm install
cp .env.example .env      # 키 입력 (아래 참고)
npm start                 # http://localhost:3000
npm test                  # API·네이버 연동·실시간 채팅 테스트
```

| 환경변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트 (기본 `3000`) |
| `DB_PATH` | SQLite 파일 경로 (기본 `meet.db`) |
| `JWT_SECRET` | 토큰 서명 키. 운영 환경에서는 반드시 설정 |
| `NODE_ENV` | `production` 이면 개발용 인증번호 화면 노출이 꺼짐 (운영 필수) |
| `SMTP_URL` / `MAIL_FROM` | 인증 메일 발송용 SMTP. **없으면 인증번호를 서버 콘솔에 출력**하고, 개발 모드에서는 화면에도 보여줌 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | 웹 푸시 키. 비우면 최초 실행 시 자동 생성해 DB에 저장 |
| `NAVER_MAP_KEY_ID` / `NAVER_MAP_KEY` | 네이버 클라우드 Maps Client ID / Client Secret (선택) |
| `NAVER_SEARCH_CLIENT_ID` / `NAVER_SEARCH_CLIENT_SECRET` | 네이버 개발자센터 검색 API Client ID / Secret (선택) |

> ⚠️ 운영 배포 시: `NODE_ENV=production`, `JWT_SECRET`, `SMTP_URL` 을 반드시 설정하세요. 웹 푸시와 위치 기능은 **HTTPS** 에서만 동작합니다 (localhost 제외).

네이버 키가 없어도 앱은 동작합니다. 이때는 주요 거점 18곳만 검색되고, 지도는 숨겨지며, 요금은 직선거리로 추정합니다.

### 네이버 API 키 발급

**1. 네이버 클라우드 플랫폼 Maps** (지도·주소 검색·길찾기) — https://console.ncloud.com
1. `Services > Application Services > Maps` 에서 **Application 등록**
2. API 선택: **Dynamic Map, Geocoding, Reverse Geocoding, Directions 5**
3. **Web 서비스 URL** 에 앱 주소 등록 (예: `http://localhost:3000`, 운영 도메인) — 등록되지 않은 주소에서는 지도 인증이 실패합니다
4. 발급된 `Client ID` → `NAVER_MAP_KEY_ID`, `Client Secret` → `NAVER_MAP_KEY`

**2. 네이버 개발자센터 검색 API** (장소명 검색) — https://developers.naver.com/apps
1. **애플리케이션 등록** → 사용 API: **검색**
2. `Client ID` → `NAVER_SEARCH_CLIENT_ID`, `Client Secret` → `NAVER_SEARCH_CLIENT_SECRET`

> 주소 검색(Geocoding)은 "테헤란로 152" 같은 **주소**만 찾고, "스타벅스 강남역점" 같은 **장소명**은 검색 API가 찾습니다.
> 둘 다 설정하면 결과를 합쳐서 보여줍니다.

비밀키(`*_KEY`, `*_SECRET`)는 서버에서만 사용하며 브라우저에는 지도 표시용 `NAVER_MAP_KEY_ID`만 전달됩니다.
장소 검색 결과와 역지오코딩 결과는 호출량 절약을 위해 서버에서 10분간 캐시합니다.
Directions 5 등 일부 API는 무료 사용량을 넘으면 과금되니 NCP 콘솔에서 사용량을 확인하세요.

## 구조

```
src/
  index.js          서버 진입점 (+ 1분 주기 작업 시작)
  app.js            서비스 조립, Express/Socket.IO 구성
  db.js             SQLite 스키마 + 기존 DB 자동 마이그레이션
  auth.js           비밀번호 해시, JWT, 인증 미들웨어
  users.js          이메일/소속 인증, 매너 지표, 평가, 차단, 신고
  rides.js          합승 도메인: 검색·매칭, 참여/나가기, 체크인, 노쇼, 정산, 주기 작업
  alerts.js         경로 알림 (조건 맞는 새 합승방 알림)
  notifier.js       알림 허브: 알림함 저장 + 소켓 + 웹 푸시
  push.js           웹 푸시(VAPID) 발송
  mailer.js         인증 메일 발송 (SMTP / 개발용 콘솔)
  geo.js            거리, 경로 투영, 요금 추정, 거리 비례 분담
  naver.js          네이버 API 클라이언트 (장소/주소 검색, 역지오코딩, 길찾기)
  places.js         네이버 미설정 시 사용하는 주요 거점 목록
  realtime.js       Socket.IO (합승 채팅방, 개인 알림 채널)
  routes/           REST API 라우터
public/             모바일 웹앱 (빌드 과정 없는 Vanilla JS, PWA)
  app.js            라우터·부팅   core.js  상태·API·소켓   ui.js  DOM·시트·토스트
  components.js     장소 선택기, 합승 카드, 매너 칩
  screens/          홈(검색), 방 만들기, 합승 상세, 인증, 내 합승·알림·내 정보
  push.js / sw.js   웹 푸시 구독 / 서비스워커
  maps.js           네이버 지도 (선택)
test/               node:test 기반 테스트 (API·흐름·네이버 연동·실시간)
```

## API

`/api/auth/register`, `/api/auth/login`, `/api/config` 외에는 `Authorization: Bearer <token>` 이 필요합니다.

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ email, password, nickname, gender }` → 인증번호 발송 |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | 내 정보 (인증·소속·매너 지표) |
| POST | `/api/auth/verify/send` · `/api/auth/verify` | 인증번호 재발송 / `{ code }` 인증 |
| GET | `/api/config` | 공개 설정 (`naverMapKeyId`, `vapidPublicKey`) |
| GET | `/api/rides?originLat&originLng&destLat&destLng&radiusKm&from&to` | 합승 검색 (시간 범위, 가는 길 매칭) |
| GET | `/api/rides/mine` | 내 합승 |
| POST | `/api/rides` | 생성 `{ origin, destination, departAt, maxSeats, genderPref, meetingPoint, orgOnly, memo }` |
| GET | `/api/rides/:id` | 상세 (멤버에게만 만남 장소·하차 지점·정산 공개) |
| POST | `/api/rides/:id/join` | 참여 `{ dropoff? }` |
| POST | `/api/rides/:id/leave` | 나가기 → `{ lateCancel }` |
| PATCH | `/api/rides/:id/meeting-point` | 만남 장소 변경 (방장) |
| POST | `/api/rides/:id/arrive` | 도착 체크인 |
| PATCH | `/api/rides/:id/status` | `{ status, noShowIds? }` 출발/도착 완료/취소 (방장) |
| POST | `/api/rides/:id/settlement` | 정산 요청 `{ actualFare, account }` (결제한 사람) |
| POST | `/api/rides/:id/settlement/paid` | 송금 완료 `{ userId? }` (본인, 또는 결제자가 수령 확인) |
| POST | `/api/rides/:id/ratings` | 평가 `{ ratings: [{ userId, good }] }` |
| GET | `/api/rides/:id/messages?after=<id>` | 채팅 내역 |
| GET | `/api/users/:id` | 프로필 (매너 지표) |
| POST/DELETE | `/api/users/:id/block` | 차단 / 해제 · `GET /api/users/blocked` |
| POST | `/api/users/:id/report` | 신고 `{ reason, rideId? }` |
| GET · POST | `/api/notifications` · `/api/notifications/read` | 알림함 / 모두 읽음 |
| POST/DELETE | `/api/notifications/push` | 웹 푸시 구독 `{ subscription }` / 해제 `{ endpoint }` |
| GET · POST · DELETE | `/api/alerts` · `/api/alerts/:id` | 경로 알림 목록 / 등록 `{ origin, destination, from, to, radiusKm }` / 삭제 |
| GET | `/api/places/search?q=` · `/api/places/reverse?lat&lng` | 장소 검색 / 좌표 → 주소 |

Socket.IO (`auth: { token }` 로 연결): `ride:subscribe(rideId, ack)`, `chat:send({ rideId, body }, ack)` →
서버 이벤트 `chat:message`, `ride:updated`, `rides:changed`, `notification`.

## 아직 남은 것 (로드맵)

- **본인인증**: 성별은 아직 본인 선택값이라 "동성만" 조건을 완전히 믿을 수 없음 → PASS 휴대폰 본인인증(유료) 연동 필요
- **신고 처리 도구**: 신고는 저장만 됨 → 관리자 화면, 반복 노쇼·신고 사용자 이용 제한
- **간편 송금**: 지금은 계좌 복사 → 토스/카카오페이 송금 링크 연동
- **이용 제한**: 검색·장소 API 사용자별 호출 제한(rate limit)
- **운영 인프라**: PostgreSQL + PostGIS(위치 검색), Redis 어댑터(Socket.IO 다중 서버), 주기 작업 단일 실행 보장
- **법률 검토**: 택시 합승 관련 규정(택시발전법 등) 확인 — 특히 수수료를 받거나 중개 서비스로 운영할 경우
