import { ParsedIngRow } from './csvParser';

export function parsePluxeeCsv(content: string): ParsedIngRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const rows: ParsedIngRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/, '').trim();
    if (!line) continue;

    const values = splitCsvLine(line, ';');
    if (values.length < 3) continue;

    const dateRaw = values[0].replace(/^"|"$/g, '').trim();
    const beschrijving = values[1].replace(/^"|"$/g, '').trim();
    const bedragRaw = values[2].replace(/^"|"$/g, '').trim();

    // Alleen "Uitgave" regels importeren
    if (!beschrijving.startsWith('Uitgave ')) continue;

    // Datum: DD-MM-YYYY -> YYYY-MM-DD
    const parts = dateRaw.split('-');
    if (parts.length !== 3) continue;
    const isoDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;

    // Bedrag: "+ 11.1 €" -> -11.1 (negatief want uitgave)
    const amountMatch = bedragRaw.match(/\+\s*([\d.]+(?:,\d+)?)\s*€/);
    if (!amountMatch) continue;
    const amount = -parseFloat(amountMatch[1].replace(',', '.'));

    // UUID extraheren uit "(Transactie UUID)"
    const uuidMatch = beschrijving.match(/\(Transactie ([0-9a-f-]+)\)/i);
    const ing_transaction_id = uuidMatch ? `pluxee_${uuidMatch[1]}` : `pluxee_${dateRaw}_${amount}`;

    // Merchant name: tekst tussen "Uitgave " en " (Transactie"
    const merchantMatch = beschrijving.match(/^Uitgave\s+(.+?)\s*\(Transactie/);
    const counterparty_name = merchantMatch ? merchantMatch[1].trim() : beschrijving;

    rows.push({
      date: isoDate,
      description: beschrijving,
      amount,
      ing_transaction_id,
      counterparty_account: null,
      counterparty_name,
      raw: { Datum: dateRaw, Beschrijving: beschrijving, Bedrag: bedragRaw },
    });
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
