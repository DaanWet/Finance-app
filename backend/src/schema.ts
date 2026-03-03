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
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transactions_new SELECT
        id, description, amount, date, type, category_id, organization_id,
        reimbursed_at, reimbursed_note, ing_transaction_id, splitwise_expense_id,
        splitwise_owed_share, payment_method, notes, counterparty_account,
        category_confirmed, created_at, updated_at
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

    CREATE TABLE IF NOT EXISTS reimbursement_links (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      income_transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      expense_transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      amount                 REAL NOT NULL,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(income_transaction_id, expense_transaction_id)
    );
  `);

  // Migration: remove is_work_expense column, derive work expenses from type+organization
  const txDefWork = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { sql: string } | undefined)?.sql ?? '';
  if (txDefWork.includes('is_work_expense')) {
    // Step 1: Auto-detect work_organization_id from existing data if not set
    const workOrgSetting = db.prepare("SELECT value FROM settings WHERE key='work_organization_id'").get() as { value: string } | undefined;
    if (!workOrgSetting) {
      const mostCommonOrg = db.prepare(`
        SELECT organization_id, COUNT(*) as cnt
        FROM transactions
        WHERE is_work_expense = 1 AND organization_id IS NOT NULL
        GROUP BY organization_id
        ORDER BY cnt DESC
        LIMIT 1
      `).get() as { organization_id: number; cnt: number } | undefined;

      if (mostCommonOrg) {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('work_organization_id', ?)").run(String(mostCommonOrg.organization_id));
      }
    }

    // Step 2: Ensure is_work_expense=1 transactions have type='reimbursable' and correct org
    const workOrgId = (db.prepare("SELECT value FROM settings WHERE key='work_organization_id'").get() as { value: string } | undefined)?.value;
    if (workOrgId) {
      db.prepare(`
        UPDATE transactions
        SET type = 'reimbursable', organization_id = ?
        WHERE is_work_expense = 1 AND (type != 'reimbursable' OR organization_id IS NULL OR organization_id != ?)
      `).run(Number(workOrgId), Number(workOrgId));
    }

    // Step 3: Rebuild table without is_work_expense
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE transactions_migrated (
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
        counterparty_name    TEXT,
        original_description TEXT,
        category_confirmed   INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO transactions_migrated SELECT
        id, description, amount, date, type, category_id, organization_id,
        reimbursed_at, reimbursed_note, ing_transaction_id, splitwise_expense_id,
        splitwise_owed_share, payment_method, notes, counterparty_account,
        counterparty_name, original_description, category_confirmed,
        created_at, updated_at
      FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_migrated RENAME TO transactions;
      PRAGMA foreign_keys = ON;
    `);
  }

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
  ensureCat.run('Reizen', '#0ea5e9', '✈️', 'Reizen');

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
      ['Reizen', '#0ea5e9', '✈️'],
    ];
    const stmt = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
    for (const [name, color, icon] of cats) {
      stmt.run(name, color, icon);
    }
  }
}
