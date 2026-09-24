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

-- 문자 발송 기록 (번호별·계정별 하루 발송 횟수 제한 — 문자 폭탄·비용 방지)
CREATE TABLE IF NOT EXISTS sms_sends (
  phone   TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sms_sends ON sms_sends(phone, sent_at);
CREATE INDEX IF NOT EXISTS idx_sms_sends_user ON sms_sends(user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_inquiry_thread ON inquiry_messages(ride_id, guest_id, id);
CREATE INDEX IF NOT EXISTS idx_rides_status_depart ON rides(status, depart_at);
CREATE INDEX IF NOT EXISTS idx_messages_ride ON messages(ride_id, id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_ride_alerts_to ON ride_alerts(depart_to);
`;

// 이전 버전 DB 파일에 새 컬럼을 추가한다 (ALTER TABLE ADD COLUMN 은 NOT NULL 이면 기본값 필요)
const COLUMNS = {
  users: {
    email_verified: 'INTEGER NOT NULL DEFAULT 0', // 학교/회사 소속 인증용 (선택)
    real_name: 'TEXT',               // 본인정보 (다른 사용자에게 공개하지 않음)
    birth_date: 'TEXT',              // YYYY-MM-DD
    phone: 'TEXT',                   // 숫자만, 예: 01012345678
    phone_verified: 'INTEGER NOT NULL DEFAULT 0', // 휴대폰 인증 = 서비스 이용 가능
    org_domain: 'TEXT',              // 학교/회사 이메일 도메인 (인증 완료 시)
    no_show_count: 'INTEGER NOT NULL DEFAULT 0',
    late_cancel_count: 'INTEGER NOT NULL DEFAULT 0',
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
  },
  ride_members: {
    dropoff_name: 'TEXT',            // 가는 길에 먼저 내리는 경우 하차 지점 (NULL = 최종 도착지)
    dropoff_lat: 'REAL',
    dropoff_lng: 'REAL',
    dropoff_t: 'REAL NOT NULL DEFAULT 1', // 경로상 하차 위치 비율 (0~1)
    arrived_at: 'TEXT',              // 만남 장소 도착 체크인
    paid_at: 'TEXT',                 // 정산 송금 완료
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
}
export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
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
