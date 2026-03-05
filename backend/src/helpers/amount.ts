/** Check if two amounts are within a relative tolerance of each other. */
export function amountWithinTolerance(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= Math.abs(b) * tolerance;
}

/** Check if two amounts are effectively equal (within a small epsilon). */
export function amountExactMatch(a: number, b: number, epsilon = 0.005): boolean {
  return Math.abs(a - b) < epsilon;
}
