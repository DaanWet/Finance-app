import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { Transaction, Organization, Category, TransactionType, ImportResult } from '../../models';

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
  };

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.loadAll();
  }

  loadAll() {
    this.loading.set(true);
    this.api.getOrganizations().subscribe(orgs => this.organizations.set(orgs));
    this.api.getCategories().subscribe(cats => this.categories.set(cats));
    this.loadTransactions();
  }

  loadTransactions() {
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
    };
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
    };
    this.showModal.set(true);
  }

  closeModal() {
    this.showModal.set(false);
    this.importResult.set(null);
  }

  save() {
    const data = { ...this.form };
    if (data.amount !== undefined) data.amount = Number(data.amount);

    const editing = this.editingTx();
    if (editing) {
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

    this.importLoading.set(true);
    this.api.importIngCsv(file).subscribe({
      next: (result) => {
        this.importResult.set(result);
        this.importLoading.set(false);
        this.loadTransactions();
      },
      error: () => {
        this.importLoading.set(false);
        alert('Import mislukt. Controleer het CSV-formaat.');
      }
    });
    input.value = '';
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
    };
    return map[type] ?? type;
  }
}
