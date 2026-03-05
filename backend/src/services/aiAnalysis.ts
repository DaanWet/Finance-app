// TOON encode/decode loaded via dynamic import (ESM-only package)
let toonEncode: (data: unknown) => string;
let toonDecode: (toon: string) => unknown;
const toonReady = import("@toon-format/toon").then((m) => {
  toonEncode = m.encode;
  toonDecode = m.decode;
});

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
  type: "personal" | "reimbursable" | "income" | "savings";
  is_advance: boolean;
  advance_repaid_by_index: number | null;
  splitwise_expense_id: string | null;
  notes: string | null;
  matches_existing_id: number | null;
  matches_existing_confidence: number | null;
}

export interface AnalysisContext {
  categories: { id: number; name: string }[];
  organizations: { id: number; name: string }[];
  splitwiseExpenses: {
    id: number;
    description: string;
    my_paid_share: number;
    my_owed_share: number;
    date: string;
  }[];
  unreimbursedExpenses?: {
    id: number;
    date: string;
    amount: number;
    description: string;
    counterparty_name: string | null;
    organization_name: string | null;
  }[];
}

export async function analyzeTransactions(
  inputs: TransactionAnalysisInput[],
  context: AnalysisContext,
): Promise<TransactionAnalysisResult[] | null> {
  if (inputs.length === 0) return null;
  await toonReady;

  const prompt = `Je bent een financieel analysator voor Belgische banktransacties (ING Bank).
Geef ALLEEN geldige TOON (Token-Oriented Object Notation) terug. Geen uitleg, geen extra tekst.

Beschikbare categorieën:
${context.categories.map((c) => `  - id=${c.id}: ${c.name}`).join("\n")}

Beschikbare organisaties:
${
  context.organizations.length > 0
    ? context.organizations.map((o) => `  - id=${o.id}: ${o.name}`).join("\n")
    : "  (geen)"
}

Splitwise uitgaven (jouw betaald aandeel):
${
  context.splitwiseExpenses.length > 0
    ? context.splitwiseExpenses
        .map(
          (e) =>
            `  - id=${e.id}: "${e.description}", bedrag=€${e.my_paid_share.toFixed(2)}, datum=${e.date}`,
        )
        .join("\n")
    : "  (geen of niet geconfigureerd)"
}

Bestaande onterugbetaalde uitgaven (nog niet terugbetaald):
${
  context.unreimbursedExpenses && context.unreimbursedExpenses.length > 0
    ? toonEncode(context.unreimbursedExpenses)
    : "  (geen)"
}

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
7. splitwise_expense_id: Koppel als my_paid_share binnen 0.5% overeenkomt met abs(bedrag) EN datum binnen 30 dagen. Geef de id als string. Anders null.
8. notes: Korte notitie als er iets bijzonders is, anders null.
9. matches_existing_id: Als een inkomende transactie (bedrag > 0) een terugbetaling lijkt van een bestaande onterugbetaalde uitgave, geef het id van die uitgave. Kijk naar:
   - Zelfde of gelijkaardig bedrag (abs verschil < 10%)
   - Zelfde tegenpartij of vermelding van de uitgave in de beschrijving/bericht
   - Tijdsverband (terugbetalingen komen meestal binnen 60 dagen)
   Wees conservatief: alleen matchen als je redelijk zeker bent. Anders null.
10. matches_existing_confidence: Vertrouwensscore 0-100 voor de match.
    90+: zelfde tegenpartij + zelfde bedrag.
    70-89: beschrijving verwijst duidelijk naar de uitgave.
    50-69: bedrag klopt maar tegenpartij verschilt (bv. Tikkie).
    null als matches_existing_id null is.

Verwacht formaat (TOON — Token-Oriented Object Notation):
results[N]{index,readable_name,category_id,organization_id,type,is_advance,advance_repaid_by_index,splitwise_expense_id,notes,matches_existing_id,matches_existing_confidence}:
  0,Delhaize,1,null,personal,false,null,null,null,null,null
  1,Terugbetaling Jan,null,null,income,false,null,null,null,42,95

Geef ALLEEN geldige TOON-output terug. Geen uitleg, geen extra tekst.

Transacties om te analyseren (TOON):
${toonEncode(inputs)}`;

  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let resultText = "";

    for await (const message of query({
      prompt,
      options: {
        allowedTools: [],
      },
    })) {
      if ("result" in message) {
        resultText = (message as { result?: string }).result ?? "";
      }
    }

    if (!resultText) return null;

    // Try TOON decode first, fall back to JSON
    let parsed: { results: TransactionAnalysisResult[] };
    try {
      parsed = toonDecode(resultText.trim()) as { results: TransactionAnalysisResult[] };
    } catch {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      parsed = JSON.parse(jsonMatch[0]) as { results: TransactionAnalysisResult[] };
    }
    if (!Array.isArray(parsed.results)) return null;

    return parsed.results;
  } catch (err) {
    console.error(
      "[AI Analysis] Fout bij analyseren:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
