import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { SplitwiseExpense, SplitwiseBalance } from '../../models';

@Component({
  selector: 'app-splitwise',
  imports: [CommonModule, RouterLink],
  templateUrl: './splitwise.html',
  styleUrl: './splitwise.scss',
})
export class Splitwise implements OnInit {
  expenses = signal<SplitwiseExpense[]>([]);
  balances = signal<SplitwiseBalance[]>([]);
  loading = signal(true);
  configured = signal(false);
  error = signal('');

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set('');

    // Get last 3 months of expenses
    const datedAfter = new Date();
    datedAfter.setMonth(datedAfter.getMonth() - 3);
    const datedAfterStr = datedAfter.toISOString().split('T')[0]!;

    this.api.getSplitwiseExpenses(datedAfterStr).subscribe({
      next: (expenses) => {
        this.expenses.set(expenses);
        this.configured.set(true);
        this.loading.set(false);
      },
      error: (err) => {
        if (err.status === 400) {
          this.configured.set(false);
          this.error.set('Splitwise is niet geconfigureerd. Ga naar Instellingen om je API key in te voeren.');
        } else {
          this.error.set('Kon Splitwise expenses niet laden.');
        }
        this.loading.set(false);
      }
    });

    this.api.getSplitwiseBalances().subscribe({
      next: (b) => this.balances.set(b),
      error: () => {}
    });
  }

  refresh() { this.load(); }

  parseFloat(s: string): number { return parseFloat(s); }

  totalOwedToMe(): number {
    return this.balances()
      .filter(b => parseFloat(b.balance) > 0)
      .reduce((sum, b) => sum + parseFloat(b.balance), 0);
  }

  formatEur(amount: number): string {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(Math.abs(amount));
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}
