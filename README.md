# 🚕 MEET — 택시 합승 매칭 플랫폼

같은 방향으로 가는 사람들을 연결해 택시비를 N분의 1로 나누는 서비스입니다.

**중심 기능: 🔁 정기 노선 (출퇴근 택시 크루)** — "분당 → 강남, 월~금 08:00"처럼 매일 타는 노선을 올리면
로그인하지 않은 사람도 목록·공유 링크(`/c/:id`, 카톡 미리보기 지원)로 보고 참여할 수 있습니다.
목록에는 대략적인 동네만, 정확한 위치·만남 장소·크루 채팅은 멤버에게만 보입니다.
운행하는 날마다 출발 1시간 전에 멤버들로 합승방이 자동으로 열려 (못 타는 사람은 그 방에서 나가기),
아래의 당일 합승 기능(체크인·차량번호·정산·긴급신고)을 그대로 씁니다. 당일 합승은 `#/rides`에서 계속 이용할 수 있습니다.
현재는 모바일 우선 웹앱(MVP)이며, 서버 API는 이후 네이티브 앱에서도 그대로 사용할 수 있습니다.

## 합승 흐름

```
가입(본인정보·휴대폰 인증) ──▶ 🤖 자동 매칭 / 찾기 ──▶ 문의 ──▶ 참여 ──▶ 만나기(📞 통화) ──▶ 출발 ──▶ 정산 ──▶ 평가
```

| 단계 | 기능 |
| --- | --- |
| **🤖 자동 매칭** | 경로와 출발 가능 시간(최대 3시간 범위)만 올리면 끝 — ① 맞는 방이 있으면 **바로 자동 참여**(가는 길 하차 포함) ② 없으면 조건 맞는 **다른 요청과 짝지어 방 자동 생성**(먼저 기다린 사람이 방장, 그 출발지가 만남 장소) ③ 그래도 없으면 대기하다가 새 방·새 요청이 생기면 매칭, 시간이 지나면 만료 알림. 한 사람당 요청 하나 |
| **찾기** | ⚡ 지금 바로(30분 안 출발) / 🕐 시간 지정(±30분) 검색. 출발지·도착지 반경 매칭에 더해, 내 도착지가 경로 중간이면 **"가는 길에 하차"** 로도 매칭. 경로 차이 + 시간 차이가 작은 순 정렬, 카드마다 **내 예상 부담금** 표시 |
| | 카드마다 **"혼자 11,600원 → 내 몫 3,870원 · 💰 7,730원 절약"**, 검색하면 **"지금 이 경로를 N명이 찾고 있어요"**(매칭 대기 + 경로 알림 수) |
| | 결과가 없으면 **자동 매칭 신청** · 이 조건으로 방 만들기 · 🔔 경로 알림 받기 |
| **비슷한 방 방지** | 방을 만들기 직전 출발·도착 1km·±20분 안의 **비슷한 방을 먼저 보여줌**. 이미 비슷한 방이 둘 생기면 기존 방장에게 알림, 방장은 **"이 방으로 합치기"** 로 멤버 전원을 옮김 (자리·성별·차단 조건 확인, 하차 지점 다시 계산) |
| **문의** | 참여 전에 **💬 먼저 물어보기** — 방 멤버들과 1:1 문의 대화로 짐, 늦을 수 있는지, 하차 위치 등을 조율. 문의자는 자기 대화만, 멤버는 문의 목록에서 모든 문의를 보고 누구나 답장 |
| **성별** | 기본은 **성별 무관** 모집, 방장이 원하면 **같은 성별만** 설정 (동승자 성별은 항상 표시). 앱은 동행만 연결하고 택시는 이용자가 직접 호출 |
| **참여** | 최종 도착지까지 / 가는 길에 먼저 내리기 선택. 성별·소속 조건, 차단 관계, 만석, **같은 시간대 중복 참여**(노쇼 원인)를 서버에서 차단 |
| **탑승 전 안내** | 💺 **좌석** 자동 배정(조수석 → 뒷좌석 오른쪽 → 왼쪽 → 가운데), 탑승 전까지 빈 자리로 이동. 참여할 때·출발 전 화면·10분 전 알림에서 **긴급신고 방법 안내** |
| **만나기** | 방장이 정한 **만남 장소**(멤버에게만 공개, 변경 시 알림), 출발 10분 전 알림, 출발 1시간 전부터 **📍 도착했어요** 체크인 |
| **탑승** | 누구나 **🚕 택시 차량번호**(차종·색상 메모)를 기록 → 동승자에게 알림. **🔗 안심 공유 링크**로 가족·지인이 로그인 없이 경로·출발 시간·차량번호·탑승자(닉네임·성별)를 보고 112/119 바로 걸기 (도착 12시간 뒤 자동 만료, 직접 해제 가능) |
| **출발** | 방장이 출발 처리하며 **체크인 안 한 사람만 노쇼로 표시** 가능. 출발 10분 전 이후 나가면 **직전 취소** 기록. 출발 30분이 지나도 처리 안 된 방은 자동 정리(2명 이상 체크인 → 출발, 아니면 취소), 3시간 뒤 자동 도착 완료 |
| **정산** | 결제한 사람이 실제 요금과 계좌를 입력 → **탄 거리 비례로 각자 몫 계산**해서 알림 → 송금했어요 / 받았어요 → 정산 완료 |
| **평가** | 도착 완료 후 동승자 👍/👎. 평가 3건 이상부터 매너 점수 공개, 노쇼·직전취소 횟수와 함께 모든 카드에 표시 |

