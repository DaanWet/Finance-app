import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema';
import { scanRecurringSeries } from './recurringScan';
import { DetectedSeries } from './recurringDetection';

// Stub-namer: vermijdt netwerk/AI tijdens tests.
const stubNamer = async (series: DetectedSeries[]) =>
  new Map(series.map(s => [s.series_key, `AI: ${s.match_value}`]));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertTx(db: Database.Database, id: number, date: string, amount: number) {
  db.prepare(`
    INSERT INTO transactions (id, description, amount, date, type, counterparty_account, counterparty_name)
    VALUES (?, 'SPOTIFY', ?, ?, 'personal', 'BE111', 'Spotify')
  `).run(id, amount, date);
}

describe('scanRecurringSeries', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('creates a series on first scan and uses the AI name', async () => {
    insertTx(db, 1, '2025-01-05', -9.99);
    insertTx(db, 2, '2025-02-04', -9.99);
    insertTx(db, 3, '2025-03-06', -9.99);

    const res = await scanRecurringSeries(db, { namer: stubNamer, today: '2025-04-01' });
    expect(res.created).toBe(1);
    expect(res.total).toBe(1);

    const row = db.prepare('SELECT name, status FROM recurring_series').get() as { name: string; status: string };
    expect(row.name).toBe('AI: BE111');
    expect(row.status).toBe('suggested');
  });

  it('is idempotent and preserves status + custom_name on rescan', async () => {
    insertTx(db, 1, '2025-01-05', -9.99);
    insertTx(db, 2, '2025-02-04', -9.99);
    insertTx(db, 3, '2025-03-06', -9.99);
    await scanRecurringSeries(db, { namer: stubNamer, today: '2025-04-01' });

    // Gebruiker bevestigt + hernoemt
    db.prepare("UPDATE recurring_series SET status='confirmed', custom_name='Spotify Premium'").run();

    const res = await scanRecurringSeries(db, { namer: stubNamer, today: '2025-04-01' });
    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);

    const rows = db.prepare('SELECT status, custom_name FROM recurring_series').all() as { status: string; custom_name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('confirmed');
    expect(rows[0]!.custom_name).toBe('Spotify Premium');
  });
});
