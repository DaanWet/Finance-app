import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  Transaction, Organization, Category, ReimbursementGroup,
  DashboardSummary, SplitwiseExpense, SplitwiseBalance,
  ClassificationRule, ImportResult, CsvPreviewRow,
  ExpenseReceipt, ExpensesPageData, GmailFetchResult,
  ReimbursementLink, IncomeCandidateTransaction, ExpenseCandidateTransaction
} from '../models';

const BASE = 'http://localhost:3000/api';

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private http: HttpClient) {}

  // Dashboard
  getDashboard(start?: string, end?: string): Observable<DashboardSummary> {
    let params = new HttpParams();
    if (start) params = params.set('start', start);
    if (end) params = params.set('end', end);
    return this.http.get<DashboardSummary>(`${BASE}/dashboard`, { params });
  }

  // Transactions
  getTransactions(filters: Record<string, string> = {}): Observable<Transaction[]> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params = params.set(k, v); });
    return this.http.get<Transaction[]>(`${BASE}/transactions`, { params });
  }

  createTransaction(data: Partial<Transaction>): Observable<Transaction> {
    return this.http.post<Transaction>(`${BASE}/transactions`, data);
  }

  updateTransaction(id: number, data: Partial<Transaction>): Observable<Transaction> {
    return this.http.put<Transaction>(`${BASE}/transactions/${id}`, data);
  }

  deleteTransaction(id: number): Observable<void> {
    return this.http.delete<void>(`${BASE}/transactions/${id}`);
  }

  confirmAllTransactions(): Observable<{ confirmed: number }> {
    return this.http.post<{ confirmed: number }>(`${BASE}/transactions/confirm-all`, {});
  }

  reanalyzeTransaction(id: number): Observable<Transaction> {
    return this.http.post<Transaction>(`${BASE}/transactions/${id}/reanalyze`, {});
  }

  bulkConfirm(ids: number[]): Observable<{ confirmed: number }> {
    return this.http.post<{ confirmed: number }>(`${BASE}/transactions/bulk-confirm`, { ids });
  }

  bulkDelete(ids: number[]): Observable<{ deleted: number }> {
    return this.http.post<{ deleted: number }>(`${BASE}/transactions/bulk-delete`, { ids });
  }

  bulkReanalyze(ids: number[]): Observable<{ reanalyzed: number; transactions: Transaction[] }> {
    return this.http.post<{ reanalyzed: number; transactions: Transaction[] }>(`${BASE}/transactions/bulk-reanalyze`, { ids });
  }

  // Organizations
  getOrganizations(): Observable<Organization[]> {
    return this.http.get<Organization[]>(`${BASE}/organizations`);
  }

  createOrganization(data: Partial<Organization>): Observable<Organization> {
    return this.http.post<Organization>(`${BASE}/organizations`, data);
  }

  updateOrganization(id: number, data: Partial<Organization>): Observable<Organization> {
    return this.http.put<Organization>(`${BASE}/organizations/${id}`, data);
  }

  deleteOrganization(id: number): Observable<void> {
    return this.http.delete<void>(`${BASE}/organizations/${id}`);
  }

  // Categories
  getCategories(): Observable<Category[]> {
    return this.http.get<Category[]>(`${BASE}/categories`);
  }

  createCategory(data: Partial<Category>): Observable<Category> {
    return this.http.post<Category>(`${BASE}/categories`, data);
  }

  updateCategory(id: number, data: Partial<Category>): Observable<Category> {
    return this.http.put<Category>(`${BASE}/categories/${id}`, data);
  }

  deleteCategory(id: number): Observable<void> {
    return this.http.delete<void>(`${BASE}/categories/${id}`);
  }

  // Reimbursements
  getOutstandingReimbursements(): Observable<ReimbursementGroup[]> {
    return this.http.get<ReimbursementGroup[]>(`${BASE}/reimbursements/outstanding`);
  }

  getReceivedReimbursements(months?: number): Observable<ReimbursementGroup[]> {
    const params = months ? `?months=${months}` : '';
    return this.http.get<ReimbursementGroup[]>(`${BASE}/reimbursements/received${params}`);
  }

  markReimbursed(id: number, note?: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${BASE}/reimbursements/${id}/mark-received`, { note });
  }

  linkIncomeToExpenses(data: { income_transaction_id: number; expenses: { expense_transaction_id: number; amount: number }[] }): Observable<{ links: ReimbursementLink[] }> {
    return this.http.post<{ links: ReimbursementLink[] }>(`${BASE}/reimbursements/link`, data);
  }

  unlinkExpense(incomeId: number, expenseId: number): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${BASE}/reimbursements/link/${incomeId}/${expenseId}`);
  }

  getReimbursementLinks(transactionId: number): Observable<{ as_income: ReimbursementLink[]; as_expense: ReimbursementLink[] }> {
    return this.http.get<{ as_income: ReimbursementLink[]; as_expense: ReimbursementLink[] }>(`${BASE}/reimbursements/links/${transactionId}`);
  }

  getIncomeCandidates(organizationId?: number): Observable<IncomeCandidateTransaction[]> {
    let params = new HttpParams();
    if (organizationId) params = params.set('organization_id', organizationId.toString());
    return this.http.get<IncomeCandidateTransaction[]>(`${BASE}/reimbursements/income-candidates`, { params });
  }

  getExpenseCandidates(organizationId?: number): Observable<ExpenseCandidateTransaction[]> {
    let params = new HttpParams();
    if (organizationId) params = params.set('organization_id', organizationId.toString());
    return this.http.get<ExpenseCandidateTransaction[]>(`${BASE}/reimbursements/expense-candidates`, { params });
  }

  // Splitwise
  connectSplitwise(): Observable<{ id: number; name: string }> {
    return this.http.get<{ id: number; name: string }>(`${BASE}/splitwise/connect`);
  }

  getSplitwiseExpenses(datedAfter?: string): Observable<SplitwiseExpense[]> {
    let params = new HttpParams();
    if (datedAfter) params = params.set('dated_after', datedAfter);
    return this.http.get<SplitwiseExpense[]>(`${BASE}/splitwise/expenses`, { params });
  }

  getSplitwiseBalances(): Observable<SplitwiseBalance[]> {
    return this.http.get<SplitwiseBalance[]>(`${BASE}/splitwise/balances`);
  }

  // Settings
  getSettings(): Observable<Record<string, string>> {
    return this.http.get<Record<string, string>>(`${BASE}/settings`);
  }

  setSetting(key: string, value: string): Observable<{ key: string; value: string }> {
    return this.http.put<{ key: string; value: string }>(`${BASE}/settings/${key}`, { value });
  }

  // Import
  previewIngCsv(file: File): Observable<{ rows: CsvPreviewRow[] }> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<{ rows: CsvPreviewRow[] }>(`${BASE}/import/ing-csv/preview`, formData);
  }

  importIngCsv(file: File, selectedIndices: number[]): Observable<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('selectedIndices', JSON.stringify(selectedIndices));
    return this.http.post<ImportResult>(`${BASE}/import/ing-csv`, formData);
  }

  // Expenses
  getExpenses(): Observable<ExpensesPageData> {
    return this.http.get<ExpensesPageData>(`${BASE}/expenses`);
  }

  uploadReceipt(txId: number, file: File): Observable<ExpenseReceipt> {
    const fd = new FormData();
    fd.append('file', file);
    return this.http.post<ExpenseReceipt>(`${BASE}/expenses/${txId}/receipt`, fd);
  }

  deleteReceipt(txId: number, receiptId: number): Observable<void> {
    return this.http.delete<void>(`${BASE}/expenses/${txId}/receipt/${receiptId}`);
  }

  getReceiptUrl(txId: number, receiptId: number): string {
    return `${BASE}/expenses/${txId}/receipt/${receiptId}`;
  }

  getGmailStatus(): Observable<{ connected: boolean }> {
    return this.http.get<{ connected: boolean }>(`${BASE}/expenses/gmail/status`);
  }

  fetchGmailTickets(month: string): Observable<GmailFetchResult> {
    return this.http.post<GmailFetchResult>(`${BASE}/expenses/gmail/fetch`, { month });
  }

  /** Returns a URL to trigger download — use window.open() or anchor download */
  getExpenseExcelUrl(month: string): string {
    return `${BASE}/expenses/export/excel?month=${month}`;
  }

  getExpensePdfUrl(month: string): string {
    return `${BASE}/expenses/export/pdf?month=${month}`;
  }

  // Classification rules
  getClassificationRules(): Observable<ClassificationRule[]> {
    return this.http.get<ClassificationRule[]>(`${BASE}/classification-rules`);
  }

  createClassificationRule(data: Partial<ClassificationRule>): Observable<ClassificationRule> {
    return this.http.post<ClassificationRule>(`${BASE}/classification-rules`, data);
  }

  deleteClassificationRule(id: number): Observable<void> {
    return this.http.delete<void>(`${BASE}/classification-rules/${id}`);
  }
}
