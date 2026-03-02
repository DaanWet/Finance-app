import Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1'
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#94a3b8',
      icon  TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      description          TEXT NOT NULL,
      amount               REAL NOT NULL,
      date                 TEXT NOT NULL,
      type                 TEXT NOT NULL CHECK(type IN ('personal', 'reimbursable', 'income')),
      category_id          INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      organization_id      INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      reimbursed_at        TEXT,
      reimbursed_note      TEXT,
      ing_transaction_id   TEXT UNIQUE,
      splitwise_expense_id TEXT,
      payment_method       TEXT,
      notes                TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS classification_rules (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern         TEXT NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('personal', 'reimbursable', 'income')),
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  seedInitialData(db);
}

function seedInitialData(db: Database.Database): void {
  const orgCount = (db.prepare('SELECT COUNT(*) as c FROM organizations').get() as { c: number }).c;
  if (orgCount === 0) {
    db.prepare("INSERT INTO organizations (name, color) VALUES (?, ?)").run('Chiro', '#f59e0b');
    db.prepare("INSERT INTO organizations (name, color) VALUES (?, ?)").run('Jeugdhuis', '#10b981');
  }

  const catCount = (db.prepare('SELECT COUNT(*) as c FROM categories').get() as { c: number }).c;
  if (catCount === 0) {
    const cats = [
      ['Eten & Drinken', '#ef4444', '🍔'],
      ['Transport', '#3b82f6', '🚌'],
      ['Winkelen', '#8b5cf6', '🛍️'],
      ['Vrije tijd', '#f97316', '🎮'],
      ['Gezondheidszorg', '#06b6d4', '💊'],
      ['Abonnementen', '#6366f1', '📱'],
      ['Overige', '#94a3b8', '📦'],
    ];
    const stmt = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
    for (const [name, color, icon] of cats) {
      stmt.run(name, color, icon);
    }
  }
}
