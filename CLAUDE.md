# Finance App — Project Context for Claude

## Stack
- **Backend**: Node.js + TypeScript + Express 5 + better-sqlite3
- **Frontend**: Angular 19 (standalone components, signals)
- **DB**: SQLite at `backend/data/finance.db`
- **Ports**: Backend 3000, Frontend 4222
- **CORS**: origin `http://localhost:4222`

## File structure
```
backend/src/
  index.ts          — Express entry, mounts 9 routers
  db.ts             — SQLite singleton, WAL-mode, foreign keys ON
  schema.ts         — DB schema + migrations + seed data
  routes/           — import, transactions, reimbursements, dashboard,
                      organizations, categories, settings, splitwise,
                      classificationRules
  queries/          — transactions.ts, reimbursements.ts, dashboard.ts
  services/aiAnalysis.ts — Claude API integratie
frontend/src/app/
  app.ts / app.routes.ts — root + lazy routes
  models/index.ts   — TypeScript interfaces (Transaction, etc.)
  services/api.service.ts — alle HTTP-methoden
  pages/            — dashboard, transactions, reimbursements, settings, splitwise
```

## DB schema (kern)
- **transactions**: id, description, amount (neg=uitgave, pos=inkomst), date, type (personal/reimbursable/income), category_id, organization_id, reimbursed_at, reimbursed_note, ing_transaction_id (UNIQUE), splitwise_expense_id, counterparty_account, category_confirmed (0=AI/onbevestigd, 1=bevestigd), notes
- **categories**: id, name, color, icon (emoji)
- **organizations**: id, name, color
- **settings**: key-value store (splitwise_api_key, splitwise_user_id)
- **classification_rules**: pattern, type, organization_id, category_id

## CSV import (ING)
- Separator: `;` (of `\t`, `,`)
- Nieuw: `Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht`
- Oud: `Datum;Naam;Rekening;Tegenrekening;Code;Afschrijving;Bijschrijving;Mededeling`
- Preview-endpoint: `POST /api/import/ing-csv/preview`
- Import-endpoint: `POST /api/import/ing-csv` met `{ selectedIndices: number[] | null }`
- 3-pass algoritme: (1) opslaan + AI, (2) within-batch voorschot-linking, (3) DB-niveau voorschot-matching

## AI analyse
- Model: claude-opus-4-6, env var `ANTHROPIC_API_KEY`
- Input per tx: index, date, amount, counterparty_iban, counterparty_name, omschrijving, detail, bericht
- Context: categories[], organizations[], splitwiseExpenses[]
- Output per tx: readable_name, category_id, organization_id, type, is_advance, advance_repaid_by_index, splitwise_expense_id, notes
- category_confirmed = 0 bij AI-classificatie, 1 bij handmatig/rules
- Fallback: classification rules (patroonmatch op description)
- Splitwise matching: bedrag binnen 5%, datum binnen 7 dagen

## Voorschot-detectie
- Within-batch: AI geeft `advance_repaid_by_index` → reimbursed_at = terugbetalingsdatum
- DB-niveau: positieve tx + zelfde counterparty_account + bedrag <10% verschil → auto-reimbursed

## Splitwise
- API key + user_id in settings tabel
- Expenses opgehaald tijdens import voor AI-context
- Routes: /splitwise/connect, /splitwise/expenses, /splitwise/balances

## API Endpoints

### Transactions (`/api/transactions`)
| Method | Endpoint | Functie |
|--------|----------|---------|
| GET | `/` | Lijst met filters: type, category_id, organization_id, date_from, date_to, search |
| GET | `/:id` | Enkel record met joined category/org |
| POST | `/` | Aanmaken |
| PUT | `/:id` | Bewerken (zet category_confirmed=1) |
| DELETE | `/:id` | Verwijderen |
| POST | `/confirm-all` | Alle onbevestigde markeren als bevestigd |

### Import (`/api/import`)
| Method | Endpoint | Functie |
|--------|----------|---------|
| POST | `/ing-csv/preview` | Parse CSV, detecteer duplicaten, return preview rows |
| POST | `/ing-csv` | Volledige import, body: `{ selectedIndices }` |

### Reimbursements (`/api/reimbursements`)
| Method | Endpoint | Functie |
|--------|----------|---------|
| GET | `/outstanding` | Onterugbetaald, gegroepeerd per org |
| GET | `/received` | Terugbetaald (laatste 3 maanden) |
| POST | `/:id/mark-received` | Body: `{ note?: string }` |

### Dashboard (`/api/dashboard`)
- `GET /?start=YYYY-MM-DD&end=YYYY-MM-DD`
- Response: personalTotal, reimbursableOutstanding, reimbursableCount, incomeTotal, byCategory[], monthlyTrend[]

### Overige
- Organizations/Categories/ClassificationRules: standaard CRUD (GET, POST, PUT /:id, DELETE /:id)
- Settings: `GET /api/settings`, `PUT /api/settings/:key`
- Splitwise: `/connect`, `/expenses`, `/balances`

## TypeScript Interfaces (models/index.ts)
```typescript
Transaction { id, description, amount, date, type, category_id, organization_id,
  reimbursed_at, reimbursed_note, ing_transaction_id, splitwise_expense_id,
  payment_method, notes, counterparty_account, category_confirmed,
  created_at, updated_at,
  // joined:
  category_name?, category_color?, category_icon?, organization_name?, organization_color? }

Organization { id, name, color }
Category { id, name, color, icon }
ReimbursementGroup { organization_id, organization_name, organization_color, total, count, transactions[] }
DashboardSummary { personalTotal, reimbursableOutstanding, reimbursableCount, incomeTotal, byCategory[], monthlyTrend[] }
SplitwiseExpense { id, description, total_cost, my_owed_share, my_paid_share, date, group_id, participants[] }
SplitwiseBalance { id, name, balance }
ClassificationRule { id, pattern, type, organization_id, category_id, organization_name?, category_name? }
CsvPreviewRow { index, date, description, amount, counterparty_account, ing_transaction_id, duplicate }
ImportResult { imported, skipped, total, ai_analyzed?, transactions[] }
```

## Frontend pagina's (signals-gebaseerd)

### transactions.ts
- Signals: transactions, organizations, categories, loading, showModal, editingTx, importResult, previewRows, selectedIndices
- Computed: unconfirmedCount, selectableCount, duplicateCount, isAllSelected
- Filters: filterType, filterCategory, filterOrg, filterSearch, filterDateFrom, filterDateTo

### dashboard.ts
- Signals: summary, balances, splitwiseTotal, loading, period ('month'|'last_month'|'year')

### reimbursements.ts
- Signals: outstanding, received, loading, markingId, confirmId, confirmNote

### settings.ts
- Splitwise API key koppelen, organizations/categories/rules CRUD

### splitwise.ts
- Signals: expenses, balances, loading, configured, error
