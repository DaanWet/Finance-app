# Feature Ideas — Finance App

## Budgettering & Doelen

- **Maandbudgetten per categorie** — Stel limieten in per categorie (bv. max €200 eten) met visuele voortgangsbalk op het dashboard. Waarschuwing bij 80%/100%.
- **Spaardoelen** — Definieer doelen (bv. "vakantie €2000") en koppel savings-transacties eraan. Tracker met voortgang.
- **Jaarlijks budget-overzicht** — Budget vs. werkelijk per categorie over het hele jaar, met trends.

## Inzichten & Analytics

- **Vergelijking tussen periodes** — "Deze maand vs. vorige maand" of "dit jaar vs. vorig jaar" naast elkaar.
- **Recurring transacties detectie** — Automatisch herkennen van abonnementen/vaste lasten (Spotify, huur, etc.) op basis van patroonherkenning. Overzicht van al je vaste kosten.
- **Gemiddelde daguitgave** — Hoeveel geef je gemiddeld per dag uit, met trend.
- **Cashflow-forecast** — Op basis van vaste lasten en inkomen voorspellen wanneer je saldo laag wordt.
- **"Unusual spending" alerts** — AI detecteert als je significant meer uitgeeft in een categorie dan normaal.

## UX & Dagelijks gebruik

- **Snelle transactie-invoer** — Simpel formulier of floating action button om snel handmatige uitgaven toe te voegen (cash, Payconiq, etc.).
- **Zoeken over alles** — Globale zoekbalk die over transacties, organisaties, notities zoekt.
- **Tags/labels** — Naast categorieën ook vrije tags (bv. "vakantie Italië", "kerstcadeaus") voor ad-hoc groepering.
- **Notificaties/reminders** — Herinnering om CSV te importeren, onbevestigde transacties te reviewen, of openstaande terugbetalingen op te volgen.
- **Dark mode**

## Import & Integratie

- **Belfius/KBC/andere banken CSV-import** — Meerdere bankformaten ondersteunen naast ING.
- **Automatische import via PSD2/bank API** — Directe bankconnectie (via Nordigen/GoCardless) i.p.v. handmatige CSV.
- **Payconiq-integratie** — Veel Belgische betalingen gaan via Payconiq.
- **QR-code bon scanner** — Foto van kasticket → OCR → automatisch transactie aanmaken of matchen.

## Terugbetalingen & Werk

- **Onkostennota-goedkeuringsflow** — Status tracking: ingediend → goedgekeurd → uitbetaald.
- **Automatische herinnering voor openstaande terugbetalingen** — Na X dagen een reminder tonen.
- **Kilometervergoeding-calculator** — Invoer van trajecten met automatische berekening op basis van officieel tarief.

## Splitwise & Gedeelde kosten

- **Directe settle-up tracking** — Bijhouden wanneer je Splitwise-schulden vereffent (Payconiq/cash) zonder dat het via Splitwise zelf gaat.
- **Gedeelde kosten zonder Splitwise** — Ingebouwde split-functionaliteit voor wie geen Splitwise gebruikt.

## Data & Export

- **Jaaroverzicht/rapport** — Automatisch gegenereerd PDF-rapport met alle statistieken van het jaar.
- **Data backup/restore** — Export volledige database als backup, importeer later terug.
- **Belastingaangifte-helper** — Overzicht van fiscaal relevante uitgaven (bv. kinderopvang, giften, woon-werkverkeer).

## Technisch

- **PWA / mobiele app** — Installeerbaar op telefoon voor onderweg.
- **Multi-user / huishouden** — Gedeelde financiën met partner, elk met eigen view maar gezamenlijk overzicht.
- **Scheduled imports** — Automatisch CSV ophalen of bank-sync op vast tijdstip.
