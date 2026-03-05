import type { Request, Response, NextFunction } from 'express';
import { getSetting } from './settings';
import { SETTING_KEYS } from './constants';

/** Parse YYYY-MM from query param, default to current month */
export function parseMonth(raw: string | undefined): string {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Parse month string to date range { dateFrom, dateTo, year, mon } */
export function getMonthDateRange(raw: string | undefined): { month: string; dateFrom: string; dateTo: string; year: string; mon: string } {
  const month = parseMonth(raw);
  const [year, mon] = month.split('-');
  const lastDay = new Date(Number(year), Number(mon), 0).getDate();
  return { month, dateFrom: `${year}-${mon}-01`, dateTo: `${year}-${mon}-${String(lastDay).padStart(2, '0')}`, year, mon };
}

/** Get work_organization_id or send 400 error. Returns null if not configured. */
export function getWorkOrgId(res: Response): string | null {
  const workOrgId = getSetting(SETTING_KEYS.WORK_ORG_ID);
  if (!workOrgId) {
    res.status(400).json({ error: 'Werkorganisatie niet geconfigureerd. Ga naar Instellingen.' });
    return null;
  }
  return workOrgId;
}

/** Express middleware that requires work_organization_id and sets res.locals.workOrgId. */
export function requireWorkOrg(req: Request, res: Response, next: NextFunction): void {
  const workOrgId = getWorkOrgId(res);
  if (!workOrgId) return;
  res.locals['workOrgId'] = Number(workOrgId);
  next();
}
