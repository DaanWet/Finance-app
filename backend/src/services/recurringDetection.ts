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

// buildSeriesFromTransactions volgt in Task 3 — hier nog niet geëxporteerd.
// Interne helpers hierboven (round2, median, daysBetween, addDays, mostCommon) worden daar gebruikt.
export const __internals = { round2, median, daysBetween, addDays, mostCommon };
