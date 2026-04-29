import type Database from 'better-sqlite3';

export interface MerchantProfile {
  counterparty_account: string | null;
  counterparty_name: string;
  transaction_count: number;
  confirmed_count: number;
  dominant_category_id: number | null;
  dominant_category_name: string | null;
  dominant_category_pct: number;
  type_distribution: { type: string; pct: number }[];
  avg_amount: number;
  sample_descriptions: string[];
}

interface RawMerchantRow {
  merchant_key: string;
  counterparty_account: string | null;
  counterparty_name: string;
  transaction_count: number;
  confirmed_count: number;
  avg_amount: number;
}

interface CategoryDistRow {
  merchant_key: string;
  category_id: number;
  category_name: string;
  weighted_count: number;
}

interface TypeDistRow {
  merchant_key: string;
  type: string;
  count: number;
}

interface SampleRow {
  merchant_key: string;
  description: string;
}

/**
 * Build merchant profiles from historical transaction data.
 * Groups by counterparty_account (IBAN, stable) with fallback to counterparty_name.
 * Weights confirmed transactions (category_confirmed=1) 3x higher for category distribution.
 */
export function getMerchantProfiles(db: Database.Database): MerchantProfile[] {
  // Merchant key: prefer counterparty_account, fall back to UPPER(counterparty_name)
  const merchantKeyExpr = `COALESCE(counterparty_account, UPPER(counterparty_name))`;

  // Step 1: Get base merchant stats (merchants with >= 2 transactions)
  const merchants = db.prepare(`
    SELECT
      ${merchantKeyExpr} AS merchant_key,
      counterparty_account,
      counterparty_name,
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN category_confirmed = 1 THEN 1 ELSE 0 END) AS confirmed_count,
      AVG(amount) AS avg_amount
    FROM transactions
    WHERE ${merchantKeyExpr} IS NOT NULL
    GROUP BY merchant_key
    HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) DESC
    LIMIT 100
  `).all() as RawMerchantRow[];

  if (merchants.length === 0) return [];

  const merchantKeys = merchants.map(m => m.merchant_key);

  // Step 2: Category distribution per merchant (confirmed weighted 3x)
  const catDist = db.prepare(`
    SELECT
      ${merchantKeyExpr} AS merchant_key,
      t.category_id,
      c.name AS category_name,
      SUM(CASE WHEN t.category_confirmed = 1 THEN 3 ELSE 1 END) AS weighted_count
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${merchantKeyExpr} IN (${merchantKeys.map(() => '?').join(',')})
      AND t.category_id IS NOT NULL
    GROUP BY merchant_key, t.category_id
    ORDER BY merchant_key, weighted_count DESC
  `).all(...merchantKeys) as CategoryDistRow[];

  // Step 3: Type distribution per merchant
  const typeDist = db.prepare(`
    SELECT
      ${merchantKeyExpr} AS merchant_key,
      type,
      COUNT(*) AS count
    FROM transactions
    WHERE ${merchantKeyExpr} IN (${merchantKeys.map(() => '?').join(',')})
    GROUP BY merchant_key, type
    ORDER BY merchant_key, count DESC
  `).all(...merchantKeys) as TypeDistRow[];

  // Step 4: Sample descriptions (3 most recent per merchant)
  const samples = db.prepare(`
    SELECT merchant_key, description FROM (
      SELECT
        ${merchantKeyExpr} AS merchant_key,
        description,
        ROW_NUMBER() OVER (PARTITION BY ${merchantKeyExpr} ORDER BY date DESC) AS rn
      FROM transactions
      WHERE ${merchantKeyExpr} IN (${merchantKeys.map(() => '?').join(',')})
    ) WHERE rn <= 3
  `).all(...merchantKeys) as SampleRow[];

  // Index by merchant_key
  const catByMerchant = new Map<string, CategoryDistRow[]>();
  for (const row of catDist) {
    if (!catByMerchant.has(row.merchant_key)) catByMerchant.set(row.merchant_key, []);
    catByMerchant.get(row.merchant_key)!.push(row);
  }

  const typeByMerchant = new Map<string, TypeDistRow[]>();
  for (const row of typeDist) {
    if (!typeByMerchant.has(row.merchant_key)) typeByMerchant.set(row.merchant_key, []);
    typeByMerchant.get(row.merchant_key)!.push(row);
  }

  const samplesByMerchant = new Map<string, string[]>();
  for (const row of samples) {
    if (!samplesByMerchant.has(row.merchant_key)) samplesByMerchant.set(row.merchant_key, []);
    samplesByMerchant.get(row.merchant_key)!.push(row.description);
  }

  // Build profiles
  return merchants.map(m => {
    const cats = catByMerchant.get(m.merchant_key) ?? [];
    const totalCatWeight = cats.reduce((sum, c) => sum + c.weighted_count, 0);
    const topCat = cats[0] ?? null;

    const types = typeByMerchant.get(m.merchant_key) ?? [];
    const totalTypeCount = types.reduce((sum, t) => sum + t.count, 0);

    return {
      counterparty_account: m.counterparty_account,
      counterparty_name: m.counterparty_name,
      transaction_count: m.transaction_count,
      confirmed_count: m.confirmed_count,
      dominant_category_id: topCat?.category_id ?? null,
      dominant_category_name: topCat?.category_name ?? null,
      dominant_category_pct: totalCatWeight > 0 && topCat
        ? Math.round((topCat.weighted_count / totalCatWeight) * 100)
        : 0,
      type_distribution: types.map(t => ({
        type: t.type,
        pct: Math.round((t.count / totalTypeCount) * 100),
      })),
      avg_amount: Math.round(m.avg_amount * 100) / 100,
      sample_descriptions: samplesByMerchant.get(m.merchant_key) ?? [],
    };
  });
}

/**
 * Find matching merchant profiles for a set of transactions being imported.
 * Returns profiles that match any of the given counterparty accounts or names.
 */
export function findMatchingProfiles(
  profiles: MerchantProfile[],
  transactions: { counterparty_account: string | null; counterparty_name: string | null }[]
): Map<number, MerchantProfile> {
  const byAccount = new Map<string, MerchantProfile>();
  const byName = new Map<string, MerchantProfile>();

  for (const p of profiles) {
    if (p.counterparty_account) byAccount.set(p.counterparty_account, p);
    byName.set(p.counterparty_name.toUpperCase(), p);
  }

  const matches = new Map<number, MerchantProfile>();
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const match = (tx.counterparty_account && byAccount.get(tx.counterparty_account))
      || (tx.counterparty_name && byName.get(tx.counterparty_name.toUpperCase()))
      || null;
    if (match) matches.set(i, match);
  }

  return matches;
}

/**
 * Format merchant profiles as context string for the AI prompt.
 * Only includes profiles relevant to the current batch.
 */
export function formatProfilesForPrompt(profileMatches: Map<number, MerchantProfile>): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const profile of profileMatches.values()) {
    const key = profile.counterparty_account ?? profile.counterparty_name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const catInfo = profile.dominant_category_id
      ? `cat="${profile.dominant_category_name}" (${profile.dominant_category_pct}%)`
      : 'geen dominante categorie';

    const typeInfo = profile.type_distribution
      .map(t => `${t.pct}% ${t.type}`)
      .join(', ');

    lines.push(
      `- "${profile.counterparty_name}": ${profile.transaction_count}x gezien, ${catInfo}, type: ${typeInfo}, gem. bedrag €${profile.avg_amount.toFixed(2)}`
    );
  }

  return lines.length > 0 ? lines.join('\n') : '(geen historiek beschikbaar)';
}
