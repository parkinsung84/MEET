# Render 로 배포하기 (클릭 몇 번)

이 저장소에는 Render 설정 파일(`render.yaml`)이 들어 있어서, Render 에 저장소만 연결하면 서버·HTTPS 주소·데이터 저장 디스크가 한 번에 만들어집니다.
**한 번 연결해 두면 이후에는 GitHub 에 코드가 올라갈 때마다 자동으로 다시 배포됩니다.**

> 화면의 버튼 이름은 Render 가 바꿀 수 있어요. 비슷한 이름을 찾아 누르면 됩니다.

## 1. 가입과 결제수단 (사장님)

1. https://render.com 에서 **GitHub 계정으로 가입**(Sign up with GitHub)
2. 결제수단(카드) 등록 — 데이터를 저장하는 디스크 때문에 **유료 Starter 요금제**가 필요해요. 정확한 월 요금은 결제 화면에서 확인하세요.

## 2. 블루프린트로 만들기

1. 대시보드 오른쪽 위 **New → Blueprint**
2. GitHub 연결 화면에서 **`parkinsung84/MEET` 저장소 접근을 허용**
3. 저장소 선택 → 브랜치는 기본값 그대로(`claude/taxi-sharing-app-vocg28`)
4. 블루프린트 이름 입력 (예: `meet`)
5. **환경변수 입력 칸 4개** (휴대폰 인증 문자 — 네이버 클라우드 SENS):

   | 이름 | 넣을 값 |
   | --- | --- |
   | `NCP_ACCESS_KEY` | NCP 마이페이지 → 인증키 관리의 Access Key |
   | `NCP_SECRET_KEY` | 같은 곳의 Secret Key |
   | `NCP_SENS_SERVICE_ID` | SENS 프로젝트의 SMS 서비스 ID (`ncp:sms:kr:...`) |
   | `SMS_FROM` | SENS 에 등록한 발신번호 (숫자만) |

   **SENS 가 아직 준비 안 됐다면 네 칸 모두 `none`** 이라고 넣으세요. (아래 3번의 시범 운영 모드로 먼저 써 볼 수 있어요)
6. **Apply / Create** → 몇 분 기다리면 배포 완료

`JWT_SECRET`(로그인 보안 키)은 Render 가 자동으로 만들어 줍니다. 키는 채팅이나 코드에 붙여넣지 말고 이 화면에만 넣으세요.

## 3. 접속 확인

- 서비스 화면 위쪽의 **`https://meet-xxxx.onrender.com`** 주소로 접속
- `https://주소/api/health` 가 `{"ok":true}` 이면 정상

### 가입 없이 바로 들어가 보기: 운영자 체험 계정
서비스 → **Environment** → **Add Environment Variable** 로 두 개 추가 → **Save** (자동 재시작)

| Key | Value |
| --- | --- |
| `DEMO_LOGIN_EMAIL` | 로그인에 쓸 이메일 (예: `owner@meet.app` — 실제 메일 주소가 아니어도 됨) |
| `DEMO_LOGIN_PASSWORD` | 8자 이상 비밀번호 (직접 정하세요) |

재시작 후 앱의 **로그인** 탭에서 이 이메일·비밀번호로 들어가면 문자 인증·약관 동의가 끝난 상태예요. **Logs** 에 `[demo] 체험 계정 준비됨` 이 보이면 성공.
선택: `DEMO_LOGIN_GENDER`(`male`/`female`, 기본 male), `DEMO_LOGIN_NICKNAME`(기본 "운영자").
비밀번호를 바꾸려면 값을 바꾸고 저장하면 돼요(기존 로그인은 해제). 필요 없어지면 두 변수를 지우세요 — 계정은 남지만 더 이상 갱신되지 않아요.

### SENS 준비 전: 비공개 시범 운영
서비스 → **Environment** → `SHOW_VERIFICATION_CODES` 를 **`1`** 로 바꾸고 저장 → 가입 화면에 인증번호가 그대로 보여서 문자 없이 가입할 수 있어요.
⚠️ 누구나 아무 번호로 가입할 수 있게 되므로 **지인 테스트용으로만** 쓰고, 공개 전에는 SENS 키를 넣고 **`0`** 으로 되돌리세요.

