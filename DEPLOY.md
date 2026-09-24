# MEET 배포 가이드

> 💡 **가장 쉬운 방법은 Render — [RENDER.md](RENDER.md)** (저장소 연결만 하면 자동 배포). 아래는 서버를 직접 빌려 운영하는 방법입니다.

서버 한 대에 Docker 로 올리는 방법입니다. **HTTPS 인증서는 Caddy 가 자동으로 발급·갱신**하고, DB 는 매일 자동 백업됩니다.

```
인터넷 ──443(HTTPS)──▶ Caddy ──▶ MEET 앱(3000) ──▶ SQLite (/data 볼륨)
                                              └─ backup: 매일 ./backups 로 복사
(선택) 음성 통화 중계: coturn (3478, 49160-49200/udp)
```

## 1. 준비물

| 항목 | 설명 |
| --- | --- |
| 서버 | Ubuntu 22.04+ / 1 vCPU · 2GB RAM 이상 (예: 네이버 클라우드 Server, AWS Lightsail, 카페24 등) |
| 도메인 | 예: `meet.example.com` — DNS **A 레코드**를 서버 공인 IP 로 설정 |
| 방화벽 | **80, 443 (TCP)**, 443/UDP. 음성 통화 중계를 쓰면 **3478 (TCP/UDP)**, **49160-49200 (UDP)** |
| 문자 인증 | 네이버 클라우드 SENS 프로젝트 + 발신번호 등록 (**필수** — 없으면 아무도 가입을 마칠 수 없음) |

## 2. 설치

```bash
# Docker 설치 (Ubuntu)
curl -fsSL https://get.docker.com | sudo sh

# 코드 받기
git clone <저장소 주소> meet && cd meet

# 설정 파일
cp .env.example .env
nano .env
```

`.env` 에서 **반드시** 채울 값:

```bash
DOMAIN=meet.example.com          # 위에서 연결한 도메인
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32 로 만든 값)
NCP_ACCESS_KEY=... NCP_SECRET_KEY=... NCP_SENS_SERVICE_ID=... SMS_FROM=...
```

선택: `SMTP_URL`(소속 이메일 인증·비밀번호 찾기 메일), 네이버 지도 키, `TURN_SECRET`(음성 통화 중계).

```bash
docker compose up -d --build                 # 앱 + HTTPS + 백업
docker compose --profile turn up -d --build  # 음성 통화 중계(coturn)까지
```

1~2분 뒤 `https://도메인/api/health` 가 `{"ok":true}` 를 돌려주면 성공입니다.

음성 통화 중계를 켰다면 `.env` 에 다음도 넣고 `docker compose up -d` 로 다시 시작하세요.

```bash
TURN_URLS=turn:meet.example.com:3478?transport=udp,turn:meet.example.com:3478?transport=tcp
TURN_SECRET=(openssl rand -hex 32)   # coturn 과 앱이 같은 값을 사용
```

## 3. 공개 전 실제 기기 확인 체크리스트

이 항목들은 개발 환경에서 가짜 서버로만 테스트되었습니다. **실제 폰으로 한 번씩 확인하세요.**

- [ ] 가입 → **인증문자가 실제로 도착**하는지 (SENS)
- [ ] 비밀번호 찾기 문자 도착 → 재설정
- [ ] 안드로이드 크롬: 내 정보 → 알림 켜기 → 앱을 닫은 상태에서 채팅·참여 알림이 오는지
- [ ] 아이폰: Safari → 공유 → **홈 화면에 추가** → 그 앱에서 알림 켜기 (iOS 16.4+)
- [ ] 음성 통화: **서로 다른 통신사 LTE/5G** 폰 두 대로 걸고 받기 (TURN 없이 안 되면 TURN 켜기)
- [ ] 현재 위치 버튼, 안심 공유 링크를 카카오톡으로 보내서 열어보기
- [ ] 네이버 지도를 쓴다면 NCP 콘솔 Maps 앱의 **Web 서비스 URL** 에 `https://도메인` 등록

## 4. 공개 전 법적 준비

- [ ] `public/legal/` 의 이용약관·개인정보처리방침·위치기반서비스 약관 **초안의 빨간 표시 부분**(운영자·책임자 정보)을 채우고 **법률 검토**
- [ ] 위치기반서비스사업 신고 — 소상공인·1인 창조기업은 **사업 개시 후 1개월 이내** (준비 자료: [docs/위치기반서비스-신고-준비.md](docs/위치기반서비스-신고-준비.md))
- [ ] 위치정보 이용·제공 사실 확인자료 기록 기능 (현재 미구현 — 약관에 표시해 둠)
- [ ] 사업자 등록, 택시 합승 관련 규정 검토

약관을 고치면 `src/legal.js` 의 `version` 을 올리세요. 기존 회원은 다음 이용 때 다시 동의하게 됩니다.

## 5. 운영

```bash
docker compose logs -f app          # 앱 로그 (인증문자 발송 오류 등)
docker compose ps                   # 상태 (app 이 healthy 인지)
git pull && docker compose up -d --build   # 업데이트 (DB 는 볼륨에 유지, 새 컬럼은 자동 추가)
```

### 백업과 복원

- 매일 `./backups/meet-날짜.db` 로 저장, 최근 14개 보관. **서버 밖(다른 저장소)에도 주기적으로 복사**해 두세요.
- 지금 바로 백업: `docker compose run --rm backup node --no-warnings=ExperimentalWarning scripts/backup.js`
- 복원:
  ```bash
  docker compose stop app
  docker compose run --rm -v "$PWD/backups:/backups" --user 0 app sh -c \
    "rm -f /data/meet.db-wal /data/meet.db-shm && cp /backups/meet-복원할파일.db /data/meet.db && chown node:node /data/meet.db"
  docker compose start app
  ```

## 6. 알아둘 한계

- **서버 한 대 기준**입니다. 통화 상태·로그인 시도 제한은 메모리에, DB 는 SQLite 파일에 있어 서버를 여러 대로 늘리려면 PostgreSQL·Redis 로 바꿔야 합니다. 초기(수천 명 규모)에는 한 대로 충분합니다.
- 서버를 재시작하면 진행 중인 음성 통화가 끊기고, 로그인 시도 제한 기록이 초기화됩니다.
