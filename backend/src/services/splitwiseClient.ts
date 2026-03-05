import { getDb } from '../db';
import { getSetting } from '../helpers/settings';
import { SETTING_KEYS } from '../helpers/constants';
import type { AnalysisContext } from './aiAnalysis';

const SPLITWISE_API = 'https://secure.splitwise.com/api/v3.0';

export async function splitwiseFetch(path: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${SPLITWISE_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Splitwise API error: ${res.status}`);
  return res.json();
}

export async function fetchSplitwiseExpenses(dateFrom: string): Promise<AnalysisContext['splitwiseExpenses']> {
  try {
    const db = getDb();
    const apiKey = getSetting(SETTING_KEYS.SPLITWISE_API_KEY, db);
    const userId = getSetting(SETTING_KEYS.SPLITWISE_USER_ID, db);
    if (!apiKey || !userId) return [];

    const oneMonthBefore = new Date(dateFrom);
    oneMonthBefore.setMonth(oneMonthBefore.getMonth() - 1);
    const datedAfter = oneMonthBefore.toISOString().split('T')[0];

    const params = new URLSearchParams({ limit: '200', dated_after: datedAfter });
    const data = await splitwiseFetch(`/get_expenses?${params}`, apiKey) as { expenses: Array<{
      id: number; description: string; cost: string; date: string;
      deleted_at: string | null;
      users: Array<{ user_id: number; paid_share: string; owed_share: string }>;
    }> };

    const userIdNum = Number(userId);
    return data.expenses
      .filter(e => !e.deleted_at)
      .map(e => {
        const myShare = e.users.find(u => u.user_id === userIdNum);
        return {
          id: e.id,
          description: e.description,
          my_paid_share: myShare ? parseFloat(myShare.paid_share) : 0,
          my_owed_share: myShare ? parseFloat(myShare.owed_share) : 0,
          date: e.date?.split('T')[0] ?? e.date,
        };
      })
      .filter(e => e.my_paid_share > 0);
  } catch {
    return [];
  }
}
