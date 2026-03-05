import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ReimbursementGroup, Transaction, IncomeCandidateTransaction, ReimbursementLink } from '../../models';
import { formatEur, formatDate } from '../../utils/format';

@Component({
  selector: 'app-reimbursements',
  imports: [CommonModule, FormsModule],
  templateUrl: './reimbursements.html',
  styleUrl: './reimbursements.scss',
})
export class Reimbursements implements OnInit {
  outstanding = signal<ReimbursementGroup[]>([]);
  received = signal<ReimbursementGroup[]>([]);
  loading = signal(true);
  showReceivedExpanded = signal(false);
  receivedPeriod = signal<number | null>(12);
  markingId = signal<number | null>(null);
  confirmId = signal<number | null>(null);
  confirmNote = '';

  // Linking: expense → income
  linkingExpenseId = signal<number | null>(null);
  linkingAmount = signal<number>(0);
  incomeCandidates = signal<IncomeCandidateTransaction[]>([]);
  selectedIncomeId = signal<number | null>(null);
  linkSaving = signal(false);

  // Links for received transactions
  receivedLinks = signal<Map<number, ReimbursementLink[]>>(new Map());
  expandedLinkId = signal<number | null>(null);

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.api.getOutstandingReimbursements().subscribe(data => {
      this.outstanding.set(data);
      this.loading.set(false);
    });
    this.api.getReceivedReimbursements(this.receivedPeriod() ?? undefined).subscribe(data => this.received.set(data));
  }

  totalOutstanding(): number {
    return this.outstanding().reduce((sum, g) => sum + g.total, 0);
  }

  // --- Mark received (existing flow) ---
  openConfirm(tx: Transaction) {
    this.confirmId.set(tx.id);
    this.confirmNote = '';
    this.linkingExpenseId.set(null);
  }

  cancelConfirm() {
    this.confirmId.set(null);
    this.confirmNote = '';
  }

  markReceived() {
    const id = this.confirmId();
    if (!id) return;
    this.markingId.set(id);
    this.api.markReimbursed(id, this.confirmNote || undefined).subscribe({
      next: () => {
        this.markingId.set(null);
        this.confirmId.set(null);
        this.confirmNote = '';
        this.load();
      },
      error: () => this.markingId.set(null),
    });
  }

  // --- Link to income ---
  openLinkToIncome(tx: Transaction) {
    this.linkingExpenseId.set(tx.id);
    this.linkingAmount.set(Math.abs(tx.amount));
    this.selectedIncomeId.set(null);
    this.confirmId.set(null);

    this.api.getIncomeCandidates().subscribe(candidates => {
      this.incomeCandidates.set(candidates);
    });
  }

  cancelLink() {
    this.linkingExpenseId.set(null);
    this.selectedIncomeId.set(null);
  }

  confirmLink() {
    const expenseId = this.linkingExpenseId();
    const incomeId = this.selectedIncomeId();
    if (!expenseId || !incomeId) return;

    this.linkSaving.set(true);
    this.api.linkIncomeToExpenses({
      income_transaction_id: incomeId,
      expenses: [{ expense_transaction_id: expenseId, amount: this.linkingAmount() }],
    }).subscribe({
      next: () => {
        this.linkSaving.set(false);
        this.linkingExpenseId.set(null);
        this.selectedIncomeId.set(null);
        this.load();
      },
      error: () => this.linkSaving.set(false),
    });
  }

  // --- Received links ---
  toggleLinkDetail(txId: number) {
    if (this.expandedLinkId() === txId) {
      this.expandedLinkId.set(null);
      return;
    }
    this.expandedLinkId.set(txId);
    if (!this.receivedLinks().has(txId)) {
      this.api.getReimbursementLinks(txId).subscribe(result => {
        const map = new Map(this.receivedLinks());
        map.set(txId, result.as_expense);
        this.receivedLinks.set(map);
      });
    }
  }

  getLinksForTx(txId: number): ReimbursementLink[] {
    return this.receivedLinks().get(txId) ?? [];
  }

  unlinkExpense(incomeId: number, expenseId: number) {
    this.api.unlinkExpense(incomeId, expenseId).subscribe(() => {
      this.load();
      this.expandedLinkId.set(null);
    });
  }

  setReceivedPeriod(months: number | null) {
    this.receivedPeriod.set(months);
    this.api.getReceivedReimbursements(months ?? undefined).subscribe(data => this.received.set(data));
  }

  formatEur = formatEur;
  formatDate = formatDate;
}
