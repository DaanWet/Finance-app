import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { Organization, Category, ClassificationRule } from '../../models';

@Component({
  selector: 'app-settings',
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  settings = signal<Record<string, string>>({});
  organizations = signal<Organization[]>([]);
  categories = signal<Category[]>([]);
  rules = signal<ClassificationRule[]>([]);

  workOrganizationId = signal<number | null>(null);

  splitwiseKey = '';
  splitwiseConnecting = signal(false);
  splitwiseConnected = signal(false);
  splitwiseUser = signal('');

  newOrg = { name: '', color: '#6366f1' };
  newCat = { name: '', color: '#94a3b8', icon: '' };
  newRule = { pattern: '', type: 'reimbursable' as 'personal' | 'reimbursable' | 'income', organization_id: null as number | null, category_id: null as number | null };

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.getSettings().subscribe(s => {
      this.settings.set(s);
      this.workOrganizationId.set(s['work_organization_id'] ? Number(s['work_organization_id']) : null);
      this.splitwiseKey = s['splitwise_api_key'] ?? '';
      if (s['splitwise_user_id']) {
        this.splitwiseConnected.set(true);
      }
    });
    this.api.getOrganizations().subscribe(orgs => this.organizations.set(orgs));
    this.api.getCategories().subscribe(cats => this.categories.set(cats));
    this.api.getClassificationRules().subscribe(rules => this.rules.set(rules));
  }

  saveSplitwiseKey() {
    this.api.setSetting('splitwise_api_key', this.splitwiseKey).subscribe(() => {
      this.splitwiseConnecting.set(true);
      this.api.connectSplitwise().subscribe({
        next: (user) => {
          this.splitwiseConnected.set(true);
          this.splitwiseUser.set(user.name);
          this.splitwiseConnecting.set(false);
        },
        error: () => {
          this.splitwiseConnected.set(false);
          this.splitwiseConnecting.set(false);
          alert('Kon geen verbinding maken met Splitwise. Controleer je API key.');
        }
      });
    });
  }

  addOrg() {
    if (!this.newOrg.name) return;
    this.api.createOrganization(this.newOrg).subscribe(org => {
      this.organizations.update(orgs => [...orgs, org]);
      this.newOrg = { name: '', color: '#6366f1' };
    });
  }

  deleteOrg(id: number) {
    if (!confirm('Organisatie verwijderen?')) return;
    this.api.deleteOrganization(id).subscribe(() => {
      this.organizations.update(orgs => orgs.filter(o => o.id !== id));
    });
  }

  addCat() {
    if (!this.newCat.name) return;
    this.api.createCategory({ ...this.newCat, icon: this.newCat.icon || null }).subscribe(cat => {
      this.categories.update(cats => [...cats, cat]);
      this.newCat = { name: '', color: '#94a3b8', icon: '' };
    });
  }

  deleteCat(id: number) {
    if (!confirm('Categorie verwijderen?')) return;
    this.api.deleteCategory(id).subscribe(() => {
      this.categories.update(cats => cats.filter(c => c.id !== id));
    });
  }

  addRule() {
    if (!this.newRule.pattern) return;
    this.api.createClassificationRule(this.newRule).subscribe(rule => {
      this.rules.update(r => [...r, rule]);
      this.newRule = { pattern: '', type: 'reimbursable', organization_id: null, category_id: null };
    });
  }

  deleteRule(id: number) {
    this.api.deleteClassificationRule(id).subscribe(() => {
      this.rules.update(r => r.filter(x => x.id !== id));
    });
  }

  saveWorkOrganization() {
    const id = this.workOrganizationId();
    this.api.setSetting('work_organization_id', id !== null ? String(id) : '').subscribe();
  }

  typeLabel(type: string): string {
    const map: Record<string, string> = { personal: 'Persoonlijk', reimbursable: 'Terugbetaalbaar', income: 'Inkomst' };
    return map[type] ?? type;
  }
}