### 신뢰·안전
- **가입 시 본인정보 필수**: 실명, 생년월일, 성별, 휴대폰 번호. **만 19세 이상**만 가입 가능 (`src/users.js` 의 `MIN_AGE`)
- **휴대폰 문자 인증 필수**: 인증해야 방 만들기/참여/문의/알림 등록 가능. **인증된 번호 하나당 계정 하나** (재가입으로 노쇼·신고 기록 세탁 방지). 인증번호 10분 만료, 5회 실패 시 재발급, 재발송 1분 대기, 하루 발송 한도(번호별 5회·계정별 10회)
- **본인정보 비공개**: 실명·생년월일·휴대폰 번호는 본인에게만 보이고(번호도 가려서 표시), 동승자에게는 **닉네임·성별**만 공개
- **성별 표시**: 합승 카드의 방장, 탑승자 목록, 참여 문의, 통화 화면에 성별 표시
- **학교·회사 소속 인증 (선택)**: `@snu.ac.kr` 같은 기관 메일이면 내 정보에서 이메일 인증 → 소속 표시 + **같은 소속끼리만 타는 합승** (gmail·naver 등 공용 메일 제외)
- **약관·개인정보 동의**: 가입 시 [필수] 만 19세 이상 · 이용약관 · 개인정보 수집·이용(항목·목적·보유기간 고지) · 위치기반서비스 약관. 약관 버전(`src/legal.js`)을 올리면 기존 회원도 다음 접속 때 재동의. 약관 초안: `public/legal/` (**법률 검토 필요**)
- **회원 탈퇴**: 내 정보 → 회원 탈퇴 (비밀번호 확인). 개인정보 즉시 파기, 합승 기록·채팅은 '탈퇴한 사용자'로 익명화, 노쇼·직전취소 횟수만 휴대폰 번호 해시와 함께 1년 보관(같은 번호로 재가입하면 승계). 진행 중인 합승·미송금 정산이 있으면 먼저 정리
- **계정 보안**: 로그인 실패 제한(계정별 15분 5회, IP별 20회), 가입·비밀번호 찾기 IP별 제한, 비밀번호 찾기(인증된 휴대폰으로 문자 — 휴대폰 인증 전 계정은 이메일, 가입 여부 비노출), 비밀번호 변경, **모든 기기에서 로그아웃**(토큰 버전 — 비밀번호 변경·재설정·탈퇴 시에도 기존 로그인과 실시간 연결 즉시 해제), 보안 헤더(HSTS 등)
- **차단 / 신고**: 차단하면 서로의 방이 보이지 않고 같은 방 참여·통화 불가. 신고는 `reports` 테이블에 쌓임
- 참여 전 문의는 **참여 조건(성별·소속·차단)을 만족하는 인증 사용자만** 가능하고, 답장을 받기 전에는 연속 5개까지만 보낼 수 있음 (도배 방지). 대화는 문의자와 방 멤버만 볼 수 있음
- 만남 장소·하차 지점·정산 계좌는 **멤버에게만** 공개. 나가거나 노쇼 처리되면 실시간 채널에서도 즉시 제외

