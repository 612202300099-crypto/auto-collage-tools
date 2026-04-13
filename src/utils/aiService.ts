/**
 * aiService.ts — Client aman untuk AI Face Detection.
 *
 * Perubahan arsitektur:
 *   SEBELUM: Browser → OpenAI langsung (API Key terekspos!)
 *   SESUDAH: Browser → /api/detect-face (server kita) → OpenAI (API Key aman di server!)
 *
 * Tidak ada satupun credential yang menyentuh kode ini.
 */

// ─── Tipe ─────────────────────────────────────────────────────────────────────

export interface FaceBBox {
  ymin: number; // 0 – 1000
  xmin: number; // 0 – 1000
  ymax: number; // 0 – 1000
  xmax: number; // 0 – 1000
}

/** URL endpoint internal. Otomatis relatif ke domain yang sedang berjalan (dev & prod). */
const DETECT_FACE_ENDPOINT = '/api/detect-face';

/** Resolusi maksimum gambar sebelum dikirim ke server (hemat bandwidth & biaya token AI). */
const RESIZE_MAX_DIM = 512;

/** Kualitas kompresi JPEG sebelum dikirim (0.7 = cukup untuk deteksi wajah, file kecil). */
const RESIZE_JPEG_QUALITY = 0.7;

// ─── Fungsi Publik ────────────────────────────────────────────────────────────

/**
 * Mendeteksi wajah dalam sebuah file gambar.
 *
 * Gambar akan di-resize terlebih dahulu di sisi klien sebelum dikirim ke server
 * untuk menghemat bandwidth dan waktu respons.
 *
 * @param file - File gambar yang akan dianalisis.
 * @returns Bounding box grup wajah dalam koordinat [0-1000], atau null jika gagal/tidak ada wajah.
 */
export async function detectFace(file: File): Promise<FaceBBox | null> {
  try {
    // 1. Resize & konversi ke Base64 di sisi klien (hemat upload bandwidth)
    const imageBase64 = await resizeAndConvertToBase64(file, RESIZE_MAX_DIM, RESIZE_JPEG_QUALITY);

    // 2. Kirim ke Serverless Function kita (bukan langsung ke OpenAI)
    const response = await fetch(DETECT_FACE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageBase64 }),
    });

    if (!response.ok) {
      const errorData = await response.json() as { error?: string };
      // Lempar error dengan pesan dari server agar bisa terlogging dengan konteks yang benar
      throw new Error(errorData?.error ?? `Server responded with status ${response.status}`);
    }

    const data = await response.json() as { face: [number, number, number, number] | null };

    // Server sudah memvalidasi & membersihkan respons, kita tinggal pakai
    if (data.face) {
      const { ymin, xmin, ymax, xmax } = data.face as unknown as FaceBBox;
      return { ymin, xmin, ymax, xmax };
    }

    return null;

  } catch (err) {
    // Gagal deteksi bukan error fatal — collage tetap dibuat dengan center-crop sebagai fallback
    console.warn('[AI] Face detection failed, falling back to center-crop:', err);
    return null;
  }
}

// ─── Utilitas Internal ────────────────────────────────────────────────────────

/**
 * Me-resize gambar ke dimensi maksimum dan mengekspor hasilnya sebagai string Base64 JPEG.
 * Proses ini dilakukan di canvas browser (tidak ada data yang dikirim keluar dulu).
 *
 * @param file - File sumber.
 * @param maxDim - Dimensi terpanjang (lebar atau tinggi) setelah resize.
 * @param quality - Kualitas JPEG output (0.0 – 1.0).
 * @returns String Base64 murni (tanpa prefix `data:image/jpeg;base64,`).
 */
function resizeAndConvertToBase64(
  file: File,
  maxDim: number,
  quality: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (readerEvent) => {
      const img = new Image();

      img.onload = () => {
        // Hitung dimensi baru dengan mempertahankan aspect ratio
        let { width, height } = img;
        if (width > height) {
          if (width > maxDim) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas 2D context.'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        // Ekstrak Base64 murni (hapus prefix `data:image/jpeg;base64,`)
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const base64 = dataUrl.split(',')[1];

        if (!base64) {
          reject(new Error('Failed to export canvas to Base64.'));
          return;
        }

        resolve(base64);
      };

      img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
      img.src = readerEvent.target?.result as string;
    };

    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}
