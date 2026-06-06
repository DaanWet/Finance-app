import { describe, it, expect } from 'vitest';
import { normalizeMatchValue, detectCadence } from './recurringDetection';

describe('normalizeMatchValue', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeMatchValue('  Spotify   AB  ')).toBe('spotify ab');
  });
});

describe('detectCadence', () => {
  it('detects monthly cadence from ~30-day gaps', () => {
    expect(detectCadence(['2025-01-05', '2025-02-04', '2025-03-06', '2025-04-05'])).toBe('monthly');
  });

  it('detects yearly cadence from ~365-day gaps', () => {
    expect(detectCadence(['2023-03-01', '2024-03-02', '2025-03-01'])).toBe('yearly');
  });

  it('returns null for fewer than 3 dates', () => {
    expect(detectCadence(['2025-01-01', '2025-02-01'])).toBeNull();
  });

  it('returns null when gaps are irregular', () => {
    // gaps = [8, 65, 40], median 40 → matcht geen enkele cadans-bucket
    expect(detectCadence(['2025-01-01', '2025-01-09', '2025-03-15', '2025-04-24'])).toBeNull();
  });
});