### 요금 분담 (거리 비례)
하차 지점마다 경로를 구간으로 나누고, 각 구간 요금은 그 구간에 타고 있던 사람끼리 똑같이 나눕니다.
예) 12,000원, A·B는 끝까지, C는 절반 지점에서 하차 → 앞 절반 6,000원 ÷ 3 + 뒤 절반 6,000원 ÷ 2 → **A 5,000 · B 5,000 · C 2,000원**.
모두 같은 곳에서 내리면 1/N과 같습니다.

### 🚨 긴급 신고
진행 중인 합승의 멤버에게 항상 보이는 **🚨 긴급** 버튼 → **112 전화**, **112 문자**(차량번호·경로·현재 위치 자동 입력 — 위치는 문자로만 가고 서버에 저장하지 않음), 119. 누르면 동승자에게 긴급 알림이 가고 기록(`ride_emergencies`)이 남습니다.

### 📍 위치정보 이용·제공 사실 기록 (위치정보법 제16조)
현재 위치 → 주소 변환, 위치 기반 검색, 합승방 생성, 하차 지점 설정(동승자에게 제공), 경로 알림, 안심 공유 조회(링크 수신자에게 제공)를 할 때마다 **일시·목적·제공받는 자**를 자동 기록 (좌표는 기록하지 않음), 1년 보관 후 파기. 본인은 **내 정보 → 위치정보 이용 내역**에서 열람.

### 탑승자끼리 음성 통화 📞
전화번호를 주고받지 않고 앱 안에서 통화합니다 (WebRTC — 보이스톡처럼 인터넷으로 연결).
- 탑승자 목록의 **📞 통화** → 상대방 모든 기기에서 벨(소리·진동) → 받기/거절. 앱이 꺼져 있으면 푸시로 알림
- 같은 합승의 멤버끼리, **모집 중·이동 중**일 때만 가능. 차단 관계면 불가, 통화 중이면 "상대방이 통화 중"
- 30초 안 받으면 **부재중 통화** 알림, 음소거, 통화 시간 표시, 한 기기에서 받으면 다른 기기 벨은 멈춤
- 음성은 브라우저끼리 직접 오가고 서버는 연결 협상 메시지만 중계 (녹음·저장 없음)
- **HTTPS 필수** (마이크 권한). 모바일 데이터망 등 일부 환경에서는 **TURN 서버**가 있어야 연결됩니다 — 아래 환경변수 참고

