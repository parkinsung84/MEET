import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  gender        TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     INTEGER NOT NULL REFERENCES users(id),
  origin_name TEXT NOT NULL,
  origin_lat  REAL NOT NULL,
  origin_lng  REAL NOT NULL,
  dest_name   TEXT NOT NULL,
  dest_lat    REAL NOT NULL,
  dest_lng    REAL NOT NULL,
  depart_at   TEXT NOT NULL,
  max_seats   INTEGER NOT NULL CHECK (max_seats BETWEEN 2 AND 4),
  gender_pref TEXT NOT NULL DEFAULT 'any' CHECK (gender_pref IN ('any', 'male', 'female')),
  memo        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'departed', 'completed', 'cancelled')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ride_members (
  ride_id   INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ride_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_verifications (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  ride_id    INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rater_id   INTEGER NOT NULL REFERENCES users(id),
  ratee_id   INTEGER NOT NULL REFERENCES users(id),
  good       INTEGER NOT NULL CHECK (good IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ride_id, rater_id, ratee_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  blocked_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reported_id INTEGER NOT NULL REFERENCES users(id),
  ride_id     INTEGER REFERENCES rides(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ride_id    INTEGER REFERENCES rides(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  url        TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "이 경로로 합승방이 생기면 알려주세요"
CREATE TABLE IF NOT EXISTS ride_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_name TEXT NOT NULL,
  origin_lat  REAL NOT NULL,
  origin_lng  REAL NOT NULL,
  dest_name   TEXT NOT NULL,
  dest_lat    REAL NOT NULL,
  dest_lng    REAL NOT NULL,
  radius_km   REAL NOT NULL,
  depart_from TEXT NOT NULL,
  depart_to   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 참여 전 문의: 합승방마다 문의자(guest)별 1:1 대화. 기존 멤버 누구나 답할 수 있다.
CREATE TABLE IF NOT EXISTS inquiry_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  guest_id   INTEGER NOT NULL REFERENCES users(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phone_verifications (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL
);

-- 정기 노선 (출퇴근 택시 크루): 요일·시각마다 같은 경로를 같이 타는 모임
CREATE TABLE IF NOT EXISTS commutes (
  id            INTEGER PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  origin_name   TEXT NOT NULL,
  origin_lat    REAL NOT NULL,
  origin_lng    REAL NOT NULL,
  origin_area   TEXT NOT NULL,          -- 공개용 대략적 위치 (예: 분당구 정자동)
  dest_name     TEXT NOT NULL,
  dest_lat      REAL NOT NULL,
  dest_lng      REAL NOT NULL,
  dest_area     TEXT NOT NULL,
  days          INTEGER NOT NULL,       -- 요일 비트: 월=1 화=2 수=4 목=8 금=16 토=32 일=64
  depart_time   TEXT NOT NULL,          -- 'HH:MM' (한국 시간)
  max_seats     INTEGER NOT NULL DEFAULT 4,
  gender_pref   TEXT NOT NULL DEFAULT 'any' CHECK (gender_pref IN ('any', 'male', 'female')),
  meeting_point TEXT NOT NULL DEFAULT '',
  memo          TEXT NOT NULL DEFAULT '',
  distance_km   REAL,
  taxi_fare     INTEGER,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commute_members (
  commute_id INTEGER NOT NULL REFERENCES commutes(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (commute_id, user_id)
);

CREATE TABLE IF NOT EXISTS commute_messages (
  id         INTEGER PRIMARY KEY,
  commute_id INTEGER NOT NULL REFERENCES commutes(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 날짜별로 자동으로 연 합승방 (ride_id NULL = 인원이 모자라 열지 않음)
CREATE TABLE IF NOT EXISTS commute_trips (
  commute_id INTEGER NOT NULL REFERENCES commutes(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  ride_id    INTEGER REFERENCES rides(id),
  PRIMARY KEY (commute_id, date)
);

-- 본인확인(PASS 등) 요청 — 서버가 발급한 인증 건만, 발급받은 계정에서, 한 번만 사용
CREATE TABLE IF NOT EXISTS identity_verifications (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  used_at    TEXT
);

-- 문자 발송 기록 (번호별·계정별 하루 발송 횟수 제한 — 문자 폭탄·비용 방지)
CREATE TABLE IF NOT EXISTS sms_sends (
  phone   TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);

-- 약관·개인정보 동의 기록 (종류별 버전과 동의 시각)
CREATE TABLE IF NOT EXISTS user_consents (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  version   TEXT NOT NULL,
  agreed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS password_resets (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL
);

-- 탈퇴 후 재가입으로 노쇼·직전취소 기록을 지우지 못하도록 1년간 보관 (휴대폰 번호는 해시로만 저장)
CREATE TABLE IF NOT EXISTS withdrawn_accounts (
  phone_hash        TEXT NOT NULL,
  no_show_count     INTEGER NOT NULL,
  late_cancel_count INTEGER NOT NULL,
  withdrawn_at      TEXT NOT NULL
);

-- 안심 공유 링크: 로그인하지 않은 가족·지인이 합승 경로와 택시 차량번호를 볼 수 있다
CREATE TABLE IF NOT EXISTS ride_shares (
  token      TEXT PRIMARY KEY,
  ride_id    INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- 긴급 신고 버튼 기록 (분쟁·수사 협조용)
CREATE TABLE IF NOT EXISTS ride_emergencies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 위치정보 이용·제공 사실 확인자료 (위치정보법 제16조 — 자동 기록, 6개월 이상 보관)
-- 좌표 자체는 남기지 않고 "언제, 누구의 위치를, 무슨 목적으로, 누구에게" 만 기록한다
CREATE TABLE IF NOT EXISTS location_usage_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  action     TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  recipient  TEXT,
  created_at TEXT NOT NULL
);

-- 자동 매칭 요청: "이 경로로 이 시간 안에 같이 탈 사람" — 맞는 방에 자동 참여하거나 요청끼리 방을 만든다
CREATE TABLE IF NOT EXISTS ride_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_name TEXT NOT NULL,
  origin_lat  REAL NOT NULL,
  origin_lng  REAL NOT NULL,
  dest_name   TEXT NOT NULL,
  dest_lat    REAL NOT NULL,
  dest_lng    REAL NOT NULL,
  window_from TEXT NOT NULL,
  window_to   TEXT NOT NULL,
  radius_km   REAL NOT NULL,
  org_only    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'matched', 'cancelled', 'expired')),
  ride_id     INTEGER REFERENCES rides(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON ride_requests(status, window_to);
CREATE INDEX IF NOT EXISTS idx_location_logs_user ON location_usage_logs(user_id, id);
CREATE INDEX IF NOT EXISTS idx_location_logs_time ON location_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_withdrawn_phone ON withdrawn_accounts(phone_hash);
CREATE INDEX IF NOT EXISTS idx_sms_sends ON sms_sends(phone, sent_at);
CREATE INDEX IF NOT EXISTS idx_sms_sends_user ON sms_sends(user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_inquiry_thread ON inquiry_messages(ride_id, guest_id, id);
CREATE INDEX IF NOT EXISTS idx_rides_status_depart ON rides(status, depart_at);
CREATE INDEX IF NOT EXISTS idx_messages_ride ON messages(ride_id, id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ride_alerts_to ON ride_alerts(depart_to);
CREATE INDEX IF NOT EXISTS idx_commutes_status ON commutes(status);
CREATE INDEX IF NOT EXISTS idx_commute_members_user ON commute_members(user_id);
CREATE INDEX IF NOT EXISTS idx_commute_messages ON commute_messages(commute_id, id);
`;

// 이전 버전 DB 파일에 새 컬럼을 추가한다 (ALTER TABLE ADD COLUMN 은 NOT NULL 이면 기본값 필요)
const COLUMNS = {
  users: {
    email_verified: 'INTEGER NOT NULL DEFAULT 0', // 학교/회사 소속 인증용 (선택)
    real_name: 'TEXT',               // 본인정보 (다른 사용자에게 공개하지 않음)
    birth_date: 'TEXT',              // YYYY-MM-DD
    phone: 'TEXT',                   // 숫자만, 예: 01012345678
    phone_verified: 'INTEGER NOT NULL DEFAULT 0', // 휴대폰 인증 = 서비스 이용 가능
    token_version: 'INTEGER NOT NULL DEFAULT 0',  // 올리면 기존 로그인 토큰 전부 무효
    deleted_at: 'TEXT',              // 회원 탈퇴 시각 (개인정보는 즉시 파기, 행은 익명화)
    org_domain: 'TEXT',              // 학교/회사 이메일 도메인 (인증 완료 시)
    no_show_count: 'INTEGER NOT NULL DEFAULT 0',
    late_cancel_count: 'INTEGER NOT NULL DEFAULT 0',
    identity_key: 'TEXT',            // 본인확인 CI/DI 의 HMAC (1인 1계정 확인용, 원문은 저장하지 않음)
    identity_method: 'TEXT',         // 'pass' (본인확인 업체) / 'sms' (문자 인증)
    identity_verified_at: 'TEXT',
  },
  rides: {
    distance_km: 'REAL',             // 네이버 길찾기 실제 도로거리 (없으면 직선거리 추정)
    duration_min: 'INTEGER',
    taxi_fare: 'INTEGER',            // 네이버 길찾기 예상 택시요금
    route_path: 'TEXT',              // JSON [[lng, lat], ...]
    meeting_point: "TEXT NOT NULL DEFAULT ''",
    org_domain: 'TEXT',              // 설정 시 같은 소속 인증 사용자만 참여
    reminded_at: 'TEXT',             // 출발 10분 전 알림 발송 시각
    payer_id: 'INTEGER',             // 정산: 택시비를 결제한 사람
    actual_fare: 'INTEGER',
    payer_account: 'TEXT',
    completed_at: 'TEXT',
    taxi_plate: 'TEXT',              // 탑승한 택시 차량번호 (예: 서울12가3456)
    taxi_note: 'TEXT',               // 차종·색상 등 메모
    taxi_recorded_by: 'INTEGER',
    taxi_recorded_at: 'TEXT',
    taxi_type: "TEXT NOT NULL DEFAULT 'standard'", // (사용 안 함 — 예전 택시 종류 구분)
  },
  ride_members: {
    dropoff_name: 'TEXT',            // 가는 길에 먼저 내리는 경우 하차 지점 (NULL = 최종 도착지)
    dropoff_lat: 'REAL',
    dropoff_lng: 'REAL',
    dropoff_t: 'REAL NOT NULL DEFAULT 1', // 경로상 하차 위치 비율 (0~1)
    arrived_at: 'TEXT',              // 만남 장소 도착 체크인
    paid_at: 'TEXT',                 // 정산 송금 완료
    seat: 'TEXT',                    // 좌석 (front / rear_right / rear_left / rear_middle)
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [column, type] of Object.entries(columns)) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  // 인증된 휴대폰 번호 하나당 계정 하나
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verified_phone ON users(phone) WHERE phone_verified = 1');
  // 본인확인된 사람 한 명당 계정 하나
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identity_key ON users(identity_key) WHERE identity_key IS NOT NULL');
}
export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') {
    // 읽기와 쓰기가 서로 막지 않도록 (백업 중에도 서비스 가능)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Runs fn inside a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
