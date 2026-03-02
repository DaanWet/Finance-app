import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  Transaction, Organization, Category, ReimbursementGroup,
  DashboardSummary, SplitwiseExpense, SplitwiseBalance,
  ClassificationRule, ImportResult
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

  getReceivedReimbursements(): Observable<ReimbursementGroup[]> {
    return this.http.get<ReimbursementGroup[]>(`${BASE}/reimbursements/received`);
  }

  markReimbursed(id: number, note?: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${BASE}/reimbursements/${id}/mark-received`, { note });
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
  importIngCsv(file: File): Observable<ImportResult> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<ImportResult>(`${BASE}/import/ing-csv`, formData);
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
