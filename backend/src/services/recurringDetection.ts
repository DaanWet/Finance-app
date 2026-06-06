// Pure detectiemotor voor terugkerende transacties. Geen DB, geen AI, geen Date.now()
// (today wordt als parameter doorgegeven zodat de logica deterministisch testbaar is).

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export type Direction = 'expense' | 'income';
export type MatchType = 'account' | 'name' | 'description';

export interface DetectionTx {
  id: number;
  date: string;                       // 'YYYY-MM-DD'
  amount: number;                     // signed: < 0 uitgave, > 0 inkomst
  type: string;
  description: string;
  counterparty_account: string | null;
  counterparty_name: string | null;
  category_id: number | null;
}

export interface DetectedSeries {
  series_key: string;                 // `${match_type}:${match_value}:${direction}`
  match_type: MatchType;
  match_value: string;
  direction: Direction;
  cadence: Cadence;
  typical_amount: number;             // mediaan van |amount|
  min_amount: number;
  max_amount: number;
  is_variable: boolean;
  category_id: number | null;         // meest voorkomende categorie
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  next_expected: string;
  active: boolean;
  member_ids: number[];
  fallback_name: string;              // meest voorkomende description
  samples: string[];                  // tot 3 voorbeeld-descriptions (voor AI-naamgeving)
}

export const MIN_OCCURRENCES = 3;
export const AMOUNT_VARIANCE_THRESHOLD = 0.25;
export const CADENCE_CONSISTENCY = 0.6;
export const INACTIVE_FACTOR = 1.5;

export const CADENCE_DAYS: Record<Cadence, number> = {
  weekly: 7, monthly: 30, quarterly: 91, yearly: 365,
};
const CADENCE_TOLERANCE: Record<Cadence, number> = {
  weekly: 2, monthly: 4, quarterly: 10, yearly: 20,
};
// Genormaliseerde maandfactor: hoeveel keer per maand komt deze cadans voor.
export const MONTHLY_FACTOR: Record<Cadence, number> = {
  weekly: 4.33, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12,
};

export function normalizeMatchValue(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime();
  return Math.round(ms / 86_400_000);
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mostCommon<T>(items: T[]): T | null {
  const counts = new Map<T, number>();
  for (const it of items) counts.set(it, (counts.get(it) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

export function detectCadence(sortedDates: string[]): Cadence | null {
  if (sortedDates.length < MIN_OCCURRENCES) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push(daysBetween(sortedDates[i - 1]!, sortedDates[i]!));
  }
  const med = median(gaps);

  let best: Cadence | null = null;
  let bestDist = Infinity;
  for (const c of Object.keys(CADENCE_DAYS) as Cadence[]) {
    const dist = Math.abs(med - CADENCE_DAYS[c]);
    if (dist <= CADENCE_TOLERANCE[c] && dist < bestDist) { best = c; bestDist = dist; }
  }
  if (!best) return null;

  const within = gaps.filter(g => Math.abs(g - CADENCE_DAYS[best!]) <= CADENCE_TOLERANCE[best!]).length;
  if (within / gaps.length < CADENCE_CONSISTENCY) return null;
  return best;
}

function matchKeyFor(tx: DetectionTx): { type: MatchType; value: string } | null {
  if (tx.counterparty_account && tx.counterparty_account.trim()) {
    return { type: 'account', value: tx.counterparty_account.trim() };
  }
  if (tx.counterparty_name && tx.counterparty_name.trim()) {
    return { type: 'name', value: normalizeMatchValue(tx.counterparty_name) };
  }
  if (tx.description && tx.description.trim()) {
    return { type: 'description', value: normalizeMatchValue(tx.description) };
  }
  return null;
}

export function buildSeriesFromTransactions(txs: DetectionTx[], today: string): DetectedSeries[] {
  const groups = new Map<string, { match_type: MatchType; match_value: string; direction: Direction; members: DetectionTx[] }>();

  for (const t of txs) {
    const key = matchKeyFor(t);
    if (!key) continue;
    const direction: Direction = t.amount > 0 ? 'income' : 'expense';
    const series_key = `${key.type}:${key.value}:${direction}`;
    let group = groups.get(series_key);
    if (!group) {
      group = { match_type: key.type, match_value: key.value, direction, members: [] };
      groups.set(series_key, group);
    }
    group.members.push(t);
  }

  const result: DetectedSeries[] = [];

  for (const [series_key, group] of groups) {
    if (group.members.length < MIN_OCCURRENCES) continue;

    const sorted = [...group.members].sort((a, b) => a.date.localeCompare(b.date));
    const dates = sorted.map(t => t.date);
    const cadence = detectCadence(dates);
    if (!cadence) continue;

    const amounts = sorted.map(t => Math.abs(t.amount));
    const typical = round2(median(amounts));
    const minAmount = round2(Math.min(...amounts));
    const maxAmount = round2(Math.max(...amounts));
    const is_variable = typical > 0 && (maxAmount - minAmount) / typical > AMOUNT_VARIANCE_THRESHOLD;

    const first_seen = dates[0]!;
    const last_seen = dates[dates.length - 1]!;
    const next_expected = addDays(last_seen, CADENCE_DAYS[cadence]);
    const active = daysBetween(last_seen, today) <= CADENCE_DAYS[cadence] * INACTIVE_FACTOR;

    const categoryIds = sorted.map(t => t.category_id).filter((c): c is number => c != null);
    const category_id = mostCommon(categoryIds);

    const descriptions = sorted.map(t => t.description).filter(Boolean);
    const fallback_name = mostCommon(descriptions) ?? group.match_value;
    const samples = [...new Set(descriptions)].slice(0, 3);

    result.push({
      series_key,
      match_type: group.match_type,
      match_value: group.match_value,
      direction: group.direction,
      cadence,
      typical_amount: typical,
      min_amount: minAmount,
      max_amount: maxAmount,
      is_variable,
      category_id,
      occurrence_count: sorted.length,
      first_seen,
      last_seen,
      next_expected,
      active,
      member_ids: sorted.map(t => t.id),
      fallback_name,
      samples,
    });
  }

  return result;
}
