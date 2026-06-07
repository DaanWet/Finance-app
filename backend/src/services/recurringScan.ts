import Database from 'better-sqlite3';
import { buildSeriesFromTransactions, DetectedSeries } from './recurringDetection';
import { getDetectionTransactions, getExistingSeriesKeys, upsertSeries, deleteStaleSuggested } from '../queries/recurring';
import { callQuery, parseJsonResponse } from './aiAnalysis';

export type SeriesNamer = (series: DetectedSeries[]) => Promise<Map<string, string>>;

export interface ScanResult {
  created: number;
  updated: number;
  total: number;
}

/** AI-naamgeving voor nieuwe reeksen. Faalt veilig: lege map → fallback-naam wordt gebruikt. */
const aiNamer: SeriesNamer = async (series) => {
  const inputs = series.map((s, i) => ({
    index: i,
    counterparty: s.match_value,
    samples: s.samples,
    amount: s.typical_amount,
    cadence: s.cadence,
    direction: s.direction,
  }));

  const prompt = `Je krijgt terugkerende transactie-reeksen van een Belgische bankrekening.
Geef per reeks een korte, herkenbare naam (handelsnaam/dienst). Verwijder referentienummers en bankcodes.
Geef ALLEEN geldige JSON terug, geen uitleg.

## Reeksen
${JSON.stringify(inputs, null, 2)}

## Output formaat
{"names": [{"index": 0, "name": "Spotify"}, ...]}`;

  try {
    const { text } = await callQuery(prompt);
    const parsed = parseJsonResponse<{ names: { index: number; name: string }[] }>(text);
    const map = new Map<string, string>();
    if (parsed?.names) {
      for (const n of parsed.names) {
        const s = series[n.index];
        if (s && n.name && n.name.trim()) map.set(s.series_key, n.name.trim());
      }
    }
    return map;
  } catch (err) {
    console.error('[recurring AI-namer] Fout:', err instanceof Error ? err.message : err);
    return new Map();
  }
};

/**
 * Draai de detectie over alle transacties, geef nieuwe reeksen een AI-naam en
 * upsert het resultaat. Behoudt status/custom_name; verwijdert verdwenen voorstellen.
 */
export async function scanRecurringSeries(
  db: Database.Database,
  opts?: { namer?: SeriesNamer; today?: string },
): Promise<ScanResult> {
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);
  const txs = getDetectionTransactions(db);
  const detected = buildSeriesFromTransactions(txs, today);

  const existingKeys = getExistingSeriesKeys(db);
  const newSeries = detected.filter(s => !existingKeys.has(s.series_key));

  let names = new Map<string, string>();
  if (newSeries.length > 0) {
    const namer = opts?.namer ?? aiNamer;
    names = await namer(newSeries);
  }

  let created = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const s of detected) {
      const name = names.get(s.series_key) ?? s.fallback_name;
      if (upsertSeries(db, s, name) === 'created') created++;
      else updated++;
    }
    deleteStaleSuggested(db, detected.map(s => s.series_key));
  });
  run();

  return { created, updated, total: detected.length };
}
