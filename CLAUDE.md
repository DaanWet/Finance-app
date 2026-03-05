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
  index.ts          — Express entry, mounts 10 routers
  db.ts             — SQLite singleton, WAL-mode, foreign keys ON
  schema.ts         — DB schema + migrations + seed data
  routes/           — import, transactions, reimbursements, dashboard,
                      organizations, categories, settings, splitwise,
                      classificationRules, expenses
  queries/          — transactions.ts, reimbursements.ts, reimbursementLinks.ts, dashboard.ts
  services/
    aiAnalysis.ts       — Claude API integratie
    gmailService.ts     — Google OAuth + NMBS ticket parsing
    excelExport.ts      — Excel onkostennota generatie
    pdfExport.ts        — PDF bonnen-bundel generatie
    csvParser.ts        — ING CSV parsing (oud + nieuw formaat)
    importService.ts    — 4-pass import orchestratie
    reanalyzeService.ts — AI heranalyse (single + bulk)
    advanceMatching.ts  — Voorschot-detectie en linking
    importHelpers.ts    — NMBS ticket matching + Splitwise expenses fetch + Gmail ticket matching
    analysisHelpers.ts  — Gedeelde AI-analyse helpers (loadAnalysisContext, resolveSplitwise, applyAiResult, TransactionClassification)
  helpers/
    settings.ts     — getSetting(), upsertSetting() voor settings tabel
    constants.ts    — SETTING_KEYS, TRANSACTION_TYPES, note-constanten
    errors.ts       — errorMessage() helper
    expenses.ts     — parseMonth(), getMonthDateRange(), getWorkOrgId() gedeelde expense helpers
frontend/src/app/
  app.ts / app.routes.ts — root + lazy routes
  models/index.ts   — TypeScript interfaces (Transaction, etc.)
  services/api.service.ts — alle HTTP-methoden
  utils/format.ts   — formatEur(), formatDate(), typeBadge() gedeelde helpers
  pages/            — dashboard, transactions, reimbursements, settings,
                      splitwise, expenses
