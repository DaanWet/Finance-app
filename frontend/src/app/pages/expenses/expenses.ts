import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { WorkExpense, ExpenseReceipt } from '../../models';

@Component({
  selector: 'app-expenses',
  imports: [CommonModule, FormsModule],
  templateUrl: './expenses.html',
  styleUrl: './expenses.scss',
})
export class Expenses implements OnInit {
  transactions = signal<WorkExpense[]>([]);
  loading = signal(true);
  gmailConnected = signal(false);
  fetchingGmail = signal(false);
  fetchResult = signal<{ fetched: number; linked: number; unmatched: string[] } | null>(null);
  uploadingFor = signal<number | null>(null);
  expandedRows = signal<Set<number>>(new Set());

  // Month selector — default to current month
  selectedMonth = signal(this.currentMonth());

  workExpenses = computed(() => this.transactions().filter(t => t.is_work_expense));
  totalAmount = computed(() =>
    this.workExpenses().reduce((sum, t) => sum + Math.abs(t.amount), 0)
  );
  receiptCount = computed(() =>
    this.workExpenses().reduce((sum, t) => sum + (t.receipts?.length ?? 0), 0)
  );
  missingReceiptCount = computed(() =>
    this.workExpenses().filter(t => !t.receipts?.length).length
  );

  constructor(private api: ApiService, private route: ActivatedRoute) {}

  ngOnInit() {
    // Handle Gmail OAuth callback redirect
    this.route.queryParams.subscribe(params => {
      if (params['gmail'] === 'connected') {
        this.gmailConnected.set(true);
      }
    });
    this.load();
  }

  load() {
    this.loading.set(true);
    this.api.getExpenses(this.selectedMonth()).subscribe({
      next: data => {
        this.transactions.set(data.transactions);
        this.gmailConnected.set(data.gmail_connected);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onMonthChange() {
    this.fetchResult.set(null);
    this.expandedRows.set(new Set());
    this.load();
  }

  toggleWorkExpense(tx: WorkExpense) {
    this.api.toggleWorkExpense(tx.id).subscribe(res => {
      this.transactions.update(txs =>
        txs.map(t => t.id === tx.id ? { ...t, is_work_expense: res.is_work_expense as 1 } : t)
      );
      // Auto-expand row when marked as work expense
      if (res.is_work_expense) {
        const set = new Set(this.expandedRows());
        set.add(tx.id);
        this.expandedRows.set(set);
      }
    });
  }

  toggleExpand(txId: number) {
    const set = new Set(this.expandedRows());
    if (set.has(txId)) set.delete(txId); else set.add(txId);
    this.expandedRows.set(set);
  }

  isExpanded(txId: number): boolean {
    return this.expandedRows().has(txId);
  }

  onReceiptFileSelected(event: Event, txId: number) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';

    this.uploadingFor.set(txId);
    this.api.uploadReceipt(txId, file).subscribe({
      next: receipt => {
        this.uploadingFor.set(null);
        this.transactions.update(txs =>
          txs.map(t => t.id === txId
            ? { ...t, receipts: [...(t.receipts ?? []), receipt] }
            : t
          )
        );
      },
      error: () => {
        this.uploadingFor.set(null);
        alert('Upload mislukt. Controleer bestandsformaat (PDF, JPEG, PNG, max 10 MB).');
      },
    });
  }

  deleteReceipt(tx: WorkExpense, receipt: ExpenseReceipt) {
    if (!confirm(`Bijlage "${receipt.filename}" verwijderen?`)) return;
    this.api.deleteReceipt(tx.id, receipt.id).subscribe(() => {
      this.transactions.update(txs =>
        txs.map(t => t.id === tx.id
          ? { ...t, receipts: t.receipts.filter(r => r.id !== receipt.id) }
          : t
        )
      );
    });
  }

  connectGmail() {
    window.location.href = 'http://localhost:3000/api/expenses/gmail/auth';
  }

  fetchGmailTickets() {
    this.fetchingGmail.set(true);
    this.fetchResult.set(null);
    this.api.fetchGmailTickets(this.selectedMonth()).subscribe({
      next: result => {
        this.fetchingGmail.set(false);
        this.fetchResult.set(result);
        if (result.linked > 0) this.load();
      },
      error: () => {
        this.fetchingGmail.set(false);
        alert('Fout bij ophalen Gmail-tickets. Controleer de Google-verbinding.');
      },
    });
  }

  exportExcel() {
    window.open(this.api.getExpenseExcelUrl(this.selectedMonth()), '_blank');
  }

  exportPdf() {
    window.open(this.api.getExpensePdfUrl(this.selectedMonth()), '_blank');
  }

  // ─── Formatting helpers ──────────────────────────────────────────────────

  private currentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  formatEur(amount: number): string {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(Math.abs(amount));
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  formatMonthLabel(ym: string): string {
    const [y, m] = ym.split('-');
    return new Date(Number(y), Number(m) - 1).toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
  }

  receiptIcon(contentType: string): string {
    if (contentType === 'application/pdf') return '📄';
    if (contentType.startsWith('image/')) return '🖼️';
    return '📎';
  }
}
