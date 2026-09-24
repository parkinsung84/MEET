// SQLite 온라인 백업: 서비스를 멈추지 않고 일관된 사본을 만든다 (VACUUM INTO).
//   node scripts/backup.js           → 한 번 백업
//   node scripts/backup.js --loop    → 지금 한 번, 이후 24시간마다 (docker compose backup 서비스)
// 환경변수: DB_PATH(기본 meet.db), BACKUP_DIR(기본 backups), BACKUP_KEEP(보관 개수, 기본 14)
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = resolve(process.env.DB_PATH || 'meet.db');
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function backupOnce(dbPath = DB_PATH, dir = BACKUP_DIR, keep = KEEP) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `meet-${stamp}.db`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(file);
  } finally {
    db.close();
  }
  // 오래된 백업 정리
  const backups = readdirSync(dir).filter((f) => /^meet-.*\.db$/.test(f)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(dir, old));
  return { file, bytes: statSync(file).size, kept: Math.min(backups.length, keep) };
}

function run() {
  try {
    const { file, bytes, kept } = backupOnce();
    console.log(`[backup] ${new Date().toISOString()} ${file} (${Math.round(bytes / 1024)}KB, 보관 ${kept}개)`);
  } catch (err) {
    console.error('[backup] 실패:', err.message);
    if (!process.argv.includes('--loop')) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  run();
  if (process.argv.includes('--loop')) setInterval(run, DAY_MS);
}