```

## DB schema (kern)
- **transactions**: id, description, amount (neg=uitgave, pos=inkomst), date, type (personal/reimbursable/income/savings), category_id, organization_id, reimbursed_at, reimbursed_note, ing_transaction_id (UNIQUE), splitwise_expense_id, splitwise_owed_share, counterparty_account, counterparty_name, original_description, category_confirmed (0=AI/onbevestigd, 1=bevestigd), notes
- **expense_receipts**: id, transaction_id (FK → transactions), filename, content_type, data (BLOB), gmail_message_id, created_at
- **categories**: id, name, color, icon (emoji)
- **organizations**: id, name, color
- **settings**: key-value store (splitwise_api_key, splitwise_user_id, work_organization_id, google_refresh_token, google_access_token)
- **reimbursement_links**: id, income_transaction_id (FK → transactions), expense_transaction_id (FK → transactions), amount, created_at; UNIQUE(income_transaction_id, expense_transaction_id)
- **classification_rules**: pattern, type, organization_id, category_id

## CSV import (ING)
- Separator: `;` (of `\t`, `,`)
- Nieuw: `Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht`
- Oud: `Datum;Naam;Rekening;Tegenrekening;Code;Afschrijving;Bijschrijving;Mededeling`
- Preview-endpoint: `POST /api/import/ing-csv/preview`
- Import-endpoint: `POST /api/import/ing-csv` met `{ selectedIndices: number[] | null }`
- 4-pass algoritme: (1) opslaan + AI, (2) within-batch voorschot-linking, (3) DB-niveau voorschot-matching, (4) NMBS ticket matching

## AI analyse
- Model: claude-opus-4-6, env var `ANTHROPIC_API_KEY`
- Input per tx: index, date, amount, counterparty_iban, counterparty_name, omschrijving, detail, bericht
- Context: categories[], organizations[], splitwiseExpenses[]
- Output per tx: readable_name, category_id, organization_id, type, is_advance, advance_repaid_by_index, splitwise_expense_id, notes
- category_confirmed = 0 bij AI-classificatie, 1 bij handmatig/rules
- Fallback: classification rules (patroonmatch op description)
- Splitwise matching: bedrag binnen 5%, datum binnen 7 dagen

## NMBS ticket auto-matching
- Draait bij import (pass 4), bulk-reanalyze en single reanalyze
- Vereist: Gmail connected + work_organization_id geconfigureerd (skipt silently anders)
- Haalt NMBS tickets op via `fetchNmbsTickets()` voor de datumrange van de transacties
- Match criteria: exact bedrag (`abs(tx.amount) === ticket.amount`) en exact datum (`tx.date === ticket.date`)
- Bij match: zet `type='reimbursable'`, `organization_id=workOrgId`, slaat receipt PDF op, voegt trajectory toe aan notes
- Gedeelde helper: `matchNmbsTickets(db, transactionIds)` in `routes/import.ts`

## Voorschot-detectie
- Within-batch: AI geeft `advance_repaid_by_index` → reimbursed_at = terugbetalingsdatum + reimbursement_link
- DB-niveau: positieve tx + zelfde counterparty_account + bedrag <10% verschil → auto-reimbursed + reimbursement_link

## Reimbursement linking
- Eén inkomst kan meerdere terugbetaalbare uitgaven dekken via `reimbursement_links`
- `amount` in link legt vast hoeveel van de uitgave gedekt is (voor partiële terugbetalingen / persoonlijke aftrek)
- Bij link aanmaken: `reimbursed_at` wordt automatisch gezet op de expense
- Bij ontkoppelen: `reimbursed_at` wordt gecleard als expense geen andere links meer heeft
- Bij verwijderen van transactie: cleanup via `cleanupLinksForDeletedTransaction()` in applicatiecode
- Bidirectioneel: vanuit inkomst → expenses selecteren (transactions page), vanuit expense → inkomst selecteren (reimbursements page)

## Splitwise
- API key + user_id in settings tabel
- Expenses opgehaald tijdens import voor AI-context
- Routes: /splitwise/connect, /splitwise/expenses, /splitwise/balances

## Onkostennota-module
- Werkuitgaven = transacties met `type='reimbursable'` + `organization_id` = `work_organization_id` setting
- Markeren gebeurt op de transactiepagina (type + organisatie instellen), onkostenpagina toont enkel resultaat
- Bonnen (PDF/JPEG/PNG, max 10MB) opgeslagen als BLOB in `expense_receipts`
- **Gmail-integratie**: OAuth2 met googleapis, zoekt NMBS/SNCB emails (noreply@b-rail.be, info@nmbs.be, eticket@nmbs.be), parsed HTML voor bedrag/stations/datum, genereert PDF-ticket, auto-matcht op werkuitgaven (±1 dag, ±5% bedrag)
- **Excel export**: template `backend/data/expense_template.xlsx`, DEEL I transport (traject, parking, km), DEEL II overige kosten
- **PDF export**: combineert alle bonnen in één PDF met voorblad
- **Env vars**: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (`http://localhost:3000/api/expenses/gmail/callback`)

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
| POST | `/bulk-confirm` | Bulk bevestigen per ID-lijst |
| POST | `/bulk-delete` | Bulk verwijderen per ID-lijst |
| POST | `/bulk-reanalyze` | Bulk AI re-analyse per ID-lijst |
| POST | `/:id/reanalyze` | Enkele transactie AI re-analyse |

### Import (`/api/import`)
| Method | Endpoint | Functie |
|--------|----------|---------|
| POST | `/ing-csv/preview` | Parse CSV, detecteer duplicaten, return preview rows |
| POST | `/ing-csv` | Volledige import, body: `{ selectedIndices }` |

### Reimbursements (`/api/reimbursements`)
| Method | Endpoint | Functie |
|--------|----------|---------|
| GET | `/outstanding` | Onterugbetaald, gegroepeerd per org |
| GET | `/received` | Terugbetaald (`?months=N`, default 3) |
| POST | `/:id/mark-received` | Body: `{ note?: string }` — handmatig markeren zonder link |
| POST | `/link` | Koppel inkomst aan expenses. Body: `{ income_transaction_id, expenses: [{expense_transaction_id, amount}] }` |
| DELETE | `/link/:incomeId/:expenseId` | Ontkoppel één expense van inkomst |
| GET | `/links/:transactionId` | Links voor een transactie (retourneert `{ as_income, as_expense }`) |
| GET | `/income-candidates` | Inkomsten beschikbaar voor koppeling `?organization_id=N` |
| GET | `/expense-candidates` | Openstaande expenses beschikbaar voor koppeling `?organization_id=N` |

### Dashboard (`/api/dashboard`)
- `GET /?start=YYYY-MM-DD&end=YYYY-MM-DD`
- Response: personalTotal, reimbursableOutstanding, reimbursableCount, incomeTotal, savingsTotal, splitwisePaidForOthers, byCategory[], monthlyTrend[]

