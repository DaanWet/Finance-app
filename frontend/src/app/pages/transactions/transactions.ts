import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { Transaction, Organization, Category, TransactionType, ImportResult, CsvPreviewRow, SplitwiseExpense, ReimbursementLink, ExpenseCandidateTransaction, IncomeCandidateTransaction } from '../../models';

@Component({
  selector: 'app-transactions',
  imports: [CommonModule, FormsModule],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
})
export class Transactions implements OnInit {
  transactions = signal<Transaction[]>([]);
  organizations = signal<Organization[]>([]);
  categories = signal<Category[]>([]);
  loading = signal(true);
  showModal = signal(false);
  editingTx = signal<Transaction | null>(null);
  importResult = signal<ImportResult | null>(null);
  importLoading = signal(false);
  unconfirmedCount = computed(() => this.transactions().filter(tx => tx.category_confirmed === 0).length);
  reanalyzingId = signal<number | null>(null);
  splitwiseExpenses = signal<SplitwiseExpense[]>([]);
  splitwiseLoading = signal(false);
  splitwiseSearch = signal('');
  splitwiseShowAll = signal(false);
  splitwiseDetail = signal<SplitwiseExpense | null>(null);
  formAmount = signal<number | undefined>(undefined);
  formSplitwiseId = signal<string | null>(null);

  // Bulk selection
  selectedIds = signal<Set<number>>(new Set());
  bulkLoading = signal(false);
  bulkSelectedCount = computed(() => this.selectedIds().size);
  isAllPageSelected = computed(() => {
    const txs = this.transactions();
    return txs.length > 0 && txs.every(tx => this.selectedIds().has(tx.id));
  });
  isSomeSelected = computed(() => {
    const selected = this.selectedIds();
    const txs = this.transactions();
    return selected.size > 0 && !txs.every(tx => selected.has(tx.id));
  });
  selectedUnconfirmedCount = computed(() => {
    const ids = this.selectedIds();
    return this.transactions().filter(tx => ids.has(tx.id) && tx.category_confirmed === 0).length;
  });

  splitwiseExpenseMap = computed(() =>
    new Map(this.splitwiseExpenses().map(e => [e.id.toString(), e]))
  );

  getSplitwiseExpense(id: string | number | null | undefined): SplitwiseExpense | undefined {
    if (id == null) return undefined;
    const normalized = String(parseInt(String(id), 10));
    return this.splitwiseExpenseMap().get(normalized) ?? this.splitwiseExpenseMap().get(String(id));
  }

  filteredSplitwise = computed(() => {
    const all = this.splitwiseExpenses();
    const search = this.splitwiseSearch().toLowerCase();
    const amount = Math.abs(Number(this.formAmount()) || 0);
    const showAll = this.splitwiseShowAll();
    const currentId = this.formSplitwiseId();

    let list = all.filter(e => e.my_paid_share > 0);
    if (search) {
      list = list.filter(e =>
        e.description.toLowerCase().includes(search) ||
        e.my_paid_share.toString().includes(search)
      );
    } else if (!showAll && amount > 0) {
      list = list.filter(e => Math.abs(e.my_paid_share - amount) / amount <= 0.1);
    }

    // Altijd de huidige gekoppelde expense tonen
    if (currentId != null) {
      const normalized = String(parseInt(String(currentId), 10));
      if (!list.some(e => String(e.id) === normalized)) {
        const linked = all.find(e => String(e.id) === normalized);
        if (linked) list = [linked, ...list];
      }
    }

    return list;
  });

  // Import preview
  previewRows = signal<CsvPreviewRow[]>([]);
  selectedIndices = signal<Set<number>>(new Set());
  showImportPreview = signal(false);
  previewLoading = signal(false);
  previewFile: File | null = null;
  previewDateFrom = signal('');
  previewDateTo = signal('');

  filteredPreviewRows = computed(() => {
    const rows = this.previewRows();
    const from = this.previewDateFrom();
    const to = this.previewDateTo();
    if (!from && !to) return rows;
    return rows.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
  });

  selectedCount = computed(() => this.selectedIndices().size);
  totalSelectableCount = computed(() => this.previewRows().filter(r => !r.duplicate).length);
  selectableCount = computed(() => this.filteredPreviewRows().filter(r => !r.duplicate).length);
  duplicateCount = computed(() => this.filteredPreviewRows().filter(r => r.duplicate).length);
  isAllSelected = computed(() => {
    const visible = this.filteredPreviewRows().filter(r => !r.duplicate);
    return visible.length > 0 && visible.every(r => this.selectedIndices().has(r.index));
  });

