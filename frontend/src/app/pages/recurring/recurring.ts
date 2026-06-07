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
  expandingTx = signal(false);
  showInactive = signal(false);
  showIgnored = signal(false);

  // Partitie zonder overlap: suggested → Voorgesteld; confirmed+actief → Bevestigd;
  // confirmed+inactief → Inactief; ignored → Genegeerd.
  suggested = computed(() => this.series().filter(s => s.status === 'suggested'));
  confirmedActive = computed(() => this.series().filter(s => s.status === 'confirmed' && s.active === 1));
  inactive = computed(() => this.series().filter(s => s.status === 'confirmed' && s.active === 0));
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

  /** Gedeelde optimistische update: patch de reeks in de lijst, met optionele vervolgactie. */
  private updateOne(
    id: number,
    data: { status?: RecurringSeries['status']; custom_name?: string | null },
    onSuccess?: () => void,
  ) {
    this.savingId.set(id);
    this.api.updateRecurring(id, data).subscribe({
      next: (updated) => {
        this.series.update(list => list.map(x => x.id === id ? updated : x));
        this.savingId.set(null);
        onSuccess?.();
      },
      error: () => this.savingId.set(null),
    });
  }

  setStatus(s: RecurringSeries, status: 'suggested' | 'confirmed' | 'ignored') {
    this.updateOne(s.id, { status }, () =>
      this.api.getRecurringSummary().subscribe(sum => this.summary.set(sum)));
  }

  startEditName(s: RecurringSeries) {
    this.editingNameId.set(s.id);
    this.editName.set(this.displayName(s));
  }

  saveName(s: RecurringSeries) {
    const name = this.editName().trim();
    this.updateOne(s.id, { custom_name: name || null }, () => this.editingNameId.set(null));
  }

  cancelEditName() { this.editingNameId.set(null); }

  toggleExpand(s: RecurringSeries) {
    if (this.expandedId() === s.id) { this.expandedId.set(null); return; }
    this.expandedId.set(s.id);
    this.expandedTx.set([]);
    this.expandingTx.set(true);
    this.api.getRecurringTransactions(s.id).subscribe({
      next: (txs) => { this.expandedTx.set(txs); this.expandingTx.set(false); },
      error: () => this.expandingTx.set(false),
    });
  }
}
