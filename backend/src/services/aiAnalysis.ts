import type { MerchantProfile } from './merchantProfiles';
import type { FewShotExample } from './analysisHelpers';

// ─── Shared types ────────────────────────────────────────────────────────────

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

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
}

// ─── Classification types ────────────────────────────────────────────────────

export interface ClassificationResult {
  index: number;
  readable_name: string;
  category_id: number | null;
  organization_id: number | null;
  type: 'personal' | 'reimbursable' | 'income' | 'savings';
  classification_confidence: number;
  notes: string | null;
}

export interface ClassificationContext {
  categories: { id: number; name: string }[];
  organizations: { id: number; name: string }[];
  merchantProfiles: Map<number, MerchantProfile>;
  fewShotExamples: FewShotExample[];
}

// ─── Matching types ──────────────────────────────────────────────────────────

export interface MatchCandidate {
  index: number;
  id: number;
  date: string;
  amount: number;
  description: string;
  counterparty_name: string | null;
}

export interface UnreimbursedExpense {
  id: number;
  date: string;
  amount: number;
  description: string;
  counterparty_name: string | null;
  organization_name: string | null;
}

export interface ReimbursementMatch {
  income_index: number;
  expense_id: number;
  match_type: 'within_batch' | 'cross_batch';
  confidence: number;
}

// ─── Legacy types (for fallback path) ────────────────────────────────────────

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

export interface AnalysisResult {
  results: TransactionAnalysisResult[] | null;
  usage: TokenUsage | null;
}

// ─── Shared helper: call query() and stream tokens ───────────────────────────

async function callQuery(
  prompt: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ text: string; usage: TokenUsage }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  let resultText = '';
  let streamedChars = 0;
  let lastUsageUpdate = 0;
  const USAGE_THROTTLE_MS = 500;
  const estimatedInputTokens = Math.round(prompt.length / 4);
  const liveUsage: TokenUsage = {
    input_tokens: estimatedInputTokens, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0,
  };
  onUsage?.({ ...liveUsage });

  const emitUsage = (force = false) => {
    const now = Date.now();
    if (force || now - lastUsageUpdate >= USAGE_THROTTLE_MS) {
      lastUsageUpdate = now;
      onUsage?.({ ...liveUsage });
    }
  };

  for await (const message of query({
    prompt,
    options: { allowedTools: [], includePartialMessages: true },
  })) {
    if ('type' in message && (message as Record<string, unknown>).type === 'stream_event') {
      const event = (message as unknown as { event: Record<string, unknown> }).event;
      if (event.type === 'message_start') {
        const msgObj = event.message as Record<string, unknown> | undefined;
        const u = msgObj?.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        if (u) {
          liveUsage.input_tokens = u.input_tokens ?? liveUsage.input_tokens;
          liveUsage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0;
          liveUsage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
          emitUsage(true);
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        const text = (delta?.text as string) ?? (delta?.thinking as string);
        if (text) {
          streamedChars += text.length;
          liveUsage.output_tokens = Math.round(streamedChars / 4);
          emitUsage();
        }
      } else if (event.type === 'message_delta') {
        const u = event.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
        if (u) {
          if (u.output_tokens) liveUsage.output_tokens = u.output_tokens;
          if (u.input_tokens) liveUsage.input_tokens = u.input_tokens;
          if (u.cache_read_input_tokens) liveUsage.cache_read_input_tokens = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens) liveUsage.cache_creation_input_tokens = u.cache_creation_input_tokens;
          emitUsage(true);
        }
      }
    } else if ('result' in message) {
      const msg = message as unknown as { result?: string; usage?: Record<string, number>; total_cost_usd?: number };
      resultText = msg.result ?? '';
      if (msg.usage) {
        liveUsage.input_tokens = msg.usage.input_tokens ?? liveUsage.input_tokens;
        liveUsage.output_tokens = msg.usage.output_tokens ?? liveUsage.output_tokens;
        liveUsage.cache_read_input_tokens = msg.usage.cache_read_input_tokens ?? liveUsage.cache_read_input_tokens;
        liveUsage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens ?? liveUsage.cache_creation_input_tokens;
      }
      liveUsage.total_cost_usd = msg.total_cost_usd ?? 0;
      emitUsage(true);
    }
  }

  return { text: resultText, usage: { ...liveUsage } };
}

