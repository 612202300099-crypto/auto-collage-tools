/**
 * pdfEngine.ts — Server-side PDF generator using jsPDF.
 *
 * Port dari src/utils/pdfExporter.ts ke Node.js:
 * - Menggunakan collageEngine untuk generate JPEG buffer per page
 * - Supports qty > 1 → duplicate pages
 * - Exports ke file path (bukan browser download)
 */
import { jsPDF } from 'jspdf';
import fs from 'fs';
import { generateCollageJpegBuffer } from './collageEngine.ts';
import { logger } from '../utils/logger.ts';

const PAGE_WIDTH_CM = 31;
const PAGE_HEIGHT_CM = 47;

export interface PDFGenerateOptions {
  /** Array of local image file paths */
  imagePaths: string[];
  /** Label text (resi number) */
  label: string;
  /** Number of copies (qty from spreadsheet) */
  qty: number;
  /** Batch color tag */
  tagColor?: string | null;
  /** Output file path */
  outputPath: string;
  /** Progress callback */
  onProgress?: (status: string) => void;
}

/**
 * Generate a multi-page PDF collage and save to disk.
 *
 * Jika qty > 1, setiap page akan di-duplicate sesuai qty.
 * Contoh: 25 foto, qty 2 → PDF 2 halaman (isi identik).
 */
export async function generatePDF(options: PDFGenerateOptions): Promise<void> {
  const { imagePaths, label, qty, tagColor, outputPath, onProgress } = options;

  if (imagePaths.length === 0) {
    throw new Error('No images to generate PDF from');
  }

  // Split images into chunks of 25 (max per page)
  const chunks: string[][] = [];
  for (let i = 0; i < imagePaths.length; i += 25) {
    chunks.push(imagePaths.slice(i, i + 25));
  }

  // Total pages = chunks × qty
  const totalPages = chunks.length * qty;

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'cm',
    format: [PAGE_WIDTH_CM, PAGE_HEIGHT_CM],
    compress: true,
  });

  let pageCount = 0;

  for (let q = 0; q < qty; q++) {
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const pageIndex = c + 1 + (q * chunks.length);

      onProgress?.(`Generating page ${pageIndex}/${totalPages}...`);
      logger.info('PDF', `Generating page ${pageIndex}/${totalPages} for ${label}`);

      // Generate JPEG buffer for this page
      const jpegBuffer = await generateCollageJpegBuffer({
        imagePaths: chunk,
        label,
        pageIndex,
        totalPages,
        tagColor,
      });

      // Convert buffer to base64 data URL for jsPDF
      const base64 = jpegBuffer.toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64}`;

      if (pageCount > 0) {
        pdf.addPage([PAGE_WIDTH_CM, PAGE_HEIGHT_CM], 'portrait');
      }

      pdf.addImage(dataUrl, 'JPEG', 0, 0, PAGE_WIDTH_CM, PAGE_HEIGHT_CM);
      pageCount++;
    }
  }

  // Save PDF to disk
  const pdfBuffer = Buffer.from(pdf.output('arraybuffer'));
  fs.writeFileSync(outputPath, pdfBuffer);

  const sizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(2);
  logger.success('PDF', `Saved ${outputPath} (${sizeMB} MB, ${totalPages} pages)`);
}
