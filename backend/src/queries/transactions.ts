import Database from 'better-sqlite3';

export interface Transaction {
  id: number;
  description: string;
  amount: number;
  date: string;
  type: 'personal' | 'reimbursable' | 'income' | 'savings';
  category_id: number | null;
  organization_id: number | null;
  reimbursed_at: string | null;
  reimbursed_note: string | null;
  ing_transaction_id: string | null;
  splitwise_expense_id: string | null;
  splitwise_owed_share: number | null;
  payment_method: string | null;
  notes: string | null;
  counterparty_account: string | null;
  category_confirmed: number;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string;
  category_color?: string;
  category_icon?: string;
  organization_name?: string;
  organization_color?: string;
}

export interface TransactionFilters {
  type?: string;
  category_id?: number;
  organization_id?: number;
  date_from?: string;
  date_to?: string;
  search?: string;
}

const SELECT_FIELDS = `
  t.*,
  c.name  AS category_name,
  c.color AS category_color,
  c.icon  AS category_icon,
  o.name  AS organization_name,
  o.color AS organization_color
`;

export function getTransactions(db: Database.Database, filters: TransactionFilters = {}): Transaction[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.type) {
    conditions.push('t.type = ?');
    params.push(filters.type);
  }
  if (filters.category_id) {
    conditions.push('t.category_id = ?');
    params.push(filters.category_id);
  }
  if (filters.organization_id) {
    conditions.push('t.organization_id = ?');
    params.push(filters.organization_id);
  }
  if (filters.date_from) {
    conditions.push('t.date >= ?');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push('t.date <= ?');
    params.push(filters.date_to);
  }
  if (filters.search) {
    conditions.push('t.description LIKE ?');
    params.push(`%${filters.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT ${SELECT_FIELDS}
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN organizations o ON t.organization_id = o.id
    ${where}
    ORDER BY t.date DESC, t.created_at DESC
  `).all(...params) as Transaction[];
}

export function getTransactionById(db: Database.Database, id: number): Transaction | undefined {
  return db.prepare(`
    SELECT ${SELECT_FIELDS}
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN organizations o ON t.organization_id = o.id
    WHERE t.id = ?
  `).get(id) as Transaction | undefined;
}

export interface CreateTransactionInput {
  description: string;
  amount: number;
  date: string;
  type: 'personal' | 'reimbursable' | 'income' | 'savings';
  category_id?: number | null;
  organization_id?: number | null;
  ing_transaction_id?: string | null;
  splitwise_expense_id?: string | null;
  splitwise_owed_share?: number | null;
  payment_method?: string | null;
  notes?: string | null;
  counterparty_account?: string | null;
  category_confirmed?: number;
}

export function createTransaction(db: Database.Database, input: CreateTransactionInput): Transaction {
  const result = db.prepare(`
    INSERT INTO transactions (description, amount, date, type, category_id, organization_id,
      ing_transaction_id, splitwise_expense_id, splitwise_owed_share, payment_method, notes,
      counterparty_account, category_confirmed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.description, input.amount, input.date, input.type,
    input.category_id ?? null, input.organization_id ?? null,
    input.ing_transaction_id ?? null, input.splitwise_expense_id ?? null,
    input.splitwise_owed_share ?? null,
    input.payment_method ?? null, input.notes ?? null,
    input.counterparty_account ?? null,
    input.category_confirmed ?? 1
  );
  return getTransactionById(db, result.lastInsertRowid as number)!;
}

export interface UpdateTransactionInput extends Partial<CreateTransactionInput> {}

export function updateTransaction(db: Database.Database, id: number, input: UpdateTransactionInput): Transaction | undefined {
  const existing = getTransactionById(db, id);
  if (!existing) return undefined;

  db.prepare(`
    UPDATE transactions SET
      description = ?, amount = ?, date = ?, type = ?,
      category_id = ?, organization_id = ?,
      splitwise_expense_id = ?, splitwise_owed_share = ?, payment_method = ?, notes = ?,
      category_confirmed = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.description ?? existing.description,
    input.amount ?? existing.amount,
    input.date ?? existing.date,
    input.type ?? existing.type,
    input.category_id !== undefined ? input.category_id : existing.category_id,
    input.organization_id !== undefined ? input.organization_id : existing.organization_id,
    input.splitwise_expense_id !== undefined ? input.splitwise_expense_id : existing.splitwise_expense_id,
    input.splitwise_owed_share !== undefined ? input.splitwise_owed_share : existing.splitwise_owed_share,
    input.payment_method !== undefined ? input.payment_method : existing.payment_method,
    input.notes !== undefined ? input.notes : existing.notes,
    input.category_confirmed !== undefined ? input.category_confirmed : existing.category_confirmed,
    id
  );
  return getTransactionById(db, id);
}

export function deleteTransaction(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function confirmAllTransactions(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE transactions SET category_confirmed = 1, updated_at = datetime('now')
    WHERE category_confirmed = 0
  `).run();
  return result.changes;
}

export function getTransactionsByIds(db: Database.Database, ids: number[]): Transaction[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT ${SELECT_FIELDS}
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN organizations o ON t.organization_id = o.id
    WHERE t.id IN (${placeholders})
  `).all(...ids) as Transaction[];
}

export function confirmTransactions(db: Database.Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`
    UPDATE transactions SET category_confirmed = 1, updated_at = datetime('now')
    WHERE id IN (${placeholders}) AND category_confirmed = 0
  `).run(...ids);
  return result.changes;
}

export function deleteTransactions(db: Database.Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`
    DELETE FROM transactions WHERE id IN (${placeholders})
  `).run(...ids);
  return result.changes;
}
