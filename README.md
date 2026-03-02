# Finance App

Persoonlijke finance tracker met ondersteuning voor:
- Persoonlijke uitgaven
- Terugbetaalbare uitgaven (Chiro, Jeugdhuis, ...)
- Splitwise koppeling
- ING België CSV import

## Starten

### Backend (vereist)
```bash
cd backend
npm install
npm run dev
# Draait op http://localhost:3000
```

### Frontend
```bash
cd frontend
npm install
ng serve
# Open http://localhost:4200
```

## Eerste gebruik

1. Open http://localhost:4200
2. Ga naar **Instellingen**:
   - Voer je Splitwise API key in (haal op via splitwise.com/apps)
   - Voeg extra organisaties toe indien nodig
   - Configureer auto-classificatieregels voor CSV import
3. Importeer je ING CSV via **Transacties → ING CSV Importeren**
   - Exporteer CSV uit ING Banking: Rekening → Afschriften → Exporteren als CSV
4. Herclassificeer geïmporteerde transacties indien nodig (klik op ✏️)

## ING CSV export

1. Ga naar [myking.ing.be](https://myking.ing.be)
2. Selecteer je rekening
3. Klik op "Afschriften" of "Historiek"
4. Kies periode (max 12 maanden)
5. Exporteer als CSV (kommagescheiden)

## Transaction types

| Type | Betekenis | Telt mee in dashboard? |
|------|-----------|----------------------|
| Persoonlijk | Jouw eigen uitgave | ✅ Ja |
| Terugbetaalbaar | Betaald voor org, wordt terugbetaald | ❌ Nee |
| Inkomst | Geld ontvangen | ✅ Ja (apart) |

Splitwise uitgaven (jouw aandeel) tellen WEL mee als persoonlijke uitgave.

## Splitwise & ING matching

Als je een Splitwise expense hebt betaald via ING, zal die transactie in beide systemen zitten:
- In de ING CSV: het volledige bedrag
- In Splitwise: jouw aandeel

De app detecteert dit automatisch en suggereert een koppeling. Je kan ook handmatig een ING-transactie aan een Splitwise expense linken via het ✏️-icoon.