### Expenses (`/api/expenses`)
| Method | Endpoint | Functie |
|--------|----------|---------|
| GET | `/` | Alle werkkosten (open + terugbetaald), gefilterd op work_organization_id |
| POST | `/:id/receipt` | Upload bon (multipart, max 10MB) |
| DELETE | `/:id/receipt/:receiptId` | Bon verwijderen |
| GET | `/gmail/auth` | Google OAuth redirect |
| GET | `/gmail/callback` | OAuth callback |
| GET | `/gmail/status` | Gmail connectie-status |
| POST | `/gmail/fetch` | NMBS tickets ophalen en matchen |
| GET | `/export/excel` | Excel onkostennota download |
| GET | `/export/pdf` | PDF met alle bonnen |

### Overige
- Organizations/Categories/ClassificationRules: standaard CRUD (GET, POST, PUT /:id, DELETE /:id)
- Settings: `GET /api/settings`, `PUT /api/settings/:key`
- Splitwise: `/connect`, `/expenses`, `/balances`

## TypeScript Interfaces (models/index.ts)
```typescript
Transaction { id, description, amount, date, type, category_id, organization_id,
  reimbursed_at, reimbursed_note, ing_transaction_id, splitwise_expense_id,
  payment_method, notes, counterparty_account, counterparty_name,
  original_description, category_confirmed,
  created_at, updated_at,
  // joined:
  category_name?, category_color?, category_icon?, organization_name?, organization_color? }

Organization { id, name, color }
Category { id, name, color, icon }
ReimbursementGroup { organization_id, organization_name, organization_color, total, count, transactions[] }
DashboardSummary { personalTotal, reimbursableOutstanding, reimbursableCount, incomeTotal,
  savingsTotal, splitwisePaidForOthers, byCategory[], monthlyTrend[] }
SplitwiseExpense { id, description, total_cost, my_owed_share, my_paid_share, date, group_id, group_name, participants[] }
SplitwiseBalance { id, name, balance }
ClassificationRule { id, pattern, type, organization_id, category_id, organization_name?, category_name? }
CsvPreviewRow { index, date, description, amount, counterparty_account, ing_transaction_id, duplicate }
ImportResult { imported, skipped, total, ai_analyzed?, transactions[] }
ExpenseReceipt { id, transaction_id, filename, content_type, gmail_message_id, created_at }
WorkExpense extends Transaction { receipts: ExpenseReceipt[] }
ExpensesPageData { transactions: WorkExpense[], reimbursed: WorkExpense[], gmail_connected, work_org_configured? }
GmailFetchResult { fetched, linked, unmatched: string[] }
ReimbursementLink { id, income_transaction_id, expense_transaction_id, amount, created_at, description?, transaction_amount?, date?, organization_name? }
IncomeCandidateTransaction { id, description, amount, date, counterparty_name, linked_total }
ExpenseCandidateTransaction { id, description, amount, date, organization_name }
```

## Frontend pagina's (signals-gebaseerd)

### transactions.ts
- Signals: transactions, organizations, categories, loading, showModal, editingTx, importResult, previewRows, selectedIndices, editLinks, expenseCandidates, showAddExpenseLink, linkingExpenseId, linkingAmount, linkSaving
- Computed: unconfirmedCount, selectableCount, duplicateCount, isAllSelected
- Filters: filterType, filterCategory, filterOrg, filterSearch, filterDateFrom, filterDateTo
- Edit modal: voor inkomst-transacties toont "Gekoppelde terugbetalingen" sectie met link-beheer; voor reimbursable toont "Gekoppeld aan inkomst" read-only

### dashboard.ts
- Signals: summary, balances, splitwiseTotal, loading, period ('month'|'last_month'|'year')

### reimbursements.ts
- Signals: outstanding, received, loading, markingId, confirmId, confirmNote, linkingExpenseId, linkingAmount, incomeCandidates, selectedIncomeId, linkSaving, receivedLinks, expandedLinkId
- Linking flow: per expense een "Koppel aan inkomst" knop → selecteer inkomst + bedrag → bevestig

### expenses.ts
- Signals: transactions, reimbursedTransactions, loading, gmailConnected, workOrgConfigured, fetchingGmail, fetchResult, uploadingFor, expandedRows, showReimbursed, selectedMonth
- Computed: totalAmount, receiptCount, missingReceiptCount
- Toont alle open werkuitgaven (reimbursed_at IS NULL), terugbetaalde toegeklapt onderaan
- selectedMonth enkel voor Excel/PDF-export en Gmail-fetch, niet voor filteren van lijst

### settings.ts
- Werkorganisatie selectie (work_organization_id), Splitwise API key koppelen, organizations/categories/rules CRUD

### splitwise.ts
- Signals: expenses, balances, loading, configured, error
