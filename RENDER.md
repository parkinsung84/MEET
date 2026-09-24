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

### SENS 준비 전: 비공개 시범 운영
서비스 → **Environment** → `SHOW_VERIFICATION_CODES` 를 **`1`** 로 바꾸고 저장 → 가입 화면에 인증번호가 그대로 보여서 문자 없이 가입할 수 있어요.
⚠️ 누구나 아무 번호로 가입할 수 있게 되므로 **지인 테스트용으로만** 쓰고, 공개 전에는 SENS 키를 넣고 **`0`** 으로 되돌리세요.

## 4. 이후

- **업데이트**: 제가 GitHub 에 올리면 자동으로 다시 배포돼요 (배포 중 수십 초 정도 접속이 끊길 수 있어요 — 디스크를 쓰는 서비스는 서버 1대로 운영되기 때문)
- **선택 기능 켜기**: Environment 에 추가 — 네이버 지도(`NAVER_MAP_KEY_ID`, `NAVER_MAP_KEY`), 장소 검색(`NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET`), 소속 인증 메일(`SMTP_URL`), 음성 통화 중계(`TURN_URLS`, `TURN_SECRET`) — 설명은 `.env.example`
- 네이버 지도를 켜면 NCP 콘솔 Maps 앱의 **Web 서비스 URL** 에 `https://meet-xxxx.onrender.com` 등록
- **내 도메인 연결(선택)**: 서비스 → Settings → Custom Domains
- **백업**: 데이터는 `/data` 디스크에 있어요. Render 대시보드의 디스크 스냅샷(자동 백업) 기능을 확인해 두시고, 필요하면 서비스 → Shell 에서 `node scripts/backup.js` 로 수동 백업할 수 있어요 (`BACKUP_DIR=/data/backups`)
- 공개 전 체크리스트(실제 폰으로 문자·푸시·통화 확인, 약관 운영자 정보, 위치기반서비스 신고)는 [DEPLOY.md](DEPLOY.md) 3·4번을 그대로 따르세요
