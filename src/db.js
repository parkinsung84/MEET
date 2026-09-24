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
  distance_km  REAL,     -- 네이버 길찾기 실제 도로거리 (없으면 직선거리 추정)
  duration_min INTEGER,
  taxi_fare    INTEGER,  -- 네이버 길찾기 예상 택시요금
  route_path   TEXT,     -- JSON [[lng, lat], ...]
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

CREATE INDEX IF NOT EXISTS idx_rides_status_depart ON rides(status, depart_at);
CREATE INDEX IF NOT EXISTS idx_messages_ride ON messages(ride_id, id);
`;

// 이전 버전 DB 파일에 새 컬럼을 추가한다
const RIDE_COLUMNS = {
  distance_km: 'REAL',
  duration_min: 'INTEGER',
  taxi_fare: 'INTEGER',
  route_path: 'TEXT',
};

function migrate(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(rides)').all().map((c) => c.name));
  for (const [column, type] of Object.entries(RIDE_COLUMNS)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE rides ADD COLUMN ${column} ${type}`);
  }
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
