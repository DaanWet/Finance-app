import Database from 'better-sqlite3';
import { getSetting, upsertSetting } from './helpers/settings';
import { SETTING_KEYS } from './helpers/constants';

function createInitialSchema(db: Database.Database): void {
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
}

function addMissingColumns(db: Database.Database): void {
  try { db.exec(`ALTER TABLE transactions ADD COLUMN counterparty_account TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN category_confirmed INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN splitwise_owed_share REAL`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN counterparty_name TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN original_description TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN written_off_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN written_off_note TEXT`); } catch {}
  try { db.exec(`ALTER TABLE transactions ADD COLUMN written_off_personal_share REAL`); } catch {}
}

function migrateSavingsType(db: Database.Database): void {
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
}

function createLinkTables(db: Database.Database): void {
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
}

function migrateRemoveWorkExpense(db: Database.Database): void {
  const txDefWork = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { sql: string } | undefined)?.sql ?? '';
  if (!txDefWork.includes('is_work_expense')) return;

  // Step 1: Auto-detect work_organization_id from existing data if not set
  const workOrgSetting = getSetting(SETTING_KEYS.WORK_ORG_ID, db);
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
      upsertSetting(SETTING_KEYS.WORK_ORG_ID, String(mostCommonOrg.organization_id), db);
    }
  }

  // Step 2: Ensure is_work_expense=1 transactions have type='reimbursable' and correct org
  const workOrgId = getSetting(SETTING_KEYS.WORK_ORG_ID, db);
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

function fixSplitwiseIds(db: Database.Database): void {
  db.exec(`
    UPDATE transactions
    SET splitwise_expense_id = CAST(CAST(splitwise_expense_id AS INTEGER) AS TEXT)
    WHERE splitwise_expense_id IS NOT NULL AND splitwise_expense_id LIKE '%.%'
  `);
}

function createAnalysisIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tx_counterparty_account ON transactions(counterparty_account);
    CREATE INDEX IF NOT EXISTS idx_tx_counterparty_name ON transactions(counterparty_name);
    CREATE INDEX IF NOT EXISTS idx_tx_category_confirmed ON transactions(category_confirmed);
    CREATE INDEX IF NOT EXISTS idx_tx_written_off_at ON transactions(written_off_at);
  `);
}

function ensureNewCategories(db: Database.Database): void {
  const ensureCat = db.prepare("INSERT OR IGNORE INTO categories (name, color, icon) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = ?)");
  ensureCat.run('Vaste lasten thuis', '#10b981', '\u{1F3E0}', 'Vaste lasten thuis');
  ensureCat.run('Persoonlijke verzorging', '#ec4899', '\u{1F487}', 'Persoonlijke verzorging');
  ensureCat.run('Reizen', '#0ea5e9', '\u{2708}\u{FE0F}', 'Reizen');
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
      ['Eten & Drinken', '#ef4444', '\u{1F354}'],
      ['Transport', '#3b82f6', '\u{1F68C}'],
      ['Winkelen', '#8b5cf6', '\u{1F6CD}\u{FE0F}'],
      ['Vrije tijd', '#f97316', '\u{1F3AE}'],
      ['Gezondheidszorg', '#06b6d4', '\u{1F48A}'],
      ['Abonnementen', '#6366f1', '\u{1F4F1}'],
      ['Overige', '#94a3b8', '\u{1F4E6}'],
      ['Vaste lasten thuis', '#10b981', '\u{1F3E0}'],
      ['Persoonlijke verzorging', '#ec4899', '\u{1F487}'],
      ['Reizen', '#0ea5e9', '\u{2708}\u{FE0F}'],
    ];
    const stmt = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
    for (const [name, color, icon] of cats) {
      stmt.run(name, color, icon);
    }
  }
}

function createRecurringSeriesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_series (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      series_key       TEXT NOT NULL UNIQUE,
      match_type       TEXT NOT NULL,
      match_value      TEXT NOT NULL,
      direction        TEXT NOT NULL CHECK(direction IN ('expense', 'income')),
      name             TEXT,
      custom_name      TEXT,
      cadence          TEXT NOT NULL CHECK(cadence IN ('weekly', 'monthly', 'quarterly', 'yearly')),
      typical_amount   REAL NOT NULL,
      min_amount       REAL,
      max_amount       REAL,
      is_variable      INTEGER NOT NULL DEFAULT 0,
      category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      occurrence_count INTEGER NOT NULL,
      first_seen       TEXT NOT NULL,
      last_seen        TEXT NOT NULL,
      next_expected    TEXT,
      status           TEXT NOT NULL DEFAULT 'suggested' CHECK(status IN ('suggested', 'confirmed', 'ignored')),
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function runMigrations(db: Database.Database): void {
  createInitialSchema(db);
  addMissingColumns(db);
  migrateSavingsType(db);
  createLinkTables(db);
  createRecurringSeriesTable(db);
  migrateRemoveWorkExpense(db);
  fixSplitwiseIds(db);
  createAnalysisIndexes(db);
  ensureNewCategories(db);
  seedInitialData(db);
}
