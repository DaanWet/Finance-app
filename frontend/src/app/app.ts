import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  navItems = [
    { path: '/dashboard', label: 'Dashboard', icon: '📊' },
    { path: '/transactions', label: 'Transacties', icon: '💳' },
    { path: '/reimbursements', label: 'Terugbetalingen', icon: '↩️' },
    { path: '/splitwise', label: 'Splitwise', icon: '🤝' },
    { path: '/expenses', label: 'Onkosten', icon: '🧾' },
    { path: '/recurring', label: 'Vaste lasten', icon: '🔁' },
    { path: '/settings', label: 'Instellingen', icon: '⚙️' },
  ];
}
