import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { DashboardSummary, SplitwiseBalance } from '../../models';

@Component({
  selector: 'app-dashboard',
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  summary = signal<DashboardSummary | null>(null);
  balances = signal<SplitwiseBalance[]>([]);
  splitwiseTotal = signal(0);
  loading = signal(true);
  error = signal('');

  period = signal<'month' | 'last_month' | 'year'>('month');

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading.set(true);
    const { start, end } = this.getPeriodDates();

    this.api.getDashboard(start, end).subscribe({
      next: (data) => {
        this.summary.set(data);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Kan dashboard niet laden. Is de backend actief?');
        this.loading.set(false);
      }
    });

    this.api.getSplitwiseBalances().subscribe({
      next: (balances) => {
        this.balances.set(balances);
        const total = balances.reduce((sum, b) => sum + parseFloat(b.balance), 0);
        this.splitwiseTotal.set(total);
      },
      error: () => { /* Splitwise niet geconfigureerd - negeer */ }
    });
  }

  setPeriod(p: 'month' | 'last_month' | 'year') {
    this.period.set(p);
    this.load();
  }

  getPeriodDates(): { start: string; end: string } {
    const now = new Date();
    const p = this.period();
    if (p === 'month') {
      const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]!;
      return { start, end };
    } else if (p === 'last_month') {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0]!;
      return { start, end };
    } else {
      return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
    }
  }

  formatEur(amount: number): string {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(amount);
  }

  get categoryColors(): string[] {
    return this.summary()?.byCategory.map(c => c.color) ?? [];
  }

  get monthLabels(): string[] {
    return this.summary()?.monthlyTrend.map(m => this.monthLabel(m.month)) ?? [];
  }

  monthLabel(month: string): string {
    const [year, m] = month.split('-');
    return new Date(parseInt(year!), parseInt(m!) - 1).toLocaleString('nl-BE', { month: 'short' });
  }

  maxTrend(trend: { month: string; total: number }[]): number {
    return Math.max(...trend.map(t => t.total), 1);
  }
}
