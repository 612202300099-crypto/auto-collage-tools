import jsPDF from 'jspdf';
import { yieldToMain } from './yieldToMain';
import { generateCollageJpegDataURL } from './collageGenerator';
import type { AIEngine } from './aiService';

// Ukuran kertas dalam cm (konsisten dengan collageGenerator.ts)
const PAGE_WIDTH_CM  = 31;
const PAGE_HEIGHT_CM = 47;

export interface SheetInput {
  files: File[];
  name: string;
  sheetIndex: number;
  totalSheets: number;
}

/**
 * buildAndDownloadPDF — Streaming PDF generator.
 */
export async function buildAndDownloadPDF(
  sheets: SheetInput[],
  customerName: string,
  onProgress: (current: number, total: number, sheetName: string) => void,
  aiEngine: AIEngine | null = null,
  tagColor?: string | null
): Promise<void> {
  if (sheets.length === 0) throw new Error('Tidak ada sheet untuk diekspor');

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'cm',
    format: [PAGE_WIDTH_CM, PAGE_HEIGHT_CM],
    compress: true,
  });

  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];

    onProgress(i + 1, sheets.length, sheet.name);

    // Generate JPEG DataURL langsung
    const dataUrl = await generateCollageJpegDataURL(
      sheet.files,
      customerName,
      sheet.sheetIndex,
      sheet.totalSheets,
      aiEngine,
      (current, total, status) => {
        onProgress(sheet.sheetIndex, sheets.length, `${sheet.name} > ${status}`);
      },
      tagColor
    );

    if (i > 0) {
      pdf.addPage([PAGE_WIDTH_CM, PAGE_HEIGHT_CM], 'portrait');
    }

    pdf.addImage(dataUrl, 'JPEG', 0, 0, PAGE_WIDTH_CM, PAGE_HEIGHT_CM);

    await yieldToMain();
  }

  const safeFileName = customerName.replace(/[^a-zA-Z0-9_\-]/g, ' ');
  pdf.save(`${safeFileName} - Pages (Semua Halaman).pdf`);
}
