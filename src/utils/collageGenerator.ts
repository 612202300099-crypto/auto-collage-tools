import { yieldToMain } from './yieldToMain';
import { detectFace } from './aiService';

// ─────────────────────────────────────────────────────────────────
// INTERNAL: build + draw canvas — dipakai oleh kedua export di bawah
// ─────────────────────────────────────────────────────────────────
async function buildCollageCanvas(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  useAI: boolean = false,
  onPhotoProgress?: (current: number, total: number, status: string) => void,
  customPxPerCm?: number,
  tagColor?: string | null
): Promise<HTMLCanvasElement> {
  const PX_PER_CM = customPxPerCm || 137.795;
  const CANVAS_WIDTH = Math.round(31 * PX_PER_CM); // 4271 px (at 350 DPI)
  const CANVAS_HEIGHT = Math.round(47 * PX_PER_CM); // 6477 px (at 350 DPI)

  const PHOTO_WIDTH = Math.round(6 * PX_PER_CM); // 827 px
  const PHOTO_HEIGHT = Math.round(9 * PX_PER_CM); // 1240 px

  const GRID_SIZE = 5;
  const GAP_X = 0; // Diganti menjadi 0 agar foto saling menempel sempurna
  const GAP_Y = 0; // Diganti menjadi 0 agar foto saling menempel sempurna

  const totalGridWidth = (PHOTO_WIDTH * GRID_SIZE) + (GAP_X * (GRID_SIZE - 1));
  const totalGridHeight = (PHOTO_HEIGHT * GRID_SIZE) + (GAP_Y * (GRID_SIZE - 1));

  const MARGIN_X = (CANVAS_WIDTH - totalGridWidth) / 2;   // center horizontal
  const MARGIN_Y = CANVAS_HEIGHT - totalGridHeight;        // bottom-aligned (sisa ruang ke atas)

  // Padding yang lebih tipis agar foto terasa lebih "FULL"
  const FRAME_PADDING = Math.round(PHOTO_WIDTH * 0.04);  // Perkecil dari 0.08 ke 0.04
  const FRAME_BOTTOM_PADDING = Math.round(PHOTO_HEIGHT * 0.10);  // Perkecil dari 0.15 ke 0.10

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas tidak didukung di browser ini!');

  // Background putih kertas
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Helper: load File → HTMLImageElement
  const loadImage = (file: File): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Gagal memuat ${file.name}`)); };
      img.src = url;
    });

  // Load gambar satu per satu + yield agar tidak memblok decode
  const imgElements: HTMLImageElement[] = [];
  if (imageFiles.length === 0) throw new Error('Tidak ada gambar');

  for (let i = 0; i < imageFiles.length; i++) {
    try {
      const img = await loadImage(imageFiles[i]);
      imgElements.push(img);
      onPhotoProgress?.(i + 1, 25, `Decoding ${imageFiles[i].name}...`);
      await yieldToMain();
    } catch (err) {
      console.error(err); // skip gambar corrupt
    }
  }

  if (imgElements.length === 0) throw new Error('Tidak ada gambar yang valid');

  // Padding hingga 25 slot
  const paddedElements = [...imgElements];
  while (paddedElements.length < 25) {
    paddedElements.push(imgElements[paddedElements.length % imgElements.length]);
  }

  const OUTER_BORDER_PX = 0; // Dihilangkan seluruhnya karena kita menggunakan garis bantu potong di persimpangan

  // Draw 25 polaroid frames — yield setelah setiap foto (kanvas 27MP sangat berat)
  for (let i = 0; i < Math.min(paddedElements.length, 25); i++) {
    const row = Math.floor(i / GRID_SIZE);
    const col = i % GRID_SIZE;
    const left = Math.round(MARGIN_X + (col * (PHOTO_WIDTH + GAP_X)));
    const top = Math.round(MARGIN_Y + (row * (PHOTO_HEIGHT + GAP_Y)));

    // 1. Frame putih (kertas polaroid full, tanpa border hitam)
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.fillRect(
      left,
      top,
      PHOTO_WIDTH,
      PHOTO_HEIGHT
    );

    // 2. Foto dalam frame (merender ke Canvas Destination)
    const img = paddedElements[i];
    const photoAreaX = left + FRAME_PADDING;
    const photoAreaY = top + FRAME_PADDING;
    const photoAreaW = PHOTO_WIDTH - FRAME_PADDING * 2;
    const photoAreaH = PHOTO_HEIGHT - FRAME_PADDING - FRAME_BOTTOM_PADDING;

    // --- ADAPTIVE SCALING (AI Support) ---
    const currentFile = imageFiles[i % imageFiles.length];

    // Default Cover Scale
    let scale = Math.max(photoAreaW / img.naturalWidth, photoAreaH / img.naturalHeight);
    let focalX = img.naturalWidth / 2;
    let focalY = img.naturalHeight / 2;

    if (useAI) {
      onPhotoProgress?.(i + 1, 25, `AI Smart-Fit Analysis for ${currentFile.name}...`);
      const face = await detectFace(currentFile);

      if (face) {
        const fx = (face.xmin / 1000) * img.naturalWidth;
        const fy = (face.ymin / 1000) * img.naturalHeight;
        const fw = ((face.xmax - face.xmin) / 1000) * img.naturalWidth;
        const fh = ((face.ymax - face.ymin) / 1000) * img.naturalHeight;

        // "Kecilin Otomatis" jika wajah tidak muat di crop standar
        const requiredScaleW = photoAreaW / fw;
        const requiredScaleH = photoAreaH / fh;

        // Pilih scale yang paling "aman" agar wajah tidak terpotong
        const smartScale = Math.min(requiredScaleW, requiredScaleH, scale);
        scale = smartScale;

        // Pusatkan pada tengah-tengah grup wajah
        focalX = fx + fw / 2;
        focalY = fy + fh / 2;

        onPhotoProgress?.(i + 1, 25, `AI Smart-Fit applied`);
      }
    }

    // Logika Penggambaran Destination (Bebas Glitch Koordinat Negatif)
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;

    const destFaceCenterX = photoAreaX + photoAreaW / 2;
    const destFaceCenterY = photoAreaY + photoAreaH / 2;

    let destX = destFaceCenterX - (focalX * scale);
    let destY = destFaceCenterY - (focalY * scale);

    // Final Clamp: Jaga agar area kosong tidak muncul kalau tidak perlu
    if (drawW >= photoAreaW) {
      destX = Math.min(destX, photoAreaX);
      destX = Math.max(destX, photoAreaX + photoAreaW - drawW);
    } else {
      // Jika di zoom-out sampai lebih kecil dari frame, pastikan berada persis di TENGAH
      destX = photoAreaX + (photoAreaW - drawW) / 2;
    }

    if (drawH >= photoAreaH) {
      destY = Math.min(destY, photoAreaY);
      destY = Math.max(destY, photoAreaY + photoAreaH - drawH);
    } else {
      destY = photoAreaY + (photoAreaH - drawH) / 2;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(photoAreaX, photoAreaY, photoAreaW, photoAreaH);
    ctx.clip();

    ctx.drawImage(img, destX, destY, drawW, drawH);
    ctx.restore();

    // ─── DRAW TRIANGLE TAG (BATCH IDENTIFIER) ───
    if (tagColor) {
      const tagSize = Math.round(photoAreaW * 0.08); // Ukuran proposional
      ctx.fillStyle = tagColor;
      ctx.beginPath();
      ctx.moveTo(photoAreaX, photoAreaY);
      ctx.lineTo(photoAreaX + tagSize, photoAreaY);
      ctx.lineTo(photoAreaX, photoAreaY + tagSize);
      ctx.closePath();
      ctx.fill();
    }

    await yieldToMain();
  }

  // --- MENGGAMBAR GARIS BANTU POTONG (CROP MARKS) ---
  const CROP_MARK_LEN = Math.round(0.5 * PX_PER_CM); // Panjang garis potong ~5mm
  ctx.strokeStyle = 'rgb(0, 0, 0)';
  ctx.lineWidth = Math.round(0.015 * PX_PER_CM); // Ketebalan tipis untuk panduan potong

  for (let r = 0; r <= GRID_SIZE; r++) {
    for (let c = 0; c <= GRID_SIZE; c++) {
      const cx = Math.round(MARGIN_X + c * PHOTO_WIDTH);
      const cy = Math.round(MARGIN_Y + r * PHOTO_HEIGHT);

      ctx.beginPath();
      // Garis ke Atas (Tengah & Bawah)
      if (r > 0) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy - CROP_MARK_LEN);
      }
      // Garis ke Bawah (Tengah & Atas)
      if (r < GRID_SIZE) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy + CROP_MARK_LEN);
      }
      // Garis ke Kiri (Tengah & Kanan)
      if (c > 0) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx - CROP_MARK_LEN, cy);
      }
      // Garis ke Kanan (Tengah & Kiri)
      if (c < GRID_SIZE) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + CROP_MARK_LEN, cy);
      }
      ctx.stroke();
    }
  }

  // --- MENGGAMBAR LABEL DINAMIS (NAMA CUSTOMER) ---
  const formattedIndex = index.toString();
  const formattedTotal = total.toString();
  const labelText = `${customerName.toUpperCase()} - PAGES ${formattedIndex}/${formattedTotal}`;

  // 1. Tentukan tinggi label dan ukuran font berdasarkan sisa ruang (MARGIN_Y)
  // Kita buat tinggi label 70% dari sisa ruang agar lebih gagah
  const labelHeight = Math.round(MARGIN_Y * 0.7);
  const fontSize = Math.round(labelHeight * 0.45);

  ctx.font = `bold ${fontSize}px sans-serif`;

  // 2. Hitung lebar teks asli untuk membuat wadah yang presisi
  const textMetrics = ctx.measureText(labelText);
  const textWidth = textMetrics.width;

  // 3. Tambahkan padding (ruang napas) di kiri & kanan agar tidak sesak
  const horizontalPadding = fontSize * 1.5;
  const labelWidth = textWidth + horizontalPadding;

  // 4. Hitung posisi agar pas di tengah (Center)
  const labelX = Math.round((CANVAS_WIDTH - labelWidth) / 2);
  const labelY = Math.round((MARGIN_Y - labelHeight) / 2);
  const labelRadius = Math.round(labelHeight * 0.25);

  // Gambar Wadah Hitam (Pill Shape)
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, labelRadius);
  ctx.fill();

  // Gambar Teks Putih tepat di tengah wadah
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, labelX + labelWidth / 2, labelY + labelHeight / 2);

  return canvas;
}

// ─────────────────────────────────────────────────────────────────
// EXPORT A: Mode PNG → returns Blob (langsung download per sheet)
// ─────────────────────────────────────────────────────────────────
export async function generateCollageLocal(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  useAI: boolean = false,
  onPhotoProgress?: (current: number, total: number, status: string) => void,
  tagColor?: string | null
): Promise<Blob> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total, useAI, onPhotoProgress, undefined, tagColor);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => { if (blob) resolve(blob); else reject(new Error('Gagal membuat PNG blob')); },
      'image/png',
      1.0
    );
  });
}

// ─────────────────────────────────────────────────────────────────
// EXPORT B: Mode PDF → returns JPEG DataURL (untuk embedding ke jsPDF)
//
// KENAPA JPEG bukan PNG:
//   • PNG per sheet → 15-25 MB (lossless, sangat besar)
//   • JPEG q=0.92   → 2-4 MB  (5-10x lebih kecil, kualitas cetak tetap bagus)
//   • Tidak perlu FileReader (Blob→string) → langsung toDataURL, 1 langkah
//   • Ini yang mencegah RAM crash saat mode PDF dengan banyak halaman
// ─────────────────────────────────────────────────────────────────
export async function generateCollageJpegDataURL(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  useAI: boolean = false,
  onPhotoProgress?: (current: number, total: number, status: string) => void,
  tagColor?: string | null
): Promise<string> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total, useAI, onPhotoProgress, undefined, tagColor);

  // Menggunakan kualitas 0.95 (hampir lossless) agar koordinat Smart-Fit tetap presisi di PDF
  return canvas.toDataURL('image/jpeg', 0.95);
}

// ─────────────────────────────────────────────────────────────────
// EXPORT C: Mode Preview → returns DataURL (Low Res untuk pratinjau)
// ─────────────────────────────────────────────────────────────────
export async function generateCollagePreview(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  useAI: boolean = false,
  tagColor?: string | null
): Promise<string> {
  // Gunakan 40 PX_PER_CM (~100 DPI) agar cepat untuk preview
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total, useAI, undefined, 40, tagColor);
  return canvas.toDataURL('image/jpeg', 0.7);
}
