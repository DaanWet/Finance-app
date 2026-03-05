/** Minimal transaction shape used for advance/repayment matching. */
export interface MatchableTx {
  id: number;
  date: string;
  amount: number;
  counterparty_account: string | null;
}
