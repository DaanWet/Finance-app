import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './schema';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // DB_PATH env var laat toe om de database buiten /mnt/c/ op te slaan in WSL
    // Standaard: naast de broncode in de data/ map
    const dbPath = process.env['DB_PATH'] ?? path.join(__dirname, '..', 'data', 'finance.db');

    // Zorg dat de map bestaat
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(dbPath);

    // WAL mode werkt niet betrouwbaar op Windows-bestandssystemen via WSL (/mnt/c/...)
    // Gebruik DELETE mode als WAL een I/O error geeft
    try {
      db.pragma('journal_mode = WAL');
    } catch {
      db.pragma('journal_mode = DELETE');
    }
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}