/** Extract JSON from AI response text (handles markdown code blocks and raw JSON). */
function parseJsonResponse<T>(text: string): T | null {
  if (!text) return null;
  // Try direct parse first
  try { return JSON.parse(text.trim()) as T; } catch {}
  // Try extracting from markdown code block
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()) as T; } catch {}
  }
  // Try extracting JSON object or array
  const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]) as T; } catch {}
  }
  return null;
}

// ─── AI Call 1: Classification ───────────────────────────────────────────────

import { formatProfilesForPrompt } from './merchantProfiles';
import { formatFewShotForPrompt } from './analysisHelpers';

export async function classifyTransactions(
  inputs: TransactionAnalysisInput[],
  context: ClassificationContext,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ results: ClassificationResult[] | null; usage: TokenUsage | null }> {
  if (inputs.length === 0) return { results: null, usage: null };

  const profilesText = formatProfilesForPrompt(context.merchantProfiles);
  const fewShotText = formatFewShotForPrompt(context.fewShotExamples);

  const prompt = `Je bent een financieel analysator voor Belgische banktransacties (ING Bank).
Geef ALLEEN geldige JSON terug. Geen uitleg, geen extra tekst.

## Categorieën
${context.categories.map(c => `- id=${c.id}: ${c.name}`).join('\n')}

## Organisaties
${context.organizations.length > 0
    ? context.organizations.map(o => `- id=${o.id}: ${o.name}`).join('\n')
    : '(geen)'}

## Voorbeelden van bevestigde classificaties
${fewShotText}

## Merchant historiek voor deze batch
${profilesText}

## Regels per transactie
1. readable_name: Extraheer de handelsnaam of tegenpartij. Verwijder referentienummers en bankcodes. Kort en herkenbaar.
2. category_id: Kies de best passende categorie-id of null. Gebruik de merchant historiek als leidraad.
3. organization_id: Koppel aan organisatie als de tegenpartij of mededeling duidelijk verwijst naar een organisatie. Anders null.
4. type:
   - "income" als bedrag > 0 (tenzij het duidelijk een terugstorting/correctie is)
   - "reimbursable" als het duidelijk een werkgerelateerde kost, organisatie-aankoop, treinticket, of tolticket is
   - "savings" als het een overboeking van/naar een spaarrekening betreft
   - "personal" voor gewone persoonlijke uitgaven
   Let op: dezelfde winkel kan zowel personal als reimbursable zijn — gebruik de mededeling/beschrijving om te bepalen, niet alleen de winkel.
5. classification_confidence: Score 0-100.
   - 90+: merchant historiek bevestigt classificatie, of classificatie is overduidelijk
   - 70-89: goede indicatie maar niet 100% zeker
   - 50-69: gok op basis van beperkte informatie
   - <50: echt onzeker
6. notes: Korte notitie als er iets bijzonders is, anders null.

## Transacties om te classificeren
${JSON.stringify(inputs, null, 2)}

## Output formaat
Geef ALLEEN een JSON object terug met deze structuur:
{"results": [{"index": 0, "readable_name": "...", "category_id": 1, "organization_id": null, "type": "personal", "classification_confidence": 85, "notes": null}, ...]}`;

  try {
    const { text, usage } = await callQuery(prompt, onUsage);
    const parsed = parseJsonResponse<{ results: ClassificationResult[] }>(text);
    if (!parsed || !Array.isArray(parsed.results)) return { results: null, usage };
    return { results: parsed.results, usage };
  } catch (err) {
    console.error('[AI Classification] Fout:', err instanceof Error ? err.message : err);
    return { results: null, usage: null };
  }
}

// ─── AI Call 2: Reimbursement Matching ───────────────────────────────────────

