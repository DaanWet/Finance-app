import { getDb } from '../db';
import type Database from 'better-sqlite3';

export function getSetting(key: string, db?: Database.Database): string | undefined {
  const d = db ?? getDb();
  return (d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function getSettingRequired(key: string, db?: Database.Database): string {
  const value = getSetting(key, db);
  if (value === undefined) throw new Error(`Setting '${key}' is not configured`);
  return value;
}

export function upsertSetting(key: string, value: string, db?: Database.Database): void {
  const d = db ?? getDb();
  d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
