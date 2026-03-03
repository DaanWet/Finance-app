export type TransactionType = 'personal' | 'reimbursable' | 'income' | 'savings';

export interface ExpenseReceipt {
  id: number;
  transaction_id: number;
  filename: string;
  content_type: string;
  gmail_message_id: string | null;
  created_at: string;
}

export interface WorkExpense extends Transaction {
  is_work_expense: 1;
  receipts: ExpenseReceipt[];
}

export interface ExpensesPageData {
  month: string;
  transactions: WorkExpense[];
  gmail_connected: boolean;
}

export interface GmailFetchResult {
  fetched: number;
  linked: number;
  unmatched: string[];
}

export interface Transaction {
  id: number;
  description: string;
  amount: number;
  date: string;
  type: TransactionType;
  category_id: number | null;
  organization_id: number | null;
  reimbursed_at: string | null;
  reimbursed_note: string | null;
  ing_transaction_id: string | null;
  splitwise_expense_id: string | null;
  splitwise_owed_share: number | null;
  payment_method: string | null;
  notes: string | null;
  category_confirmed: number;
  is_work_expense: number;
  created_at: string;
  updated_at: string;
  // joined
  category_name?: string;
  category_color?: string;
  category_icon?: string;
  organization_name?: string;
  organization_color?: string;
}

export interface Organization {
  id: number;
  name: string;
  color: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  icon: string | null;
}

export interface ReimbursementGroup {
  organization_id: number | null;
  organization_name: string;
  organization_color: string;
  total: number;
  count: number;
  transactions: Transaction[];
}

export interface DashboardSummary {
  personalTotal: number;
  reimbursableOutstanding: number;
  reimbursableCount: number;
  incomeTotal: number;
  savingsTotal: number;
  splitwisePaidForOthers: number;
  byCategory: { name: string; color: string; icon: string | null; total: number }[];
  monthlyTrend: { month: string; total: number }[];
}

export interface SplitwiseExpense {
  id: number;
  description: string;
  total_cost: number;
  my_owed_share: number;
  my_paid_share: number;
  date: string;
  group_id: number | null;
  group_name: string | null;
  participants: { user_id: number; first_name: string | null; last_name: string | null; owed_share: number; paid_share: number }[];
}

export interface SplitwiseBalance {
  id: number;
  name: string;
  balance: string;
}

export interface ClassificationRule {
  id: number;
  pattern: string;
  type: TransactionType;
  organization_id: number | null;
  category_id: number | null;
  organization_name?: string;
  category_name?: string;
}

export interface CsvPreviewRow {
  index: number;
  date: string;
  description: string;
  amount: number;
  counterparty_account: string | null;
  ing_transaction_id: string;
  duplicate: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  total: number;
  ai_analyzed?: boolean;
  transactions: Transaction[];
}
