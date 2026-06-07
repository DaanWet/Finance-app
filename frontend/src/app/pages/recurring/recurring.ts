import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { RecurringSeries, RecurringSummary, Transaction } from '../../models';
import { formatEur, formatDate } from '../../utils/format';

const CADENCE_LABELS: Record<string, string> = {
  weekly: 'Wekelijks', monthly: 'Maandelijks', quarterly: 'Per kwartaal', yearly: 'Jaarlijks',
};
const MONTHLY_FACTOR: Record<string, number> = {
  weekly: 4.33, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12,
};

@Component({
  selector: 'app-recurring',
  imports: [CommonModule, FormsModule],
  templateUrl: './recurring.html',
  styleUrl: './recurring.scss',
})
export class Recurring implements OnInit {
  series = signal<RecurringSeries[]>([]);
  summary = signal<RecurringSummary | null>(null);
  loading = signal(true);
  scanning = signal(false);
  savingId = signal<number | null>(null);
  editingNameId = signal<number | null>(null);
  editName = signal('');
  expandedId = signal<number | null>(null);
  expandedTx = signal<Transaction[]>([]);
  showInactive = signal(false);
  showIgnored = signal(false);

  suggested = computed(() => this.series().filter(s => s.status === 'suggested'));
  confirmedActive = computed(() => this.series().filter(s => s.status === 'confirmed' && s.active === 1));
  inactive = computed(() => this.series().filter(s => s.status !== 'ignored' && s.active === 0));
  ignored = computed(() => this.series().filter(s => s.status === 'ignored'));

  formatEur = formatEur;
  formatDate = formatDate;

  constructor(private api: ApiService) {}

  ngOnInit() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.getRecurring().subscribe({
      next: (data) => {
        this.series.set(data.series);
        this.summary.set(data.summary);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  scan() {
    this.scanning.set(true);
    this.api.scanRecurring().subscribe({
      next: () => { this.scanning.set(false); this.load(); },
      error: () => this.scanning.set(false),
    });
  }

  displayName(s: RecurringSeries): string {
    return s.custom_name || s.name || s.match_value;
  }

  cadenceLabel(c: string): string { return CADENCE_LABELS[c] ?? c; }

  monthlyAmount(s: RecurringSeries): number {
    return s.typical_amount * (MONTHLY_FACTOR[s.cadence] ?? 1);
  }

  setStatus(s: RecurringSeries, status: 'suggested' | 'confirmed' | 'ignored') {
    this.savingId.set(s.id);
    this.api.updateRecurring(s.id, { status }).subscribe({
      next: (updated) => {
        this.series.update(list => list.map(x => x.id === s.id ? updated : x));
        this.savingId.set(null);
        this.api.getRecurringSummary().subscribe(sum => this.summary.set(sum));
      },
      error: () => this.savingId.set(null),
    });
  }

  startEditName(s: RecurringSeries) {
    this.editingNameId.set(s.id);
    this.editName.set(this.displayName(s));
  }

  saveName(s: RecurringSeries) {
    const name = this.editName().trim();
    this.savingId.set(s.id);
    this.api.updateRecurring(s.id, { custom_name: name || null }).subscribe({
      next: (updated) => {
        this.series.update(list => list.map(x => x.id === s.id ? updated : x));
        this.editingNameId.set(null);
        this.savingId.set(null);
      },
      error: () => this.savingId.set(null),
    });
  }

  cancelEditName() { this.editingNameId.set(null); }

  toggleExpand(s: RecurringSeries) {
    if (this.expandedId() === s.id) { this.expandedId.set(null); return; }
    this.expandedId.set(s.id);
    this.expandedTx.set([]);
    this.api.getRecurringTransactions(s.id).subscribe(txs => this.expandedTx.set(txs));
  }
}
