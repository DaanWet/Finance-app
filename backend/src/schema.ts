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
      type                 TEXT NOT NULL CHECK(type IN ('personal', 'reimbursable', 'income', 'savings')),
      category_id          INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      organization_id      INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      reimbursed_at        TEXT,
      reimbursed_note      TEXT,
      ing_transaction_id   TEXT UNIQUE,
      splitwise_expense_id TEXT,
      payment_method       TEXT,
      notes                TEXT,
      counterparty_account TEXT,
      category_confirmed   INTEGER NOT NULL DEFAULT 1,
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
      type            TEXT NOT NULL CHECK(type IN ('personal', 'reimbursable', 'income', 'savings')),
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Additive migrations for existing databases
  try { db.exec(`ALTER TABLE transactions ADD COLUMN counterparty_account TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN category_confirmed INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN is_work_expense INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN splitwise_owed_share REAL`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN counterparty_name TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN original_description TEXT`); } catch {}

  // Migrate CHECK constraint to include 'savings' type
  const txDef = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { sql: string } | undefined)?.sql ?? '';
  if (!txDef.includes("'savings'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE transactions_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        description          TEXT NOT NULL,
        amount               REAL NOT NULL,
        date                 TEXT NOT NULL,
        type                 TEXT NOT NULL CHECK(type IN ('personal', 'reimbursable', 'income', 'savings')),
        category_id          INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        organization_id      INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        reimbursed_at        TEXT,
        reimbursed_note      TEXT,
        ing_transaction_id   TEXT UNIQUE,
        splitwise_expense_id TEXT,
        splitwise_owed_share REAL,
        payment_method       TEXT,
        notes                TEXT,
        counterparty_account TEXT,
        category_confirmed   INTEGER NOT NULL DEFAULT 1,
        is_work_expense      INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transactions_new SELECT
        id, description, amount, date, type, category_id, organization_id,
        reimbursed_at, reimbursed_note, ing_transaction_id, splitwise_expense_id,
        splitwise_owed_share, payment_method, notes, counterparty_account,
        category_confirmed, is_work_expense, created_at, updated_at
      FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_new RENAME TO transactions;
      PRAGMA foreign_keys = ON;
    `);
  }

  const ruleDef = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='classification_rules'").get() as { sql: string } | undefined)?.sql ?? '';
  if (!ruleDef.includes("'savings'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE classification_rules_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern         TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('personal', 'reimbursable', 'income', 'savings')),
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO classification_rules_new SELECT * FROM classification_rules;
      DROP TABLE classification_rules;
      ALTER TABLE classification_rules_new RENAME TO classification_rules;
      PRAGMA foreign_keys = ON;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_receipts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id   INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      filename         TEXT NOT NULL,
      content_type     TEXT NOT NULL,
      data             BLOB NOT NULL,
      gmail_message_id TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Fix splitwise_expense_id stored as REAL (e.g. "4089538700.0" instead of "4089538700")
  db.exec(`
    UPDATE transactions
    SET splitwise_expense_id = CAST(CAST(splitwise_expense_id AS INTEGER) AS TEXT)
    WHERE splitwise_expense_id IS NOT NULL AND splitwise_expense_id LIKE '%.%'
  `);

  // Ensure new categories exist for existing databases
  const ensureCat = db.prepare("INSERT OR IGNORE INTO categories (name, color, icon) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = ?)");
  ensureCat.run('Vaste lasten thuis', '#10b981', '🏠', 'Vaste lasten thuis');
  ensureCat.run('Persoonlijke verzorging', '#ec4899', '💇', 'Persoonlijke verzorging');

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
      ['Vaste lasten thuis', '#10b981', '🏠'],
      ['Persoonlijke verzorging', '#ec4899', '💇'],
    ];
    const stmt = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
    for (const [name, color, icon] of cats) {
      stmt.run(name, color, icon);
    }
  }
}
