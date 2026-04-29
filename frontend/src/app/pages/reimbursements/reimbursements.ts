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
  writtenOff = signal<ReimbursementGroup[]>([]);
  loading = signal(true);
  showReceivedExpanded = signal(false);
  showWrittenOffExpanded = signal(false);
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

  // Bulk write-off
  selectedIds = signal<Set<number>>(new Set());
  showBulkWriteOffModal = signal(false);
  bulkWriteOffNote = '';
  bulkPersonalShareFull = signal(false);
  bulkSaving = signal(false);
  writingOffId = signal<number | null>(null);

  // Single write-off
  showSingleWriteOffModal = signal(false);
  singleWriteOffTx = signal<Transaction | null>(null);
  singleWriteOffNote = '';
  singleWriteOffPersonalShare = signal<number>(0);

  bulkSelectedCount = computed(() => this.selectedIds().size);
  absSingleAmount = computed(() => {
    const tx = this.singleWriteOffTx();
    return tx ? Math.abs(tx.amount) : 0;
  });

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
    this.api.getWrittenOffReimbursements().subscribe(data => this.writtenOff.set(data));
  }

  totalWrittenOff(): number {
    return this.writtenOff().reduce((sum, g) => sum + g.total, 0);
  }

  // --- Bulk selection ---
  isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  toggleSelection(id: number) {
    const next = new Set(this.selectedIds());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selectedIds.set(next);
  }

  toggleSelectAllInGroup(group: ReimbursementGroup) {
    const next = new Set(this.selectedIds());
    const allSelected = group.transactions.every(tx => next.has(tx.id));
    for (const tx of group.transactions) {
      if (allSelected) next.delete(tx.id);
      else next.add(tx.id);
    }
    this.selectedIds.set(next);
  }

  isGroupAllSelected(group: ReimbursementGroup): boolean {
    if (group.transactions.length === 0) return false;
    const sel = this.selectedIds();
    return group.transactions.every(tx => sel.has(tx.id));
  }

  clearSelection() {
    this.selectedIds.set(new Set());
  }

  // --- Single write-off ---
  openSingleWriteOff(tx: Transaction) {
    this.singleWriteOffTx.set(tx);
    this.singleWriteOffNote = '';
    this.singleWriteOffPersonalShare.set(0);
    this.showSingleWriteOffModal.set(true);
  }

  cancelSingleWriteOff() {
    this.showSingleWriteOffModal.set(false);
    this.singleWriteOffTx.set(null);
    this.singleWriteOffNote = '';
    this.singleWriteOffPersonalShare.set(0);
  }

  setSingleWriteOffFullPersonal() {
    const tx = this.singleWriteOffTx();
    if (tx) this.singleWriteOffPersonalShare.set(Math.abs(tx.amount));
  }

  confirmSingleWriteOff() {
    const tx = this.singleWriteOffTx();
    if (!tx) return;
    const share = this.singleWriteOffPersonalShare() > 0 ? this.singleWriteOffPersonalShare() : undefined;
    this.writingOffId.set(tx.id);
    this.api.markWrittenOff(tx.id, this.singleWriteOffNote || undefined, share).subscribe({
      next: () => {
        this.writingOffId.set(null);
        this.cancelSingleWriteOff();
        this.load();
      },
      error: () => this.writingOffId.set(null),
    });
  }

  // --- Bulk write-off ---
  openBulkWriteOff() {
    this.bulkWriteOffNote = '';
    this.bulkPersonalShareFull.set(false);
    this.showBulkWriteOffModal.set(true);
  }

  cancelBulkWriteOff() {
    this.showBulkWriteOffModal.set(false);
    this.bulkWriteOffNote = '';
    this.bulkPersonalShareFull.set(false);
  }

  confirmBulkWriteOff() {
    const ids = Array.from(this.selectedIds());
    if (ids.length === 0) return;
    this.bulkSaving.set(true);
    const mode = this.bulkPersonalShareFull() ? 'full' : 'none';
    this.api.bulkMarkWrittenOff(ids, this.bulkWriteOffNote || undefined, mode).subscribe({
      next: () => {
        this.bulkSaving.set(false);
        this.cancelBulkWriteOff();
        this.clearSelection();
        this.load();
      },
      error: () => this.bulkSaving.set(false),
    });
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
