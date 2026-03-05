import crypto from 'crypto';

export interface ParsedIngRow {
  date: string;
  description: string;
  amount: number;
  ing_transaction_id: string;
  counterparty_account: string | null;
  counterparty_name: string | null;
  raw: Record<string, string>;
}

export function parseIngCsv(content: string): ParsedIngRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Detecteer separator: tab, puntkomma of komma
  const header = lines[0].replace(/\r/, '');
  const sep = header.includes('\t') ? '\t' : header.includes(';') ? ';' : ',';
  const headers = header.split(sep).map(h => h.trim().replace(/^"|"$/g, ''));

  const rows: ParsedIngRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/, '').trim();
    if (!line) continue;

    const values = splitCsvLine(line, sep);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').trim().replace(/^"|"$/g, ''); });

    // Nieuw ING-formaat: Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht
    // Oud ING-formaat: Datum;Naam;Rekening;Tegenrekening;Code;Afschrijving;Bijschrijving;Mededeling
    const isNewFormat = 'Boekingsdatum' in row || 'Omzetnummer' in row;

    let dateRaw: string;
    let description: string;
    let amount: number;
    let ing_transaction_id: string;
    let counterparty_account: string | null = null;
    let counterparty_name: string | null = null;

    if (isNewFormat) {
      dateRaw = row['Boekingsdatum'] ?? '';
      if (!dateRaw) continue;

      // Bedrag: negatief = debet, positief = credit; komma als decimaalteken
      const bedragRaw = (row['Bedrag'] ?? '0').replace(',', '.');
      amount = parseFloat(bedragRaw) || 0;

      description = row['Bericht'] || row['Detail van de omzet'] || row['Omschrijving'] || 'Onbekend';
      counterparty_account = row['Rekening tegenpartij'] || null;
      counterparty_name = row['Omschrijving'] || null;

      // Gebruik Omzetnummer als stabiel ID indien aanwezig
      const omzetnummer = row['Omzetnummer'] ?? '';
      if (omzetnummer) {
        ing_transaction_id = omzetnummer;
      } else {
        const hashInput = `${dateRaw}|${amount}|${description}`;
        ing_transaction_id = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
      }
    } else {
      // Oud formaat
      dateRaw = row['Datum'] ?? row['Date'] ?? '';
      if (!dateRaw) continue;

      const nameRaw = row['Naam'] ?? row['Name'] ?? '';
      const debitRaw = row['Afschrijving'] ?? row['Debit'] ?? '0';
      const creditRaw = row['Bijschrijving'] ?? row['Credit'] ?? '0';
      const memoRaw = row['Mededeling'] ?? row['Communication'] ?? '';

      const debit = parseFloat(debitRaw.replace(',', '.') || '0');
      const credit = parseFloat(creditRaw.replace(',', '.') || '0');
      amount = credit > 0 ? credit : -debit;

      description = memoRaw || nameRaw || 'Onbekend';
      counterparty_account = row['Tegenrekening'] || null;
      counterparty_name = nameRaw || null;

      const hashInput = `${dateRaw}|${amount}|${description}`;
      ing_transaction_id = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
    }

    // Datum normaliseren naar YYYY-MM-DD
    // Ondersteunt: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
    let isoDate = dateRaw;
    const slashParts = dateRaw.split('/');
    const dashParts = dateRaw.split('-');
    if (slashParts.length === 3) {
      isoDate = `${slashParts[2]}-${slashParts[1].padStart(2, '0')}-${slashParts[0].padStart(2, '0')}`;
    } else if (dashParts.length === 3 && dashParts[0].length === 2) {
      // DD-MM-YYYY
      isoDate = `${dashParts[2]}-${dashParts[1].padStart(2, '0')}-${dashParts[0].padStart(2, '0')}`;
    }

    rows.push({ date: isoDate, description, amount, ing_transaction_id, counterparty_account, counterparty_name, raw: row });
  }

  return rows;
}

function splitCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
