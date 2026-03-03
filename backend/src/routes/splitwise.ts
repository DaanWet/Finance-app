import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

const SPLITWISE_API = 'https://secure.splitwise.com/api/v3.0';

function getApiKey(): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'splitwise_api_key'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

function getCurrentUserId(): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'splitwise_user_id'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

async function splitwiseFetch(path: string, apiKey: string) {
  const res = await fetch(`${SPLITWISE_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Splitwise API error: ${res.status}`);
  return res.json();
}

// GET /api/splitwise/connect - test de API key en sla user ID op
router.get('/connect', async (_req: Request, res: Response) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Splitwise API key not configured' });

  try {
    const data = await splitwiseFetch('/get_current_user', apiKey) as { user: { id: number; first_name: string; last_name: string } };
    const user = data.user;
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('splitwise_user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(user.id));
    res.json({ id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' ') });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

// GET /api/splitwise/expenses?limit=100&offset=0&dated_after=YYYY-MM-DD
router.get('/expenses', async (req: Request, res: Response) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Splitwise API key not configured' });

  const userId = getCurrentUserId();
  if (!userId) return res.status(400).json({ error: 'Splitwise user not connected. Call /connect first.' });

  const limit = req.query['limit'] ?? 100;
  const offset = req.query['offset'] ?? 0;
  const datedAfter = req.query['dated_after'] ?? '';

  try {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      ...(datedAfter ? { dated_after: String(datedAfter) } : {}),
    });

    const [data, groupsData] = await Promise.all([
      splitwiseFetch(`/get_expenses?${params}`, apiKey) as Promise<{ expenses: unknown[] }>,
      splitwiseFetch('/get_groups', apiKey) as Promise<{ groups: Array<{ id: number; name: string }> }>,
    ]);

    const groupMap = new Map((groupsData.groups ?? []).map(g => [g.id, g.name]));

    // Verwerk de expenses: bereken jouw aandeel per expense
    const userIdNum = Number(userId);
    const processed = (data.expenses as Array<{
      id: number;
      description: string;
      cost: string;
      date: string;
      deleted_at: string | null;
      users: Array<{ user_id: number; owed_share: string; paid_share: string; user?: { first_name: string; last_name: string } }>;
      group_id: number | null;
    }>)
      .filter(e => !e.deleted_at)
      .map(e => {
        const myShare = e.users.find(u => u.user_id === userIdNum);
        return {
          id: e.id,
          description: e.description,
          total_cost: parseFloat(e.cost),
          my_owed_share: myShare ? parseFloat(myShare.owed_share) : 0,
          my_paid_share: myShare ? parseFloat(myShare.paid_share) : 0,
          date: e.date,
          group_id: e.group_id,
          group_name: e.group_id ? (groupMap.get(e.group_id) ?? null) : null,
          participants: e.users.map(u => ({
            user_id: u.user_id,
            first_name: u.user?.first_name ?? null,
            last_name: u.user?.last_name ?? null,
            owed_share: parseFloat(u.owed_share),
            paid_share: parseFloat(u.paid_share),
          })),
        };
      })
      .filter(e => e.my_owed_share > 0);

    res.json(processed);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

// GET /api/splitwise/balances - saldo per persoon (wat anderen mij verschuldigd zijn)
router.get('/balances', async (_req: Request, res: Response) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'Splitwise API key not configured' });

  try {
    const data = await splitwiseFetch('/get_friends', apiKey) as {
      friends: Array<{
        id: number;
        first_name: string;
        last_name: string;
        balance: Array<{ currency_code: string; amount: string }>;
      }>
    };

    const balances = data.friends
      .map(f => ({
        id: f.id,
        name: [f.first_name, f.last_name].filter(Boolean).join(' '),
        balance: f.balance.find(b => b.currency_code === 'EUR')?.amount ?? '0',
      }))
      .filter(f => parseFloat(f.balance) !== 0);

    res.json(balances);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

export default router;
