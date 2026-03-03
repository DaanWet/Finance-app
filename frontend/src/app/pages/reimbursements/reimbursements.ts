import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { ReimbursementGroup, Transaction } from '../../models';

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

  openConfirm(tx: Transaction) {
    this.confirmId.set(tx.id);
    this.confirmNote = '';
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

  setReceivedPeriod(months: number | null) {
    this.receivedPeriod.set(months);
    this.api.getReceivedReimbursements(months ?? undefined).subscribe(data => this.received.set(data));
  }

  formatEur(amount: number): string {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(amount);
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}
