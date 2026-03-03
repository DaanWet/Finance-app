import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

const TEMPLATE_PATH = path.join(__dirname, '../../data/expense_template.xlsx');

// Template row positions (1-indexed, analysed from Onkostennota_mei-sept-25.xlsx)
const DEEL_I_DATA_START  = 15;
const DEEL_I_DATA_END    = 30; // 16 slots for transport
const DEEL_II_DATA_START = 43; // "Kosten eigen Wax On" section
const DEEL_II_DATA_END   = 51; // 9 slots for other expenses

export interface TransportExpense {
  date: string;       // YYYY-MM-DD
  traject: string;    // "Wetteren - Mechelen - Wetteren"
  parking?: number;   // amount for Parkeertickets column (col H)
  other?: number;     // amount for "andere" column (col I), e.g. train ticket price
  km?: number;        // col G — car km, leave null for train
}

export interface OtherExpense {
  description: string;
  amount: number;
}

/**
 * Determine whether a work expense is transport (DEEL I) or other (DEEL II),
 * and extract the traject string if available.
 */
export function classifyExpense(description: string, notes: string | null): {
  type: 'train' | 'parking' | 'other';
  traject: string;
} {
  const desc = description.toLowerCase();
  const n    = (notes ?? '').toLowerCase();

  const isNmbs    = desc.includes('nmbs') || desc.includes('sncb') || n.includes('van:');
  const isParking = !isNmbs && (
    desc.includes('parking') || desc.includes('park.') || desc.includes('p+r') || desc.includes('4411')
  );

  // Extract traject from notes "Van: X → Naar: Y" (written by Gmail fetch)
  let traject = description;
  const fromM = (notes ?? '').match(/Van:\s*([^\n→]+)/i);
  const toM   = (notes ?? '').match(/Naar:\s*([^\n]+)/i);
  if (fromM && toM) {
    const from = fromM[1].trim();
    const to   = toM[1].trim();
    traject = `${from} - ${to} - ${from}`; // round trip notation
  }

  const type = isNmbs ? 'train' : isParking ? 'parking' : 'other';
  return { type, traject };
}

export async function generateExpenseExcel(
  transportExpenses: TransportExpense[],
  otherExpenses: OtherExpense[],
  period: string,  // e.g. "Maart 2026"
  year: number,
): Promise<Buffer> {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(
      `Sjabloonbestand niet gevonden: ${TEMPLATE_PATH}. ` +
      `Zorg dat expense_template.xlsx aanwezig is in de backend/data/ map.`
    );
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);

  const sheet = wb.getWorksheet(1) ?? wb.worksheets[0];
  if (!sheet) throw new Error('Geen werkblad gevonden in het sjabloon.');

  // ─── Period & year ─────────────────────────────────────────────────────────
  sheet.getCell('D8').value = period;
  sheet.getCell('H8').value = year;

  // ─── Fill DEEL I transport rows ────────────────────────────────────────────
  const maxTransport = DEEL_I_DATA_END - DEEL_I_DATA_START + 1;
  transportExpenses.slice(0, maxTransport).forEach((exp, i) => {
    const r = DEEL_I_DATA_START + i;
    const dateCell = sheet.getCell(`B${r}`);
    dateCell.value  = new Date(exp.date);
    dateCell.numFmt = 'dd/mm/yyyy';

    if (exp.traject)       sheet.getCell(`C${r}`).value = exp.traject;
    if (exp.km    != null) sheet.getCell(`G${r}`).value = exp.km;
    if (exp.parking != null) sheet.getCell(`H${r}`).value = exp.parking;
    if (exp.other   != null) sheet.getCell(`I${r}`).value = exp.other;
  });

  // ─── Fill DEEL II other-expense rows ──────────────────────────────────────
  const maxOther = DEEL_II_DATA_END - DEEL_II_DATA_START + 1;
  otherExpenses.slice(0, maxOther).forEach((exp, i) => {
    const r = DEEL_II_DATA_START + i;
    sheet.getCell(`B${r}`).value = exp.description;
    sheet.getCell(`I${r}`).value = exp.amount;
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