### 알림
참여 문의/답장·참여·나감·방장 위임·만남 장소 변경·도착 체크인·출발 10분 전·출발·노쇼·정산 요청/송금/완료·도착 완료·경로 알림·채팅.
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
| `DOMAIN` | 배포 도메인 (docker compose 의 Caddy 가 HTTPS 인증서 자동 발급) |
| `TRUST_PROXY` | 프록시 뒤에서 실행할 때 `1` (실제 접속 IP로 호출 제한) — compose 에서는 자동 |
| `PORT` | 서버 포트 (기본 `3000`) |
| `DB_PATH` | SQLite 파일 경로 (기본 `meet.db`) |
| `JWT_SECRET` | 토큰 서명 키. 운영 환경에서는 반드시 설정 |
| `NODE_ENV` | `production` 이면 개발용 인증번호 화면 노출이 꺼짐 (운영 필수) |
| `NCP_ACCESS_KEY` / `NCP_SECRET_KEY` / `NCP_SENS_SERVICE_ID` / `SMS_FROM` | 휴대폰 인증문자 발송 (네이버 클라우드 SENS). **없으면 인증번호를 서버 콘솔에 출력**하고, 개발 모드에서는 화면에도 보여줌 |
| `PORTONE_STORE_ID` / `PORTONE_CHANNEL_KEY` / `PORTONE_API_SECRET` | 휴대폰 본인확인(PASS 등, 포트원 V2). 설정하면 문자 인증 대신 본인확인으로 실명·생년월일·성별·번호를 확정 (CI/DI 해시로 1인 1계정) |
| `DEMO_LOGIN_EMAIL` / `DEMO_LOGIN_PASSWORD` | 운영자 체험 계정 — 서버 시작 때 가입·문자 인증 없이 로그인 가능한 계정을 만들거나 비밀번호 갱신 (선택: `DEMO_LOGIN_GENDER`, `DEMO_LOGIN_NICKNAME`) |
| `SHOW_VERIFICATION_CODES` | `1` 이면 운영 모드에서도 인증번호를 화면에 표시 — SENS 준비 전 **비공개 시범 운영 전용** |
| `SMTP_URL` / `MAIL_FROM` | 소속(학교·회사) 인증 메일 발송용 SMTP. 없으면 콘솔 출력 |
| `TURN_URLS` + `TURN_SECRET` (또는 `TURN_USERNAME`/`TURN_CREDENTIAL`) | 음성 통화 중계(TURN) 서버. `TURN_SECRET` 이면 coturn `use-auth-secret` 방식으로 사용자별 1시간 임시 계정 발급 |
| `STUN_URLS` | STUN 서버 (기본 `stun:stun.l.google.com:19302`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | 웹 푸시 키. 비우면 최초 실행 시 자동 생성해 DB에 저장 |
| `NAVER_MAP_KEY_ID` / `NAVER_MAP_KEY` | 네이버 클라우드 Maps Client ID / Client Secret (선택) |
| `NAVER_APIHUB_KEY_ID` / `NAVER_APIHUB_KEY` | NAVER API HUB 검색(지역) Client ID / Secret (선택, 장소명 검색) |
| `NAVER_SEARCH_CLIENT_ID` / `NAVER_SEARCH_CLIENT_SECRET` | (예전) 네이버 개발자센터 검색 키 — 2027-06-30까지 동작, HUB 실패 시 대체 |
| `NAVER_DIRECTIONS` | `0` 이면 유료 길찾기(Directions 5)를 쓰지 않고 직선거리로 요금 추정 (지도·주소 검색은 그대로) |

> 🚀 **가장 쉬운 배포: [RENDER.md](RENDER.md)** (저장소 연결 → 자동 배포·HTTPS·디스크). 서버를 직접 운영하려면 [DEPLOY.md](DEPLOY.md) — Docker + Caddy(자동 HTTPS) + 매일 백업 + (선택) coturn, 공개 전 실제 기기 확인 체크리스트 포함
>
> ⚠️ 운영 배포 시: `NODE_ENV=production`, `JWT_SECRET`, SENS 문자 설정을 반드시 하세요 (없으면 아무도 가입을 마칠 수 없음). 웹 푸시·위치·음성 통화는 **HTTPS** 에서만 동작합니다 (localhost 제외). 음성 통화를 안정적으로 쓰려면 TURN 서버(coturn 직접 운영 또는 유료 서비스)가 필요합니다.

네이버 키가 없어도 앱은 동작합니다. 이때는 주요 거점 18곳만 검색되고, 지도는 숨겨지며, 요금은 직선거리로 추정합니다.

### 네이버 API 키 발급

**1. 네이버 클라우드 플랫폼 Maps** (지도·주소 검색·길찾기) — https://console.ncloud.com
1. `Services > Application Services > Maps` 에서 **Application 등록**
2. API 선택: **Dynamic Map, Geocoding, Reverse Geocoding, Directions 5**
3. **Web 서비스 URL** 에 앱 주소 등록 (예: `http://localhost:3000`, 운영 도메인) — 등록되지 않은 주소에서는 지도 인증이 실패합니다
4. 발급된 `Client ID` → `NAVER_MAP_KEY_ID`, `Client Secret` → `NAVER_MAP_KEY`

**2. NAVER API HUB 검색** (장소명 검색) — https://console.ncloud.com
네이버 검색 API는 개발자센터에서 NCP 의 NAVER API HUB 로 이전됐습니다 (개발자센터 키는 HUB 에서 동작하지 않음).
1. `Services > Application Services > NAVER API HUB` 에서 **Application 등록** → API: **검색 > 지역**
2. Application **인증 정보** 의 `Client ID` → `NAVER_APIHUB_KEY_ID`, `Client Secret` → `NAVER_APIHUB_KEY`
3. 예전 개발자센터 키(`NAVER_SEARCH_CLIENT_ID` / `NAVER_SEARCH_CLIENT_SECRET`)가 있으면 HUB 실패 시 대체로 사용

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
  auth.js           비밀번호 해시, 로그인 토큰(버전 기반 강제 만료)
  account.js        비밀번호 변경·찾기, 모든 기기 로그아웃, 회원 탈퇴(개인정보 파기·익명화)
  legal.js          약관·동의 항목과 버전
  location-log.js   위치정보 이용·제공 사실 확인자료 기록 (위치정보법 제16조)
  ratelimit.js      로그인·가입 호출 제한
  users.js          본인정보·휴대폰 인증, 약관 동의, 소속 이메일 인증, 매너 지표, 평가, 차단, 신고
  sms.js            인증문자 발송 (네이버 클라우드 SENS / 개발용 콘솔)
  calls.js          탑승자 음성 통화 신호 중계 (WebRTC), TURN 임시 계정
  rides.js          합승 도메인: 검색·매칭, 참여/나가기, 체크인, 노쇼, 정산, 주기 작업
  matcher.js        자동 매칭 (요청 → 기존 방 참여 / 요청끼리 방 생성 / 대기·만료), 경로 수요 집계
  alerts.js         경로 알림 (조건 맞는 새 합승방 알림)
  inquiries.js      참여 전 문의 (문의자별 1:1 대화, 멤버 누구나 답장)
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
  call.js           음성 통화 (마이크, WebRTC 연결, 벨소리, 통화 화면)
  maps.js           네이버 지도 (선택)
  legal/            이용약관 · 개인정보처리방침 · 위치기반서비스 약관 (초안)
  share.html        안심 공유 페이지 (로그인 불필요)
scripts/backup.js   SQLite 온라인 백업
deploy/Caddyfile    HTTPS 리버스 프록시 설정
Dockerfile, docker-compose.yml, DEPLOY.md   서버 배포
test/               node:test 기반 테스트 (API·흐름·계정·통화·네이버 연동·실시간·백업)
```

## API

`/api/auth/register`, `/api/auth/login`, `/api/config` 외에는 `Authorization: Bearer <token>` 이 필요합니다.

| Method | Path | 설명 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ email, password, nickname, gender, name, birthDate, phone }` → 인증문자 발송 |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/me` | 내 정보 (본인정보·인증·소속·매너 지표) |
| PUT | `/api/auth/identity` | 본인정보 입력/수정 `{ name, birthDate, phone }` (휴대폰 인증 전까지) → 인증문자 발송 |
| POST | `/api/auth/phone/send` · `/api/auth/phone/verify` | 인증문자 재발송 / `{ code }` 휴대폰 인증 |
| POST | `/api/auth/email/send` · `/api/auth/email/verify` | 학교·회사 소속 이메일 인증 (선택) |
| POST | `/api/auth/consents` | 약관 (재)동의 `{ kinds: ['age','terms','privacy','location'] }` |
| POST | `/api/auth/password/forgot` · `/api/auth/password/reset` | 비밀번호 찾기 `{ email }` / 재설정 `{ email, code, password }` |
| POST | `/api/auth/password` | 비밀번호 변경 `{ currentPassword, newPassword }` → 새 토큰 |
| POST | `/api/auth/logout-all` | 모든 기기에서 로그아웃 |
| DELETE | `/api/auth/me` | 회원 탈퇴 `{ password }` |
| GET | `/api/config` | 공개 설정 (`naverMapKeyId`, `vapidPublicKey`) |
| GET | `/api/rides?originLat&originLng&destLat&destLng&radiusKm&from&to` | 합승 검색 (시간 범위, 가는 길 매칭) → `{ rides, demand }` |
| GET | `/api/rides/mine` | 내 합승 |
| POST · GET · DELETE | `/api/matching` | 자동 매칭 요청 `{ origin, destination, from, to, radiusKm?, orgOnly? }` / 내 요청 상태 / 취소 |
| GET | `/api/rides/similar?originLat&originLng&destLat&destLng&departAt` | 방 만들기 전 비슷한 방 확인 |
| GET | `/api/rides/:id/similar` | 이 방과 합칠 수 있는 방 |
| POST | `/api/rides/:id/merge` | 방 합치기 `{ targetId }` (방장) |
| POST | `/api/rides` | 생성 `{ origin, destination, departAt, maxSeats, taxiType: 'standard' \| 'large', genderPref, meetingPoint, orgOnly, memo }` |
| GET | `/api/rides/:id` | 상세 (멤버에게만 만남 장소·하차 지점·정산 공개) |
| POST | `/api/rides/:id/join` | 참여 `{ dropoff? }` |
| POST | `/api/rides/:id/leave` | 나가기 → `{ lateCancel }` |
| PATCH | `/api/rides/:id/meeting-point` | 만남 장소 변경 (방장) |
| POST | `/api/rides/:id/arrive` | 도착 체크인 |
| PATCH | `/api/rides/:id/status` | `{ status, noShowIds? }` 출발/도착 완료/취소 (방장) |
| POST | `/api/rides/:id/settlement` | 정산 요청 `{ actualFare, account }` (결제한 사람) |
| POST | `/api/rides/:id/settlement/paid` | 송금 완료 `{ userId? }` (본인, 또는 결제자가 수령 확인) |
| POST | `/api/rides/:id/ratings` | 평가 `{ ratings: [{ userId, good }] }` |
| PUT | `/api/rides/:id/taxi` | 택시 차량번호 기록 `{ plate, note? }` |
| PUT | `/api/rides/:id/seat` | 좌석 변경 `{ seat: 'front' \| 'rear_right' \| 'rear_left' \| 'rear_middle' }` (탑승 전) |
| POST | `/api/rides/:id/emergency` | 긴급 신고 기록 + 동승자 알림 → 112 문자용 차량번호·경로 |
| GET | `/api/me/location-logs` | 내 위치정보 이용·제공 사실 확인자료 |
| POST · DELETE | `/api/rides/:id/share` | 안심 공유 링크 발급 / 내 링크 해제 |
| GET | `/api/share/:token` | 안심 공유 조회 (로그인 불필요) |
| GET | `/api/rides/:id/messages?after=<id>` | 채팅 내역 (멤버) |
| GET | `/api/rides/:id/inquiries` | 참여 문의 목록 (멤버) |
| GET · POST | `/api/rides/:id/inquiries/:guestId` | 문의 대화 보기 / 보내기 `{ body }` (문의자 본인 또는 멤버) |
| GET | `/api/users/:id` | 프로필 (매너 지표) |
| POST/DELETE | `/api/users/:id/block` | 차단 / 해제 · `GET /api/users/blocked` |
| POST | `/api/users/:id/report` | 신고 `{ reason, rideId? }` |
| GET · POST | `/api/notifications` · `/api/notifications/read` | 알림함 / 모두 읽음 |
| POST/DELETE | `/api/notifications/push` | 웹 푸시 구독 `{ subscription }` / 해제 `{ endpoint }` |
| GET · POST · DELETE | `/api/alerts` · `/api/alerts/:id` | 경로 알림 목록 / 등록 `{ origin, destination, from, to, radiusKm }` / 삭제 |
| GET | `/api/places/search?q=` · `/api/places/reverse?lat&lng` | 장소 검색 / 좌표 → 주소 |

Socket.IO (`auth: { token }` 로 연결): `ride:subscribe(rideId, ack)`, `chat:send({ rideId, body }, ack)` →
`inquiry:subscribe(rideId, ack)` (문의자),
음성 통화 `call:invite({ rideId, to }, ack)`, `call:accept({ callId }, ack)`, `call:decline`, `call:signal({ callId, data })`, `call:end` →
서버 이벤트 `chat:message`, `inquiry:message`, `ride:updated`, `rides:changed`, `notification`,
`call:incoming`, `call:accepted`, `call:signal`, `call:ended`.

## 아직 남은 것 (로드맵)

- **공개 전 필수**: 약관 초안의 운영자 정보 채우기 + **합승 중개 방식의 적법성 법률 상담**(이 앱은 택시를 호출하지 않고 승객끼리 연결 — 2022년 플랫폼택시 합승 기준의 적용 여부 확인), 위치기반서비스사업 신고([준비 자료](docs/위치기반서비스-신고-준비.md)), 실제 서버 배포 후 문자·푸시·통화 실기기 확인 ([DEPLOY.md](DEPLOY.md) 체크리스트)
- **통신사 본인인증**: 지금의 문자 인증은 "그 번호를 가진 사람"까지만 확인하고, 실명·생년월일·성별은 본인이 입력한 값 → "동성만" 조건을 완전히 믿으려면 PASS 본인인증(포트원 등, 건당 유료)으로 이 정보를 통신사에서 받아와야 함
- **실시간 위치 공유**: 이동 중 지인에게 실시간 위치 공유 (지금은 경로·차량번호만)
- **신고 처리 도구**: 신고는 저장만 됨 → 관리자 화면, 반복 노쇼·신고 사용자 이용 제한
- **간편 송금**: 지금은 계좌 복사 → 토스/카카오페이 송금 링크 연동
- **운영 인프라**: 서버 여러 대로 늘릴 때 PostgreSQL + PostGIS, Redis(Socket.IO·호출 제한·통화 상태), 오류 추적·모니터링
