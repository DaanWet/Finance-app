import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as cheerio from 'cheerio';
import PDFDocument from 'pdfkit';
import { getDb } from '../db';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function getOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
    process.env['GOOGLE_REDIRECT_URI'] ?? 'http://localhost:3000/api/expenses/gmail/callback'
  );
}

export function getAuthUrl(): string {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function exchangeCode(code: string): Promise<void> {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  if (tokens.refresh_token) upsert.run('google_refresh_token', tokens.refresh_token);
  if (tokens.access_token) upsert.run('google_access_token', tokens.access_token);
}

export function isGmailConnected(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('google_refresh_token') as { value: string } | undefined;
  return !!row?.value;
}

function buildAuthClient(): OAuth2Client {
  const db = getDb();
  const getSetting = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: getSetting('google_refresh_token'),
    access_token: getSetting('google_access_token'),
  });
  return oauth2Client;
}

export interface NmbsTicket {
  messageId: string;
  date: string;
  from: string;
  to: string;
  amount: number;
  raw_subject: string;
}

function parseNmbsHtml(html: string, subject: string): Partial<NmbsTicket> {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  // Amount: match patterns like "€ 12,50" or "12.50 €"
  const amountPatterns = [
    /€\s*([\d]+[,.][\d]+)/,
    /([\d]+[,.][\d]+)\s*€/,
    /EUR\s*([\d]+[,.][\d]+)/,
    /([\d]+[,.][\d]+)\s*EUR/,
  ];
  let amount = 0;
  for (const pattern of amountPatterns) {
    const m = text.match(pattern);
    if (m) { amount = parseFloat(m[1].replace(',', '.')); break; }
  }

  // Stations: NMBS emails use Van/Naar or De/À patterns
  let from = '';
  let to = '';
  const fromMatch = text.match(/(?:Van|De)\s*[:\-]?\s*([A-Za-zÀ-ÿ\-\s]{2,30?})(?:\s*(?:Naar|À|naar|à)|\s*\d|\n)/i);
  const toMatch = text.match(/(?:Naar|À)\s*[:\-]?\s*([A-Za-zÀ-ÿ\-\s]{2,30?})(?:\s*\d|\s*€|\n|$)/i);
  if (fromMatch) from = fromMatch[1].trim();
  if (toMatch) to = toMatch[1].trim();

  // Date from subject or body: DD/MM/YYYY or DD-MM-YYYY
  const dateMatch = (subject + ' ' + text).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  let date = new Date().toISOString().split('T')[0];
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return { date, from, to, amount, raw_subject: subject };
}

async function generateTicketPdf(ticket: NmbsTicket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 60, size: 'A4' });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1e293b')
      .text('Treinticket NMBS / SNCB', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor('#64748b')
      .text(ticket.raw_subject, { align: 'center' });
    doc.moveDown(1.5);

    // Divider
    doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(1);

    // Details
    const details: [string, string][] = [
      ['Datum', ticket.date],
      ['Van', ticket.from || '—'],
      ['Naar', ticket.to || '—'],
      ['Bedrag', `€ ${ticket.amount.toFixed(2)}`],
    ];

    for (const [label, value] of details) {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#475569').text(label, 60, y, { width: 130 });
      doc.font('Helvetica').fontSize(11).fillColor('#0f172a').text(value, 200, y);
      doc.moveDown(0.8);
    }

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#94a3b8')
      .text('Automatisch gegenereerd op basis van NMBS e-mailticket.', { align: 'center' });

    doc.end();
  });
}

export interface FetchedTicket {
  ticket: NmbsTicket;
  pdfBuffer: Buffer;
  messageId: string;
}

export async function fetchNmbsTickets(dateFrom: string, dateTo: string): Promise<FetchedTicket[]> {
  const auth = buildAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const afterDate = dateFrom.replace(/-/g, '/');
  const beforeDate = dateTo.replace(/-/g, '/');

  // Broad query to catch NMBS/SNCB ticket emails
  const query = [
    `(from:noreply@b-rail.be OR from:info@nmbs.be OR from:noreply@sncb.be`,
    ` OR from:eticket@nmbs.be OR subject:treinticket OR subject:train ticket`,
    ` OR subject:e-ticket NMBS)`,
    ` after:${afterDate} before:${beforeDate}`,
  ].join('');

  const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  const messages = listRes.data.messages ?? [];

  const db = getDb();
  const results: FetchedTicket[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;

    // Skip already imported
    const existing = db.prepare('SELECT id FROM expense_receipts WHERE gmail_message_id = ?').get(msg.id);
    if (existing) continue;

    const msgRes = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
    const payload = msgRes.data.payload;
    if (!payload) continue;

    const subject = payload.headers?.find(h => h.name?.toLowerCase() === 'subject')?.value ?? '';

    // Extract HTML body (could be nested in multipart)
    let htmlBody = '';
    const findHtml = (parts: typeof payload.parts): string => {
      if (!parts) return '';
      for (const part of parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          const nested = findHtml(part.parts);
          if (nested) return nested;
        }
      }
      return '';
    };

    if (payload.mimeType === 'text/html' && payload.body?.data) {
      htmlBody = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else {
      htmlBody = findHtml(payload.parts ?? []);
    }

    if (!htmlBody) continue;

    const parsed = parseNmbsHtml(htmlBody, subject);
    const ticket: NmbsTicket = {
      messageId: msg.id,
      date: parsed.date ?? new Date().toISOString().split('T')[0],
      from: parsed.from ?? '',
      to: parsed.to ?? '',
      amount: parsed.amount ?? 0,
      raw_subject: subject,
    };

    const pdfBuffer = await generateTicketPdf(ticket);
    results.push({ ticket, pdfBuffer, messageId: msg.id });
  }

  return results;
}
