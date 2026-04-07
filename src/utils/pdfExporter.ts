import jsPDF from 'jspdf';
import { yieldToMain } from './yieldToMain';

// Ukuran kertas dalam cm (harus konsisten dengan collageGenerator.ts)
const PAGE_WIDTH_CM = 31;
const PAGE_HEIGHT_CM = 47;

/**
 * Konversi Blob gambar menjadi Data URL (base64)
 * Dibutuhkan karena jsPDF.addImage() menerima data URL
 */
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Gagal membaca blob gambar'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Gabungkan semua Blob gambar (per sheet) menjadi satu file PDF multi-halaman,
 * lalu langsung trigger download ke browser.
 *
 * @param imageBlobs   - Array Blob PNG, satu per sheet (urutan = urutan halaman)
 * @param customerName - Nama customer (untuk nama file PDF)
 */
export async function exportAllSheetsToPDF(
  imageBlobs: Blob[],
  customerName: string
): Promise<void> {
  if (imageBlobs.length === 0) throw new Error('Tidak ada sheet untuk diekspor');

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'cm',
    format: [PAGE_WIDTH_CM, PAGE_HEIGHT_CM],
    compress: true, // Kompres PDF agar ukuran file lebih kecil
  });

  for (let i = 0; i < imageBlobs.length; i++) {
    const dataUrl = await blobToDataURL(imageBlobs[i]);

    // Halaman pertama sudah otomatis ada, mulai dari ke-2 baru addPage
    if (i > 0) {
      pdf.addPage([PAGE_WIDTH_CM, PAGE_HEIGHT_CM], 'portrait');
    }

    // Tempel gambar memenuhi seluruh halaman (0,0 → 31x47 cm)
    pdf.addImage(dataUrl, 'PNG', 0, 0, PAGE_WIDTH_CM, PAGE_HEIGHT_CM);

    // Yield setelah setiap halaman di-embed — addImage sangat berat (konversi PNG→base64 full-res)
    await yieldToMain();
  }

  const safeFileName = customerName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  pdf.save(`${safeFileName}_semua_halaman.pdf`);
}
