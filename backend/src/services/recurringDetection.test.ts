import { describe, it, expect } from 'vitest';
import {
  normalizeMatchValue, detectCadence, buildSeriesFromTransactions,
  type DetectionTx, MIN_OCCURRENCES,
} from './recurringDetection';

describe('normalizeMatchValue', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeMatchValue('  Spotify   AB  ')).toBe('spotify ab');
  });
});

describe('detectCadence', () => {
  it('detects monthly cadence from ~30-day gaps', () => {
    expect(detectCadence(['2025-01-05', '2025-02-04', '2025-03-06', '2025-04-05'])).toBe('monthly');
  });

  it('detects weekly cadence from ~7-day gaps', () => {
    expect(detectCadence(['2025-01-01', '2025-01-08', '2025-01-15', '2025-01-22'])).toBe('weekly');
  });

  it('detects quarterly cadence from ~91-day gaps', () => {
    expect(detectCadence(['2024-01-01', '2024-04-01', '2024-07-01', '2024-09-30'])).toBe('quarterly');
  });

  it('detects yearly cadence from ~365-day gaps', () => {
    expect(detectCadence(['2023-03-01', '2024-03-02', '2025-03-01'])).toBe('yearly');
  });

  it('sorts defensively when dates are not pre-sorted', () => {
    expect(detectCadence(['2025-03-06', '2025-01-05', '2025-04-05', '2025-02-04'])).toBe('monthly');
  });

  it('returns null for fewer than 3 dates', () => {
    expect(detectCadence(['2025-01-01', '2025-02-01'])).toBeNull();
  });

  it('returns null when gaps are irregular', () => {
    // gaps = [8, 65, 40], median 40 → matcht geen enkele cadans-bucket
    expect(detectCadence(['2025-01-01', '2025-01-09', '2025-03-15', '2025-04-24'])).toBeNull();
  });
});

function tx(partial: Partial<DetectionTx> & { id: number; date: string; amount: number }): DetectionTx {
  return {
    type: 'personal',
    description: 'SPOTIFY',
    counterparty_account: 'BE111',
    counterparty_name: 'Spotify',
    category_id: 6,
    ...partial,
  };
}

describe('buildSeriesFromTransactions', () => {
  const TODAY = '2025-05-01';

  it('detects a stable monthly subscription', () => {
    const txs = [
      tx({ id: 1, date: '2025-01-05', amount: -9.99 }),
      tx({ id: 2, date: '2025-02-04', amount: -9.99 }),
      tx({ id: 3, date: '2025-03-06', amount: -9.99 }),
      tx({ id: 4, date: '2025-04-05', amount: -9.99 }),
    ];
    const series = buildSeriesFromTransactions(txs, TODAY);
    expect(series).toHaveLength(1);
    const s = series[0]!;
    expect(s.cadence).toBe('monthly');
    expect(s.direction).toBe('expense');
    expect(s.match_type).toBe('account');
    expect(s.match_value).toBe('BE111');
    expect(s.typical_amount).toBe(9.99);
    expect(s.is_variable).toBe(false);
    expect(s.occurrence_count).toBe(4);
    expect(s.active).toBe(true);
    expect(s.member_ids.sort()).toEqual([1, 2, 3, 4]);
    expect(s.series_key).toBe('account:BE111:expense');
  });

  it('flags variable amounts but keeps one series', () => {
    const txs = [
      tx({ id: 1, date: '2025-01-05', amount: -50, counterparty_account: 'BE-ELEC', counterparty_name: 'Energie' }),
      tx({ id: 2, date: '2025-02-04', amount: -80, counterparty_account: 'BE-ELEC', counterparty_name: 'Energie' }),
      tx({ id: 3, date: '2025-03-06', amount: -120, counterparty_account: 'BE-ELEC', counterparty_name: 'Energie' }),
    ];
    const series = buildSeriesFromTransactions(txs, TODAY);
    expect(series).toHaveLength(1);
    expect(series[0]!.is_variable).toBe(true);
  });

  it('ignores groups with fewer than MIN_OCCURRENCES', () => {
    const txs = [
      tx({ id: 1, date: '2025-01-05', amount: -9.99 }),
      tx({ id: 2, date: '2025-02-04', amount: -9.99 }),
    ];
    expect(MIN_OCCURRENCES).toBe(3);
    expect(buildSeriesFromTransactions(txs, TODAY)).toHaveLength(0);
  });

  it('marks a series inactive when last_seen is too old', () => {
    const txs = [
      tx({ id: 1, date: '2024-01-05', amount: -9.99 }),
      tx({ id: 2, date: '2024-02-04', amount: -9.99 }),
      tx({ id: 3, date: '2024-03-06', amount: -9.99 }),
    ];
    const series = buildSeriesFromTransactions(txs, '2025-05-01');
    expect(series).toHaveLength(1);
    expect(series[0]!.active).toBe(false);
    expect(series[0]!.next_expected).toBe('2024-04-05');
  });

  it('falls back to normalized name when account is missing', () => {
    const txs = [
      tx({ id: 1, date: '2025-01-05', amount: -15, counterparty_account: null, counterparty_name: 'My Gym' }),
      tx({ id: 2, date: '2025-02-04', amount: -15, counterparty_account: null, counterparty_name: 'My Gym' }),
      tx({ id: 3, date: '2025-03-06', amount: -15, counterparty_account: null, counterparty_name: 'My Gym' }),
    ];
    const series = buildSeriesFromTransactions(txs, TODAY);
    expect(series).toHaveLength(1);
    expect(series[0]!.match_type).toBe('name');
    expect(series[0]!.match_value).toBe('my gym');
  });

  it('falls back to normalized description when account and name are missing', () => {
    const txs = [
      tx({ id: 1, date: '2025-01-05', amount: -8, counterparty_account: null, counterparty_name: null, description: 'Apple  iCloud' }),
      tx({ id: 2, date: '2025-02-04', amount: -8, counterparty_account: null, counterparty_name: null, description: 'Apple  iCloud' }),
      tx({ id: 3, date: '2025-03-06', amount: -8, counterparty_account: null, counterparty_name: null, description: 'Apple  iCloud' }),
    ];
    const series = buildSeriesFromTransactions(txs, TODAY);
    expect(series).toHaveLength(1);
    expect(series[0]!.match_type).toBe('description');
    expect(series[0]!.match_value).toBe('apple icloud');
  });

  it('splits income and expense from the same counterparty into two series', () => {
    const txs = [
      tx({ id: 1, date: '2025-01-05', amount: -9.99 }),
      tx({ id: 2, date: '2025-02-04', amount: -9.99 }),
      tx({ id: 3, date: '2025-03-06', amount: -9.99 }),
      tx({ id: 4, date: '2025-01-25', amount: 9.99, type: 'income' }),
      tx({ id: 5, date: '2025-02-24', amount: 9.99, type: 'income' }),
      tx({ id: 6, date: '2025-03-26', amount: 9.99, type: 'income' }),
    ];
    const series = buildSeriesFromTransactions(txs, TODAY);
    expect(series).toHaveLength(2);
    expect(series.map(s => s.direction).sort()).toEqual(['expense', 'income']);
  });
});
