import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
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
  roundTrip: boolean;
  raw_subject: string;
}

function parseNmbsHtml(html: string, subject: string, emailDate?: string): Partial<NmbsTicket> {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  // Amount: look for "Totaal"/"Total" amount first, then take the largest
  const totalPatterns = [
    /(?:Totaal|Total|Totale\s+prijs)[:\s]*€\s*([\d]+[,.][\d]+)/i,
    /(?:Totaal|Total|Totale\s+prijs)[:\s]*([\d]+[,.][\d]+)\s*€/i,
    /(?:Totaal|Total|Totale\s+prijs)[:\s]*EUR\s*([\d]+[,.][\d]+)/i,
  ];
  let amount = 0;
  for (const pattern of totalPatterns) {
    const m = text.match(pattern);
    if (m) { amount = parseFloat(m[1].replace(',', '.')); break; }
  }
  if (amount === 0) {
    // Fallback: collect ALL amounts and take the largest (typically the total)
    const allAmounts: number[] = [];
    const globalPattern = /€\s*([\d]+[,.][\d]+)|([\d]+[,.][\d]+)\s*€|EUR\s*([\d]+[,.][\d]+)/g;
    let match;
    while ((match = globalPattern.exec(text)) !== null) {
      const val = match[1] ?? match[2] ?? match[3];
      if (val) allAmounts.push(parseFloat(val.replace(',', '.')));
    }
    if (allAmounts.length > 0) amount = Math.max(...allAmounts);
  }

  // Stations: combined regex — "2e klas" starts with digit, used as terminator
  let from = '';
  let to = '';
  const routeMatch = text.match(
    /(?:Van|De)\s*:\s*(.+?)\s+(?:Naar|À)\s*:\s*(.+?)(?=\s+\d)/i
  );
  if (routeMatch) {
    from = routeMatch[1].trim();
    to = routeMatch[2].trim();
  }

  // Round trip detection
  const roundTrip = /heen\s+en\s+terug/i.test(text);

  // Date from subject or body: DD/MM/YYYY or DD-MM-YYYY, fallback to email's internalDate
  const dateMatch = (subject + ' ' + text).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  let date = emailDate ?? new Date().toISOString().split('T')[0];
  if (dateMatch) {
    const [, d, m, y] = dateMatch;
    date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return { date, from, to, amount, roundTrip, raw_subject: subject };
}

// Bundled NMBS logo as data URI (belgiantrain.be blocks automated requests)
const NMBS_LOGO_PATH = path.join(__dirname, '../../data/nmbs-logo.png');
let nmbsLogoDataUri: string | null = null;
function getNmbsLogoDataUri(): string | null {
  if (nmbsLogoDataUri) return nmbsLogoDataUri;
  if (fs.existsSync(NMBS_LOGO_PATH)) {
    const data = fs.readFileSync(NMBS_LOGO_PATH);
    nmbsLogoDataUri = `data:image/png;base64,${data.toString('base64')}`;
  }
  return nmbsLogoDataUri;
}

async function emailHtmlToPdf(html: string): Promise<Buffer> {
  // Replace belgiantrain.be image src URLs with bundled logo (only in src= attributes)
  const logoUri = getNmbsLogoDataUri();
  if (logoUri) {
    html = html.replace(
      /(src\s*=\s*["'])https?:\/\/www\.belgiantrain\.be\/[^"'\s]+/gi,
      `$1${logoUri}`
    );
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Block stylesheets/fonts/external images — all images are now inlined
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('about:')) {
      req.continue();
    } else if (req.resourceType() !== 'document') {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '15mm', bottom: '15mm', left: '10mm', right: '10mm' },
  });
  await browser.close();
  return Buffer.from(pdf);
}

export interface FetchedTicket {
  ticket: NmbsTicket;
  pdfBuffer: Buffer;
  messageId: string;
}

// Gmail API returns URL-safe base64 (RFC 4648 §5); data: URIs need standard base64
function gmailB64ToStandard(urlSafeB64: string): string {
  return urlSafeB64.replace(/-/g, '+').replace(/_/g, '/');
}

// Collect inline images (CID references) from email parts (recursive)
function collectInlineImages(parts: any[] | undefined): Map<string, string> {
  const images = new Map<string, string>();
  if (!parts) return images;
  for (const part of parts) {
    const cidHeader = part.headers?.find((h: any) => h.name?.toLowerCase() === 'content-id');
    if (cidHeader && part.mimeType?.startsWith('image/') && part.body?.data) {
      const cleanCid = cidHeader.value.replace(/[<>]/g, '');
      images.set(cleanCid, `data:${part.mimeType};base64,${gmailB64ToStandard(part.body.data)}`);
    }
    if (part.parts) {
      for (const [k, v] of collectInlineImages(part.parts)) images.set(k, v);
    }
  }
  return images;
}

// Collect all parts with attachmentId (recursive) for CID image fetching
function collectAttachmentParts(parts: any[] | undefined): any[] {
  const result: any[] = [];
  if (!parts) return result;
  for (const part of parts) {
    const cidHeader = part.headers?.find((h: any) => h.name?.toLowerCase() === 'content-id');
    if (cidHeader && part.mimeType?.startsWith('image/') && part.body?.attachmentId && !part.body?.data) {
      result.push(part);
    }
    if (part.parts) result.push(...collectAttachmentParts(part.parts));
  }
  return result;
}

export async function fetchNmbsTickets(dateFrom: string, dateTo: string): Promise<FetchedTicket[]> {
  const auth = buildAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Gmail's before: operator is exclusive, so use the day AFTER dateTo
  const afterDate = dateFrom.replace(/-/g, '/');
  const beforeParts = dateTo.split('-');
  const nextDay = new Date(Number(beforeParts[0]), Number(beforeParts[1]) - 1, Number(beforeParts[2]) + 1);
  const beforeDate = `${nextDay.getFullYear()}/${String(nextDay.getMonth() + 1).padStart(2, '0')}/${String(nextDay.getDate()).padStart(2, '0')}`;

  // Broad query to catch NMBS/SNCB ticket emails
  const query = [
    `(from:noreply@b-rail.be OR from:info@nmbs.be OR from:noreply@sncb.be`,
    ` OR from:eticket@nmbs.be OR from:no-reply@sales.belgiantrain.be`,
    ` OR subject:treinticket OR subject:"train ticket"`,
    ` OR subject:"e-ticket NMBS" OR subject:"NMBS Mobile Ticket")`,
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
    const emailDateMs = msgRes.data.internalDate;
    const emailDate = emailDateMs
      ? new Date(Number(emailDateMs)).toISOString().split('T')[0]
      : undefined;

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

    // Replace cid: image references with inline base64 data URIs
    const inlineImages = collectInlineImages(payload.parts);
    if (inlineImages.size > 0) {
      htmlBody = htmlBody.replace(/cid:([^"'\s]+)/g, (match, cid) => inlineImages.get(cid) ?? match);
    }

    // Fetch attachment data for images referenced by attachmentId (recursive)
    const attachmentParts = collectAttachmentParts(payload.parts);
    for (const part of attachmentParts) {
      const cidHeader = part.headers?.find((h: any) => h.name?.toLowerCase() === 'content-id');
      const cleanCid = cidHeader.value.replace(/[<>]/g, '');
      if (htmlBody.includes(`cid:${cleanCid}`)) {
        const attRes = await gmail.users.messages.attachments.get({
          userId: 'me', messageId: msg.id!, id: part.body.attachmentId,
        });
        if (attRes.data.data) {
          const dataUri = `data:${part.mimeType};base64,${gmailB64ToStandard(attRes.data.data)}`;
          htmlBody = htmlBody.replace(new RegExp(`cid:${cleanCid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), dataUri);
        }
      }
    }

    const parsed = parseNmbsHtml(htmlBody, subject, emailDate);
    const ticket: NmbsTicket = {
      messageId: msg.id,
      date: parsed.date ?? new Date().toISOString().split('T')[0],
      from: parsed.from ?? '',
      to: parsed.to ?? '',
      amount: parsed.amount ?? 0,
      roundTrip: parsed.roundTrip ?? false,
      raw_subject: subject,
    };

    // Skip emails where no valid amount was found (not a real ticket)
    if (ticket.amount <= 0) continue;

    const pdfBuffer = await emailHtmlToPdf(htmlBody);
    results.push({ ticket, pdfBuffer, messageId: msg.id });
  }

  return results;
}
