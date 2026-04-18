import jsPDF from 'jspdf';
import { yieldToMain } from './yieldToMain';
import { generateCollageJpegDataURL } from './collageGenerator';

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
 *
 * ARSITEKTUR KUNCI (anti-crash):
 * Setiap sheet diproses SATU PER SATU:
 *   generate JPEG → masuk PDF → dataURL langsung dibuang → lanjut sheet berikutnya
 *
 * Tidak ada akumulasi blob/dataURL di RAM.
 * Menggunakan JPEG (bukan PNG) → 5-10x lebih kecil → tidak habiskan RAM.
 *
 * @param sheets       - Array data sheet yang akan diproses
 * @param customerName - Nama customer (untuk nama file)
 * @param onProgress   - Callback laporan progress per sheet
 */
export async function buildAndDownloadPDF(
  sheets: SheetInput[],
  customerName: string,
  onProgress: (current: number, total: number, sheetName: string) => void,
  useAI: boolean = false,
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

    // Generate JPEG DataURL langsung — TIDAK melalui Blob → FileReader
    // JPEG 0.92 quality: kualitas cetak sangat baik, ukuran 5-10x lebih kecil dari PNG
    const dataUrl = await generateCollageJpegDataURL(
      sheet.files,
      customerName,
      sheet.sheetIndex,
      sheet.totalSheets,
      useAI,
      (current, total, status) => {
        onProgress(sheet.sheetIndex, sheets.length, `${sheet.name} > ${status}`);
      },
      tagColor
    );

    // Halaman pertama sudah ada secara default di jsPDF
    if (i > 0) {
      pdf.addPage([PAGE_WIDTH_CM, PAGE_HEIGHT_CM], 'portrait');
    }

    // Embed JPEG — setelah baris ini, dataUrl boleh di-GC (garbage collected)
    pdf.addImage(dataUrl, 'JPEG', 0, 0, PAGE_WIDTH_CM, PAGE_HEIGHT_CM);

    // Yield agar browser napas setelah addImage (operasi encoding berat)
    await yieldToMain();
  }

  // Simpan & trigger download
  const safeFileName = customerName.replace(/[^a-zA-Z0-9_\-]/g, ' ');
  pdf.save(`${safeFileName} - Pages (Semua Halaman).pdf`);
}