### 휴대폰 본인확인(PASS) 켜기 — 이름·생년월일·성별까지 확인
포트원(PortOne)을 통해 다날·KCP·KG이니시스 본인인증을 붙여요. 켜지면 가입할 때 실명·생년월일·번호를 직접 입력하지 않고, 가입 후 **본인확인 한 번**으로 끝나요. 문자 인증(SENS)은 자동으로 꺼져요.
1. https://admin.portone.io 가입 → 본인인증 서비스 신청 (다날 휴대폰 본인인증 또는 KG이니시스 통합인증 — **사업자등록증 필요**, 심사 후 계약)
   - 다날은 계약할 때 **CI 제공**과 **휴대폰 번호 제공**을 함께 신청하세요 (1인 1계정·번호 확인에 필요)
2. 포트원 콘솔 → **연동 정보**에서 Store ID, 본인인증 **채널 키**, **V2 API Secret** 확인
3. Render → Environment 에 `PORTONE_STORE_ID`, `PORTONE_CHANNEL_KEY`, `PORTONE_API_SECRET` 저장 (API Secret 은 비밀 — Render 에만)
4. 배포 후 `https://(앱 주소)/api/config` 에 `"identity":{"provider":"portone",...}` 가 보이면 켜진 것
5. 개인정보처리방침(public/legal/privacy.html) 4번 위탁 표의 본인확인기관 이름을 계약한 곳으로 바꾸기

## 4. 이후

- **업데이트**: 제가 GitHub 에 올리면 자동으로 다시 배포돼요 (배포 중 수십 초 정도 접속이 끊길 수 있어요 — 디스크를 쓰는 서비스는 서버 1대로 운영되기 때문)
- **모든 주소·장소 검색 켜기 (중요)**: 키가 없으면 주요 장소 18곳만 검색돼요.
  1. https://console.ncloud.com 로그인 → **Services → Application Services → NAVER API HUB**
     (네이버 검색 API는 개발자센터에서 NAVER API HUB 로 옮겨졌어요. 개발자센터 키는 HUB 에서 안 돼요)
  2. **Application 등록** → 사용할 API 에서 **검색 > 지역(local)** 선택 → 등록
  3. 만든 Application 의 **인증 정보** 에서 **Client ID / Client Secret** 확인
  4. Render → Environment 에 `NAVER_APIHUB_KEY_ID` = Client ID, `NAVER_APIHUB_KEY` = Client Secret 저장 → 자동 재배포
     (키는 Render 에만 넣고 채팅·메신저에 붙여넣지 마세요)
  - 예전에 개발자센터에서 받은 키가 있다면 `NAVER_SEARCH_CLIENT_ID` / `NAVER_SEARCH_CLIENT_SECRET` 도 계속 돼요 (2027-06-30까지, HUB 실패 시 대체용)
- **지도 그림 켜기 (지도에서 위치 고르기·합승방 핀·경로 지도)**: 키가 없으면 글자로만 찾아요.
  1. https://console.ncloud.com → **Services → Application Services → Maps** → **Application 등록**
  2. API 선택: **Dynamic Map**, **Geocoding**, **Reverse Geocoding** (Directions 5 는 유료라 빼도 돼요)
  3. **Web 서비스 URL** 에 Render 주소(`https://meet-xxxx.onrender.com`, 내 도메인이 있으면 그것도) 등록 — 안 하면 지도가 안 떠요
  4. 발급된 Client ID → `NAVER_MAP_KEY_ID`, Client Secret → `NAVER_MAP_KEY`, 그리고 `NAVER_DIRECTIONS` = `0` (길찾기를 빼서 유료 호출 막기)
  - Maps 는 대표 계정에 API별 월 무료 이용량이 있고 넘으면 종량 요금이에요. NCP 콘솔에서 요금 알림을 걸어 두세요
- **선택 기능 켜기**: Environment 에 추가 — 네이버 지도(`NAVER_MAP_KEY_ID`, `NAVER_MAP_KEY`), 장소 검색(`NAVER_APIHUB_KEY_ID`, `NAVER_APIHUB_KEY`), 소속 인증 메일(`SMTP_URL`), 음성 통화 중계(`TURN_URLS`, `TURN_SECRET`) — 설명은 `.env.example`
- **내 도메인 연결(선택)**: 서비스 → Settings → Custom Domains
- **백업**: 데이터는 `/data` 디스크에 있어요. Render 대시보드의 디스크 스냅샷(자동 백업) 기능을 확인해 두시고, 필요하면 서비스 → Shell 에서 `node scripts/backup.js` 로 수동 백업할 수 있어요 (`BACKUP_DIR=/data/backups`)
- 공개 전 체크리스트(실제 폰으로 문자·푸시·통화 확인, 약관 운영자 정보, 위치기반서비스 신고)는 [DEPLOY.md](DEPLOY.md) 3·4번을 그대로 따르세요
