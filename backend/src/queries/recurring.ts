import Database from 'better-sqlite3';
import { DetectedSeries, MONTHLY_FACTOR, Cadence } from '../services/recurringDetection';

export interface DetectionTxRow {
  id: number;
  date: string;
  amount: number;
  type: string;
  description: string;
  counterparty_account: string | null;
  counterparty_name: string | null;
  category_id: number | null;
}

export interface RecurringSeriesRow {
  id: number;
  series_key: string;
  match_type: string;
  match_value: string;
  direction: 'expense' | 'income';
  name: string | null;
  custom_name: string | null;
  cadence: Cadence;
  typical_amount: number;
  min_amount: number | null;
  max_amount: number | null;
  is_variable: number;
  category_id: number | null;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  next_expected: string | null;
  status: 'suggested' | 'confirmed' | 'ignored';
  active: number;
  created_at: string;
  updated_at: string;
  category_name?: string;
  category_color?: string;
  category_icon?: string;
}

export interface RecurringSummary {
  monthlyExpenseTotal: number;
  monthlyIncomeTotal: number;
  activeCount: number;
  suggestedCount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Alle transacties die in aanmerking komen voor recurring-detectie. */
export function getDetectionTransactions(db: Database.Database): DetectionTxRow[] {
  return db.prepare(`
    SELECT id, date, amount, type, description, counterparty_account, counterparty_name, category_id
    FROM transactions
    WHERE type IN ('personal', 'reimbursable', 'income', 'savings')
    ORDER BY date ASC
  `).all() as DetectionTxRow[];
}

/**
 * Upsert één gedetecteerde reeks. Behoudt status, custom_name en een reeds
 * gecachte AI-naam bij een bestaande reeks; gebruikt de meegegeven naam alleen
 * als er nog geen naam was.
 */
export function upsertSeries(db: Database.Database, s: DetectedSeries, name: string): 'created' | 'updated' {
  const existing = db.prepare('SELECT id FROM recurring_series WHERE series_key = ?').get(s.series_key) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE recurring_series SET
        match_type = ?, match_value = ?, direction = ?, cadence = ?,
        typical_amount = ?, min_amount = ?, max_amount = ?, is_variable = ?,
        category_id = ?, occurrence_count = ?, first_seen = ?, last_seen = ?,
        next_expected = ?, active = ?,
        name = COALESCE(NULLIF(name, ''), ?),
        updated_at = datetime('now')
      WHERE series_key = ?
    `).run(
      s.match_type, s.match_value, s.direction, s.cadence,
      s.typical_amount, s.min_amount, s.max_amount, s.is_variable ? 1 : 0,
      s.category_id, s.occurrence_count, s.first_seen, s.last_seen,
      s.next_expected, s.active ? 1 : 0,
      name,
      s.series_key,
    );
    return 'updated';
  }

  db.prepare(`
    INSERT INTO recurring_series (
      series_key, match_type, match_value, direction, name, cadence,
      typical_amount, min_amount, max_amount, is_variable, category_id,
      occurrence_count, first_seen, last_seen, next_expected, status, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?)
  `).run(
    s.series_key, s.match_type, s.match_value, s.direction, name, s.cadence,
    s.typical_amount, s.min_amount, s.max_amount, s.is_variable ? 1 : 0, s.category_id,
    s.occurrence_count, s.first_seen, s.last_seen, s.next_expected, s.active ? 1 : 0,
  );
  return 'created';
}

/** Verwijder nog niet-beoordeelde reeksen die niet meer in de detectie voorkomen. */
export function deleteStaleSuggested(db: Database.Database, keepKeys: string[]): number {
  const all = db.prepare("SELECT series_key FROM recurring_series WHERE status = 'suggested'").all() as { series_key: string }[];
  const keep = new Set(keepKeys);
  const toDelete = all.filter(r => !keep.has(r.series_key)).map(r => r.series_key);
  if (toDelete.length === 0) return 0;
  const del = db.prepare('DELETE FROM recurring_series WHERE series_key = ?');
  let n = 0;
  for (const key of toDelete) n += del.run(key).changes;
  return n;
}

const SERIES_SELECT = `
  s.*,
  c.name  AS category_name,
  c.color AS category_color,
  c.icon  AS category_icon
`;

/** Volledige lijst, gesorteerd: voorgesteld eerst, dan op maandbedrag aflopend. */
export function listSeries(db: Database.Database): RecurringSeriesRow[] {
  return db.prepare(`
    SELECT ${SERIES_SELECT}
    FROM recurring_series s
    LEFT JOIN categories c ON s.category_id = c.id
    ORDER BY
      CASE s.status WHEN 'suggested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
      s.active DESC,
      s.typical_amount DESC
  `).all() as RecurringSeriesRow[];
}

export function getSummary(db: Database.Database): RecurringSummary {
  const rows = db.prepare(`
    SELECT direction, cadence, typical_amount
    FROM recurring_series
    WHERE status != 'ignored' AND active = 1
  `).all() as { direction: 'expense' | 'income'; cadence: Cadence; typical_amount: number }[];

  let monthlyExpenseTotal = 0;
  let monthlyIncomeTotal = 0;
  for (const r of rows) {
    const monthly = r.typical_amount * MONTHLY_FACTOR[r.cadence];
    if (r.direction === 'income') monthlyIncomeTotal += monthly;
    else monthlyExpenseTotal += monthly;
  }

  const suggestedCount = (db.prepare(
    "SELECT COUNT(*) AS c FROM recurring_series WHERE status = 'suggested'"
  ).get() as { c: number }).c;

  return {
    monthlyExpenseTotal: round2(monthlyExpenseTotal),
    monthlyIncomeTotal: round2(monthlyIncomeTotal),
    activeCount: rows.length,
    suggestedCount,
  };
}

export function getSeriesById(db: Database.Database, id: number): RecurringSeriesRow | undefined {
  return db.prepare(`
    SELECT ${SERIES_SELECT}
    FROM recurring_series s
    LEFT JOIN categories c ON s.category_id = c.id
    WHERE s.id = ?
  `).get(id) as RecurringSeriesRow | undefined;
}

export interface UpdateSeriesInput {
  status?: 'suggested' | 'confirmed' | 'ignored';
  custom_name?: string | null;
}

export function updateSeries(db: Database.Database, id: number, input: UpdateSeriesInput): RecurringSeriesRow | undefined {
  const existing = getSeriesById(db, id);
  if (!existing) return undefined;

  const status = input.status ?? existing.status;
  if (!['suggested', 'confirmed', 'ignored'].includes(status)) return undefined;
  const customName = input.custom_name !== undefined ? input.custom_name : existing.custom_name;

  db.prepare(`
    UPDATE recurring_series SET status = ?, custom_name = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, customName, id);

  return getSeriesById(db, id);
}
