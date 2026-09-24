import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backupOnce } from '../scripts/backup.js';
import { openDatabase } from '../src/db.js';

test('백업: 사용 중인 DB 의 일관된 사본을 만들고 오래된 백업은 정리', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meet-backup-'));
  const dbPath = join(dir, 'live.db');
  const db = openDatabase(dbPath);
  db.prepare("INSERT INTO users (email, password_hash, nickname, gender) VALUES ('a@a.com', 'x', 'a', 'male')").run();

  const backups = join(dir, 'backups');
  for (let i = 0; i < 3; i++) {
    backupOnce(dbPath, backups, 2);
    await new Promise((r) => setTimeout(r, 5)); // 파일 이름(시각)이 겹치지 않게
  }
  const files = readdirSync(backups);
  assert.equal(files.length, 2);
  const copy = new DatabaseSync(join(backups, files.at(-1)), { readOnly: true });
  assert.equal(copy.prepare('SELECT email FROM users').get().email, 'a@a.com');
  copy.close();
  db.close();
});
