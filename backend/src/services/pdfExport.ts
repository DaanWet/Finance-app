import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export interface ReceiptData {
  data: Buffer;
  content_type: string;
  filename: string;
  transaction_date?: string;
  transaction_description?: string;
}

/**
 * Combines multiple receipts (PDF, JPEG, PNG) into a single PDF.
 * Adds a cover page listing all included receipts.
 */
export async function combineReceiptsPdf(
  receipts: ReceiptData[],
  month: string
): Promise<Buffer> {
  const merged = await PDFDocument.create();
  const helveticaBold = await merged.embedFont(StandardFonts.HelveticaBold);
  const helvetica = await merged.embedFont(StandardFonts.Helvetica);

  // Cover page
  const coverPage = merged.addPage([595, 842]); // A4
  const { width, height } = coverPage.getSize();

  coverPage.drawText('Bewijsstukken onkostennota', {
    x: 50,
    y: height - 80,
    size: 22,
    font: helveticaBold,
    color: rgb(0.07, 0.09, 0.15),
  });
  coverPage.drawText(`Maand: ${month}`, {
    x: 50,
    y: height - 115,
    size: 13,
    font: helvetica,
    color: rgb(0.39, 0.45, 0.55),
  });
  coverPage.drawText(`Aantal bijlagen: ${receipts.length}`, {
    x: 50,
    y: height - 138,
    size: 13,
    font: helvetica,
    color: rgb(0.39, 0.45, 0.55),
  });

  // Divider line
  coverPage.drawLine({
    start: { x: 50, y: height - 160 },
    end: { x: width - 50, y: height - 160 },
    thickness: 1,
    color: rgb(0.89, 0.91, 0.94),
  });

  // Receipt index on cover
  let listY = height - 195;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const label = r.transaction_description
      ? `${i + 1}. ${r.transaction_date ?? ''} — ${r.transaction_description}`
      : `${i + 1}. ${r.filename}`;
    coverPage.drawText(label.slice(0, 80), {
      x: 60,
      y: listY,
      size: 11,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.29),
    });
    listY -= 22;
    if (listY < 80) break; // Don't overflow cover page
  }

  // Embed each receipt
  for (const receipt of receipts) {
    const ct = receipt.content_type.toLowerCase();

    if (ct === 'application/pdf') {
      try {
        const srcDoc = await PDFDocument.load(receipt.data);
        const indices = srcDoc.getPageIndices();
        const pages = await merged.copyPages(srcDoc, indices);
        for (const page of pages) merged.addPage(page);
      } catch {
        // Corrupt/encrypted PDF: add an error page
        const errPage = merged.addPage([595, 842]);
        errPage.drawText(`Kon PDF niet laden: ${receipt.filename}`, {
          x: 50, y: 400, size: 12, font: helvetica, color: rgb(0.8, 0.2, 0.2),
        });
      }
    } else if (ct === 'image/jpeg' || ct === 'image/jpg') {
      try {
        const img = await merged.embedJpg(receipt.data);
        const page = merged.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      } catch {
        const errPage = merged.addPage([595, 842]);
        errPage.drawText(`Kon afbeelding niet laden: ${receipt.filename}`, {
          x: 50, y: 400, size: 12, font: helvetica, color: rgb(0.8, 0.2, 0.2),
        });
      }
    } else if (ct === 'image/png') {
      try {
        const img = await merged.embedPng(receipt.data);
        const page = merged.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      } catch {
        const errPage = merged.addPage([595, 842]);
        errPage.drawText(`Kon afbeelding niet laden: ${receipt.filename}`, {
          x: 50, y: 400, size: 12, font: helvetica, color: rgb(0.8, 0.2, 0.2),
        });
      }
    }
  }

  const bytes = await merged.save();
  return Buffer.from(bytes);
}