export async function matchReimbursements(
  incomeTransactions: MatchCandidate[],
  batchExpenses: MatchCandidate[],
  dbExpenses: UnreimbursedExpense[],
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ matches: ReimbursementMatch[] | null; usage: TokenUsage | null }> {
  if (incomeTransactions.length === 0) return { matches: null, usage: null };
  if (batchExpenses.length === 0 && dbExpenses.length === 0) return { matches: null, usage: null };

  const prompt = `Je bent een financieel analysator. Bepaal welke inkomende transacties terugbetalingen zijn van uitgaven.
Geef ALLEEN geldige JSON terug. Geen uitleg, geen extra tekst.

## Inkomende transacties (uit deze import)
${JSON.stringify(incomeTransactions, null, 2)}

${batchExpenses.length > 0 ? `## Uitgaven uit dezelfde batch (type=reimbursable)
${JSON.stringify(batchExpenses, null, 2)}
` : ''}
## Openstaande uitgaven uit database
${dbExpenses.length > 0 ? JSON.stringify(dbExpenses, null, 2) : '(geen openstaande uitgaven)'}

## Regels
- Within-batch: een inkomst kan een terugbetaling zijn van een uitgave in dezelfde batch (bv. Tikkie-betaling voor een eerdere aankoop)
- Cross-batch: een inkomst kan een terugbetaling zijn van een bestaande uitgave uit de database
- Match op:
  - Gelijkaardig bedrag (verschil < 10%)
  - Zelfde of gelijkaardig counterparty, of verwijzing in de beschrijving
  - Tijdsverband (terugbetalingen komen meestal binnen 60 dagen)
- Wees conservatief: alleen matchen als je redelijk zeker bent
- Confidence scoring:
  - 90+: zelfde counterparty + zelfde bedrag
  - 70-89: beschrijving verwijst duidelijk naar de uitgave
  - 50-69: bedrag klopt maar counterparty verschilt (bv. Tikkie, overschrijving via derde)

## Output formaat
Geef ALLEEN een JSON object terug:
{"matches": [{"income_index": 0, "expense_id": 42, "match_type": "cross_batch", "confidence": 90}, ...]}

expense_id is:
- Voor within-batch matches: de "id" van de expense uit "Uitgaven uit dezelfde batch"
- Voor cross-batch matches: de "id" van de expense uit "Openstaande uitgaven uit database"

Als er geen matches zijn, geef: {"matches": []}`;

  try {
    const { text, usage } = await callQuery(prompt, onUsage);
    const parsed = parseJsonResponse<{ matches: ReimbursementMatch[] }>(text);
    if (!parsed || !Array.isArray(parsed.matches)) return { matches: [], usage };
    return { matches: parsed.matches, usage };
  } catch (err) {
    console.error('[AI Matching] Fout:', err instanceof Error ? err.message : err);
    return { matches: null, usage: null };
  }
}

// ─── Legacy: analyzeTransactions (fallback for direct import without preview) ─

export async function analyzeTransactions(
  inputs: TransactionAnalysisInput[],
  context: AnalysisContext,
  onUsage?: (usage: TokenUsage) => void,
): Promise<AnalysisResult> {
  if (inputs.length === 0) return { results: null, usage: null };

  const prompt = `Je bent een financieel analysator voor Belgische banktransacties (ING Bank).
Geef ALLEEN geldige JSON terug. Geen uitleg, geen extra tekst.

Beschikbare categorieën:
${context.categories.map(c => `  - id=${c.id}: ${c.name}`).join('\n')}

Beschikbare organisaties:
${context.organizations.length > 0
    ? context.organizations.map(o => `  - id=${o.id}: ${o.name}`).join('\n')
    : '  (geen)'}

Splitwise uitgaven (jouw betaald aandeel):
${context.splitwiseExpenses.length > 0
    ? context.splitwiseExpenses
        .map(e => `  - id=${e.id}: "${e.description}", bedrag=€${e.my_paid_share.toFixed(2)}, datum=${e.date}`)
        .join('\n')
    : '  (geen of niet geconfigureerd)'}

Bestaande onterugbetaalde uitgaven (nog niet terugbetaald):
${context.unreimbursedExpenses && context.unreimbursedExpenses.length > 0
    ? JSON.stringify(context.unreimbursedExpenses)
    : '  (geen)'}

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
9. matches_existing_id: Als een inkomende transactie (bedrag > 0) een terugbetaling lijkt van een bestaande onterugbetaalde uitgave, geef het id van die uitgave. Anders null.
10. matches_existing_confidence: Vertrouwensscore 0-100 voor de match. null als matches_existing_id null is.

Transacties om te analyseren:
${JSON.stringify(inputs)}

Output formaat — geef ALLEEN een JSON object terug:
{"results": [{"index": 0, "readable_name": "...", "category_id": 1, "organization_id": null, "type": "personal", "is_advance": false, "advance_repaid_by_index": null, "splitwise_expense_id": null, "notes": null, "matches_existing_id": null, "matches_existing_confidence": null}, ...]}`;

  try {
    const { text, usage } = await callQuery(prompt, onUsage);
    const parsed = parseJsonResponse<{ results: TransactionAnalysisResult[] }>(text);
    if (!parsed || !Array.isArray(parsed.results)) return { results: null, usage };
    return { results: parsed.results, usage };
  } catch (err) {
    console.error('[AI Analysis] Fout bij analyseren:', err instanceof Error ? err.message : err);
    return { results: null, usage: null };
  }
}