  // Reimbursement links (in edit modal)
  editLinks = signal<{ as_income: ReimbursementLink[]; as_expense: ReimbursementLink[] }>({ as_income: [], as_expense: [] });
  expenseCandidates = signal<ExpenseCandidateTransaction[]>([]);
  showAddExpenseLink = signal(false);
  linkingExpenseId = signal<number | null>(null);
  linkingAmount = signal<number>(0);
  linkSaving = signal(false);
  // Reimbursable → income linking
  incomeCandidates = signal<IncomeCandidateTransaction[]>([]);
  showAddIncomeLink = signal(false);
  selectedIncomeId = signal<number | null>(null);
  linkingIncomeAmount = signal<number>(0);

  // Filters
  filterType = '';
  filterCategory = '';
  filterOrg = '';
  filterSearch = '';
  filterDateFrom = '';
  filterDateTo = '';

  // Form
  form: Partial<Transaction> & { type: TransactionType } = {
    description: '',
    amount: undefined,
    date: new Date().toISOString().split('T')[0],
    type: 'personal',
    category_id: null,
    organization_id: null,
    notes: '',
    splitwise_expense_id: null,
  };

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.loadAll();
  }

  loadAll() {
    this.loading.set(true);
    this.api.getOrganizations().subscribe(orgs => this.organizations.set(orgs));
    this.api.getCategories().subscribe(cats => this.categories.set(cats));
    this.loadSplitwiseExpenses();
    this.loadTransactions();
  }

  loadTransactions() {
    this.clearSelection();
    const filters: Record<string, string> = {};
    if (this.filterType) filters['type'] = this.filterType;
    if (this.filterCategory) filters['category_id'] = this.filterCategory;
    if (this.filterOrg) filters['organization_id'] = this.filterOrg;
    if (this.filterSearch) filters['search'] = this.filterSearch;
    if (this.filterDateFrom) filters['date_from'] = this.filterDateFrom;
    if (this.filterDateTo) filters['date_to'] = this.filterDateTo;

    this.api.getTransactions(filters).subscribe({
      next: txs => { this.transactions.set(txs); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  openAdd() {
    this.editingTx.set(null);
    this.form = {
      description: '',
      amount: undefined,
      date: new Date().toISOString().split('T')[0],
      type: 'personal',
      category_id: null,
      organization_id: null,
      notes: '',
      splitwise_expense_id: null,
    };
    this.formAmount.set(undefined);
    this.formSplitwiseId.set(null);
    this.showModal.set(true);
  }

  openEdit(tx: Transaction) {
    this.editingTx.set(tx);
    this.form = {
      description: tx.description,
      amount: tx.amount,
      date: tx.date,
      type: tx.type,
      category_id: tx.category_id,
      organization_id: tx.organization_id,
      notes: tx.notes ?? '',
      splitwise_expense_id: tx.splitwise_expense_id != null
        ? String(parseInt(String(tx.splitwise_expense_id), 10))
        : null,
    };
    this.formAmount.set(tx.amount);
    this.formSplitwiseId.set(this.form.splitwise_expense_id ?? null);
    this.splitwiseSearch.set('');
    this.splitwiseShowAll.set(false);
    this.showAddExpenseLink.set(false);
    this.showAddIncomeLink.set(false);
    this.editLinks.set({ as_income: [], as_expense: [] });
    this.showModal.set(true);
    this.loadSplitwiseExpenses();
    if (tx.type === 'income' || tx.type === 'reimbursable') {
      this.loadLinks(tx.id);
    }
  }

  closeModal() {
    this.showModal.set(false);
    this.importResult.set(null);
  }

  openSplitwiseDetail(tx: Transaction, event: Event) {
    event.stopPropagation();
    this.splitwiseDetail.set(this.getSplitwiseExpense(tx.splitwise_expense_id) ?? null);
  }

  participantName(p: { user_id: number; first_name: string | null; last_name: string | null }): string {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
    return name || `Deelnemer #${p.user_id}`;
  }

  loadSplitwiseExpenses() {
    if (this.splitwiseExpenses().length > 0 || this.splitwiseLoading()) return;
    this.splitwiseLoading.set(true);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const dated_after = sixMonthsAgo.toISOString().split('T')[0];
    this.api.getSplitwiseExpenses(dated_after).subscribe({
      next: (expenses) => { this.splitwiseExpenses.set(expenses); this.splitwiseLoading.set(false); },
      error: () => this.splitwiseLoading.set(false),
    });
  }

  confirmTransaction(tx: Transaction) {
    this.api.updateTransaction(tx.id, { category_confirmed: 1 } as Partial<Transaction>).subscribe(() => {
      this.transactions.update(txs => txs.map(t => t.id === tx.id ? { ...t, category_confirmed: 1 } : t));
    });
  }

  confirmAll() {
    this.api.confirmAllTransactions().subscribe(() => {
      this.transactions.update(txs => txs.map(t => ({ ...t, category_confirmed: 1 })));
    });
  }

  toggleSelection(id: number) {
    const set = new Set(this.selectedIds());
    if (set.has(id)) set.delete(id); else set.add(id);
    this.selectedIds.set(set);
  }

  toggleAllSelection() {
    const txs = this.transactions();
    const cur = new Set(this.selectedIds());
    if (this.isAllPageSelected()) {
      txs.forEach(tx => cur.delete(tx.id));
    } else {
      txs.forEach(tx => cur.add(tx.id));
    }
    this.selectedIds.set(cur);
  }

  clearSelection() {
    this.selectedIds.set(new Set());
  }

  bulkConfirm() {
    const ids = Array.from(this.selectedIds());
    if (ids.length === 0) return;
    this.bulkLoading.set(true);
    this.api.bulkConfirm(ids).subscribe({
      next: () => {
        this.transactions.update(txs =>
          txs.map(t => ids.includes(t.id) ? { ...t, category_confirmed: 1 } : t)
        );
        this.clearSelection();
        this.bulkLoading.set(false);
      },
      error: () => {
        this.bulkLoading.set(false);
        alert('Bulk bevestiging mislukt');
      },
    });
  }

  bulkDelete() {
    const ids = Array.from(this.selectedIds());
    if (ids.length === 0) return;
    if (!confirm(`${ids.length} transactie(s) verwijderen? Dit kan niet ongedaan worden.`)) return;
    this.bulkLoading.set(true);
    this.api.bulkDelete(ids).subscribe({
      next: () => {
        this.transactions.update(txs => txs.filter(t => !ids.includes(t.id)));
        this.clearSelection();
        this.bulkLoading.set(false);
      },
      error: () => {
        this.bulkLoading.set(false);
        alert('Bulk verwijdering mislukt');
      },
    });
  }

  bulkReanalyze() {
    const ids = Array.from(this.selectedIds());
    if (ids.length === 0) return;
    this.bulkLoading.set(true);
    this.api.bulkReanalyze(ids).subscribe({
      next: ({ transactions: updated }) => {
        const updatedMap = new Map(updated.map(t => [t.id, t]));
        this.transactions.update(txs =>
          txs.map(t => updatedMap.get(t.id) ?? t)
        );
        this.clearSelection();
        this.bulkLoading.set(false);
      },
      error: () => {
        this.bulkLoading.set(false);
        alert('Bulk heranalyse mislukt');
      },
    });
  }

  reanalyze(tx: Transaction) {
    this.reanalyzingId.set(tx.id);
    this.api.reanalyzeTransaction(tx.id).subscribe({
      next: (updated) => {
        this.transactions.update(txs => txs.map(t => t.id === tx.id ? { ...t, ...updated } : t));
        this.reanalyzingId.set(null);
      },
      error: () => {
        this.reanalyzingId.set(null);
        alert('Heranalyse mislukt');
      },
    });
  }

  // --- Reimbursement links ---
  loadLinks(txId: number) {
    this.api.getReimbursementLinks(txId).subscribe(links => {
      this.editLinks.set(links);
    });
  }

  openAddExpenseLink() {
    this.showAddExpenseLink.set(true);
    this.linkingExpenseId.set(null);
    this.linkingAmount.set(0);
    this.api.getExpenseCandidates().subscribe(candidates => {
      this.expenseCandidates.set(candidates);
    });
  }

  selectExpenseCandidate(expId: number) {
    this.linkingExpenseId.set(expId);
    const candidate = this.expenseCandidates().find(c => c.id === expId);
    if (candidate) this.linkingAmount.set(Math.abs(candidate.amount));
  }

  confirmAddExpenseLink() {
    const incomeId = this.editingTx()?.id;
    const expenseId = this.linkingExpenseId();
    if (!incomeId || !expenseId) return;

    this.linkSaving.set(true);
    this.api.linkIncomeToExpenses({
      income_transaction_id: incomeId,
      expenses: [{ expense_transaction_id: expenseId, amount: this.linkingAmount() }],
    }).subscribe({
      next: () => {
        this.linkSaving.set(false);
        this.showAddExpenseLink.set(false);
        this.loadLinks(incomeId);
      },
      error: () => this.linkSaving.set(false),
    });
  }

  removeExpenseLink(link: ReimbursementLink) {
    this.api.unlinkExpense(link.income_transaction_id, link.expense_transaction_id).subscribe(() => {
      const txId = this.editingTx()?.id;
      if (txId) this.loadLinks(txId);
    });
  }

  linkedTotal(): number {
    return this.editLinks().as_income.reduce((sum, l) => sum + l.amount, 0);
  }

  // --- Reimbursable → income linking ---
  openAddIncomeLink() {
    this.showAddIncomeLink.set(true);
    this.selectedIncomeId.set(null);
    const tx = this.editingTx();
    this.linkingIncomeAmount.set(tx ? Math.abs(tx.amount) : 0);
    this.api.getIncomeCandidates().subscribe(candidates => {
      this.incomeCandidates.set(candidates);
    });
  }

  confirmAddIncomeLink() {
    const expenseId = this.editingTx()?.id;
    const incomeId = this.selectedIncomeId();
    if (!expenseId || !incomeId) return;

    this.linkSaving.set(true);
    this.api.linkIncomeToExpenses({
      income_transaction_id: incomeId,
      expenses: [{ expense_transaction_id: expenseId, amount: this.linkingIncomeAmount() }],
    }).subscribe({
      next: () => {
        this.linkSaving.set(false);
        this.showAddIncomeLink.set(false);
        this.loadLinks(expenseId);
      },
      error: () => this.linkSaving.set(false),
    });
  }

  save() {
    const data: Partial<Transaction> & { type: TransactionType } = { ...this.form };
    if (data.amount !== undefined) data.amount = Number(data.amount);

    if (data.splitwise_expense_id) {
      const sw = this.getSplitwiseExpense(data.splitwise_expense_id);
      data.splitwise_owed_share = sw ? sw.my_owed_share : null;
    } else {
      data.splitwise_owed_share = null;
    }

    const editing = this.editingTx();
    if (editing) {
      (data as Partial<Transaction>).category_confirmed = 1;
      this.api.updateTransaction(editing.id, data).subscribe(() => {
        this.closeModal();
        this.loadTransactions();
      });
    } else {
      this.api.createTransaction(data).subscribe(() => {
        this.closeModal();
        this.loadTransactions();
      });
    }
  }

  delete(tx: Transaction) {
    if (!confirm(`Verwijder "${tx.description}"?`)) return;
    this.api.deleteTransaction(tx.id).subscribe(() => this.loadTransactions());
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';

    this.previewLoading.set(true);
    this.api.previewIngCsv(file).subscribe({
      next: ({ rows }) => {
        this.previewFile = file;
        this.previewRows.set(rows);
        this.selectedIndices.set(new Set(rows.filter(r => !r.duplicate).map(r => r.index)));
        this.previewDateFrom.set('');
        this.previewDateTo.set('');
        this.previewLoading.set(false);
        this.showImportPreview.set(true);
      },
      error: () => {
        this.previewLoading.set(false);
        alert('Kon CSV niet inlezen. Controleer het formaat.');
      },
    });
  }

  toggleRow(index: number) {
    const set = new Set(this.selectedIndices());
    if (set.has(index)) set.delete(index); else set.add(index);
    this.selectedIndices.set(set);
  }

  toggleAll() {
    const visible = this.filteredPreviewRows().filter(r => !r.duplicate);
    const cur = new Set(this.selectedIndices());
    if (this.isAllSelected()) {
      visible.forEach(r => cur.delete(r.index));
    } else {
      visible.forEach(r => cur.add(r.index));
    }
    this.selectedIndices.set(cur);
  }

  confirmImport() {
    if (!this.previewFile) return;
    const indices = Array.from(this.selectedIndices());
    this.importLoading.set(true);
    this.showImportPreview.set(false);
    this.api.importIngCsv(this.previewFile, indices).subscribe({
      next: (result) => {
        this.importResult.set(result);
        this.importLoading.set(false);
        this.previewFile = null;
        this.loadTransactions();
      },
      error: () => {
        this.importLoading.set(false);
        this.previewFile = null;
        alert('Import mislukt. Controleer het CSV-formaat.');
      },
    });
  }

  formatEur(amount: number): string {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(Math.abs(amount));
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  typeBadge(type: string): string {
    const map: Record<string, string> = {
      personal: 'Persoonlijk',
      reimbursable: 'Terugbetaalbaar',
      income: 'Inkomst',
      savings: 'Sparen',
    };
    return map[type] ?? type;
  }
}
