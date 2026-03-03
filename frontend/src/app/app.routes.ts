import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard').then(m => m.Dashboard) },
  { path: 'transactions', loadComponent: () => import('./pages/transactions/transactions').then(m => m.Transactions) },
  { path: 'reimbursements', loadComponent: () => import('./pages/reimbursements/reimbursements').then(m => m.Reimbursements) },
  { path: 'splitwise', loadComponent: () => import('./pages/splitwise/splitwise').then(m => m.Splitwise) },
  { path: 'expenses', loadComponent: () => import('./pages/expenses/expenses').then(m => m.Expenses) },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings').then(m => m.Settings) },
];
