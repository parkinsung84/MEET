# 🚕 MEET — 택시 합승 매칭 플랫폼

같은 방향으로 가는 사람들을 연결해 택시비를 N분의 1로 나누는 서비스입니다.
현재는 모바일 우선 웹앱(MVP)이며, 서버 API는 이후 네이티브 앱에서도 그대로 사용할 수 있습니다.

## 주요 기능

| 기능 | 설명 |
| --- | --- |
| 회원가입 / 로그인 | 이메일 + 비밀번호(scrypt 해시), JWT 인증 |
| 합승방 만들기 | 출발지·도착지·출발 시간(7일 이내)·정원(2~4명)·성별 조건·메모 |
| 장소 선택 | 네이버 장소명·주소 검색(자동완성), 현재 위치, 지도에서 핀으로 선택 — 전국 어디든 |
| 합승 찾기 | 출발지/도착지 좌표 기준 반경 검색, 경로가 가까운 순 정렬 |
| 요금 분담 계산 | 네이버 길찾기 실제 도로거리·소요시간·예상 택시요금, 현재 인원/만석 기준 1인 부담금 |
| 경로 지도 | 합승방 상세에서 출발·도착 마커와 실제 주행 경로 표시 |
| 참여 / 나가기 | 정원·성별 조건 검사, 방장이 나가면 다음 멤버에게 자동 위임 |
| 실시간 채팅 | Socket.IO, 합승 멤버만 입장 가능 |
| 진행 상태 | 모집 중 → 이동 중 → 완료 (또는 취소), 방장만 변경 가능 |

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
| `NAVER_MAP_KEY_ID` / `NAVER_MAP_KEY` | 네이버 클라우드 Maps Client ID / Client Secret |
| `NAVER_SEARCH_CLIENT_ID` / `NAVER_SEARCH_CLIENT_SECRET` | 네이버 개발자센터 검색 API Client ID / Secret |

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
  index.js          서버 진입점
  app.js            Express 앱 + HTTP 서버 구성
  db.js             SQLite 스키마
  auth.js           비밀번호 해시, JWT, 인증 미들웨어
  rides.js          합승 도메인 로직 (생성/검색/참여/나가기/상태/채팅)
  geo.js            거리 계산, 택시 요금 추정(길찾기 미사용 시), 분담금 계산
  naver.js          네이버 API 클라이언트 (장소/주소 검색, 역지오코딩, 길찾기)
  places.js         네이버 미설정 시 사용하는 주요 거점 목록
  realtime.js       Socket.IO (방 구독, 채팅, 상태 변경 알림)
  routes/           REST API 라우터
public/             모바일 웹 클라이언트 (빌드 과정 없는 Vanilla JS)
  maps.js           네이버 지도 SDK 로드, 경로 지도, 지도에서 위치 선택
test/               node:test 기반 테스트
```

## API

모든 `/api/rides` 요청은 `Authorization: Bearer <token>` 헤더가 필요합니다.

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ email, password, nickname, gender }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | 내 정보 |
| GET | `/api/config` | 공개 설정 (`naverMapKeyId`) |
| GET | `/api/places/search?q=` | 장소명·주소 검색 |
| GET | `/api/places/reverse?lat&lng` | 좌표 → 주소 |
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

- **정산**: 토스페이먼츠·카카오페이 등으로 도착 후 1/N 자동 정산
- **신뢰·안전**: 휴대폰 본인인증, 탑승 후 상호 평가, 신고/차단, 동승자 정보 공유
- **알림**: 참여·출발 임박 푸시 알림 (PWA / FCM)
- **네이티브 앱**: React Native 또는 Flutter 클라이언트 (현재 API 재사용)
- **검색 API 보호**: 사용자별 호출 횟수 제한(rate limit)으로 네이버 API 과금 방지
- **운영 인프라**: PostgreSQL + PostGIS(위치 검색), Redis 어댑터(Socket.IO 다중 서버)
