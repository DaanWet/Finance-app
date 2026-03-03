export interface TransactionAnalysisInput {
  index: number;
  date: string;
  amount: number;
  counterparty_iban: string;
  counterparty_name: string;
  omschrijving: string;
  detail: string;
  bericht: string;
}

export interface TransactionAnalysisResult {
  index: number;
  readable_name: string;
  category_id: number | null;
  organization_id: number | null;
  type: 'personal' | 'reimbursable' | 'income' | 'savings';
  is_advance: boolean;
  advance_repaid_by_index: number | null;
  splitwise_expense_id: string | null;
  notes: string | null;
}

export interface AnalysisContext {
  categories: { id: number; name: string }[];
  organizations: { id: number; name: string }[];
  splitwiseExpenses: { id: number; description: string; my_paid_share: number; my_owed_share: number; date: string }[];
}

export async function analyzeTransactions(
  inputs: TransactionAnalysisInput[],
  context: AnalysisContext,
): Promise<TransactionAnalysisResult[] | null> {
  if (inputs.length === 0) return null;

  const prompt = `Je bent een financieel analysator voor Belgische banktransacties (ING Bank).
Geef ALLEEN een geldig JSON object terug met een "results" array. Geen uitleg, geen extra tekst.

Beschikbare categorieën:
${context.categories.map(c => `  - id=${c.id}: ${c.name}`).join('\n')}

Beschikbare organisaties:
${context.organizations.length > 0
    ? context.organizations.map(o => `  - id=${o.id}: ${o.name}`).join('\n')
    : '  (geen)'}

Splitwise uitgaven (jouw betaald aandeel):
${context.splitwiseExpenses.length > 0
    ? context.splitwiseExpenses.map(e => `  - id=${e.id}: "${e.description}", bedrag=€${e.my_paid_share.toFixed(2)}, datum=${e.date}`).join('\n')
    : '  (geen of niet geconfigureerd)'}

REGELS per transactie:
1. readable_name: Extraheer de handelsnaam of tegenpartij. Verwijder referentienummers en bankcodes. Kort en herkenbaar in het Nederlands.
2. category_id: Kies de best passende categorie-id of null.
3. organization_id: Koppel aan organisatie als de tegenpartij overeenkomt (Chiro, Jeugdhuis…), anders null.
4. type:
   - "income" als bedrag > 0
   - "reimbursable" als bedrag < 0 en je dit verwacht terug te krijgen (werkkosten, groepsaankopen, aanbetalingen)
   - "savings" als het een overboeking van/naar een spaarrekening betreft (bv. ING Spaarrekening, eigen spaarrekening), ongeacht het teken van het bedrag
   - "personal" voor gewone persoonlijke uitgaven
5. is_advance: true als het een voorschot/aanbetaling is (bedrag < 0, verwacht terugbetaling).
6. advance_repaid_by_index: Als er een positieve transactie in de batch is die een terugbetaling lijkt van een negatieve (zelfde tegenpartij, gelijk bedrag), geef dan de index van de terugbetaling. Anders null.
7. splitwise_expense_id: Koppel als my_paid_share binnen 5% overeenkomt met abs(bedrag) EN datum binnen 7 dagen. Geef de id als string. Anders null.
8. notes: Korte notitie als er iets bijzonders is, anders null.

Verwacht formaat:
{
  "results": [
    {
      "index": 0,
      "readable_name": "...",
      "category_id": 1,
      "organization_id": null,
      "type": "personal",
      "is_advance": false,
      "advance_repaid_by_index": null,
      "splitwise_expense_id": null,
      "notes": null
    }
  ]
}

Transacties om te analyseren:
${JSON.stringify(inputs, null, 2)}`;

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let resultText = '';

    for await (const message of query({
      prompt,
      options: {
        allowedTools: [],
      },
    })) {
      if ('result' in message) {
        resultText = (message as { result?: string }).result ?? '';
      }
    }

    if (!resultText) return null;

    // Extraheer JSON uit het antwoord (voor het geval er extra tekst is)
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { results: TransactionAnalysisResult[] };
    if (!Array.isArray(parsed.results)) return null;

    return parsed.results;
  } catch (err) {
    console.error('[AI Analysis] Fout bij analyseren:', err instanceof Error ? err.message : err);
    return null;
  }
}
