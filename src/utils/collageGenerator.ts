import { yieldToMain } from './yieldToMain';

// ─────────────────────────────────────────────────────────────────
// INTERNAL: build + draw canvas — dipakai oleh kedua export di bawah
// ─────────────────────────────────────────────────────────────────
async function buildCollageCanvas(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number
): Promise<HTMLCanvasElement> {
  const PX_PER_CM = 137.795;
  const CANVAS_WIDTH  = Math.round(31 * PX_PER_CM); // 4271 px
  const CANVAS_HEIGHT = Math.round(47 * PX_PER_CM); // 6477 px

  const PHOTO_WIDTH  = Math.round(6 * PX_PER_CM); // 827 px
  const PHOTO_HEIGHT = Math.round(9 * PX_PER_CM); // 1240 px

  const GRID_SIZE = 5;
  const GAP_X = Math.round(0.25 * PX_PER_CM);
  const GAP_Y = Math.round(0.25 * PX_PER_CM);

  const totalGridWidth  = (PHOTO_WIDTH  * GRID_SIZE) + (GAP_X * (GRID_SIZE - 1));
  const totalGridHeight = (PHOTO_HEIGHT * GRID_SIZE) + (GAP_Y * (GRID_SIZE - 1));

  const MARGIN_X = (CANVAS_WIDTH - totalGridWidth) / 2;   // center horizontal
  const MARGIN_Y = CANVAS_HEIGHT - totalGridHeight;        // bottom-aligned (sisa ruang ke atas)

  const FRAME_PADDING        = Math.round(PHOTO_WIDTH  * 0.08);  // 66px
  const FRAME_BOTTOM_PADDING = Math.round(PHOTO_HEIGHT * 0.15);  // 186px

  const canvas = document.createElement('canvas');
  canvas.width  = CANVAS_WIDTH;
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
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
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
      await yieldToMain(); // napas browser setelah setiap decode
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

  const OUTER_BORDER_PX = Math.round(0.02 * PX_PER_CM); // 0.2mm = ~3px

  // Draw 25 polaroid frames — yield setelah setiap foto (kanvas 27MP sangat berat)
  for (let i = 0; i < Math.min(paddedElements.length, 25); i++) {
    const row = Math.floor(i / GRID_SIZE);
    const col = i % GRID_SIZE;
    const left = Math.round(MARGIN_X + (col * (PHOTO_WIDTH  + GAP_X)));
    const top  = Math.round(MARGIN_Y + (row * (PHOTO_HEIGHT + GAP_Y)));

    // 1. Outer border hitam 0.2mm
    ctx.strokeStyle = 'rgb(0, 0, 0)';
    ctx.lineWidth   = OUTER_BORDER_PX;
    ctx.strokeRect(
      left + OUTER_BORDER_PX / 2,
      top  + OUTER_BORDER_PX / 2,
      PHOTO_WIDTH  - OUTER_BORDER_PX,
      PHOTO_HEIGHT - OUTER_BORDER_PX
    );

    // 2. Frame putih (sama dengan background)
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.fillRect(
      left + OUTER_BORDER_PX,
      top  + OUTER_BORDER_PX,
      PHOTO_WIDTH  - OUTER_BORDER_PX * 2,
      PHOTO_HEIGHT - OUTER_BORDER_PX * 2
    );

    // 3. Foto dalam frame (object-fit: cover)
    const img           = paddedElements[i];
    const innerLeft     = left + OUTER_BORDER_PX;
    const innerTop      = top  + OUTER_BORDER_PX;
    const innerFrameW   = PHOTO_WIDTH  - OUTER_BORDER_PX * 2;
    const innerFrameH   = PHOTO_HEIGHT - OUTER_BORDER_PX * 2;
    const photoAreaX    = innerLeft + FRAME_PADDING;
    const photoAreaY    = innerTop  + FRAME_PADDING;
    const photoAreaW    = innerFrameW - FRAME_PADDING * 2;
    const photoAreaH    = innerFrameH - FRAME_PADDING - FRAME_BOTTOM_PADDING;

    const scale = Math.max(photoAreaW / img.naturalWidth, photoAreaH / img.naturalHeight);
    const sw = photoAreaW / scale;
    const sh = photoAreaH / scale;
    const sx = (img.naturalWidth  - sw) / 2;
    const sy = (img.naturalHeight - sh) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(photoAreaX, photoAreaY, photoAreaW, photoAreaH);
    ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, photoAreaX, photoAreaY, photoAreaW, photoAreaH);
    ctx.restore();

    await yieldToMain(); // yield setelah setiap foto — KRUSIAL anti-freeze
  }

  // Label "NAMA - P1/3" di ruang atas (~1cm)
  const labelWidth  = Math.round(5 * PX_PER_CM);
  const labelHeight = Math.round(MARGIN_Y * 0.6);
  const labelX      = Math.round((CANVAS_WIDTH  - labelWidth)  / 2);
  const labelY      = Math.round((MARGIN_Y - labelHeight) / 2);
  const labelRadius = Math.round(labelHeight * 0.2);

  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, labelRadius);
  ctx.fill();

  const labelText = `${customerName.toUpperCase()} - P${index}/${total}`;
  const fontSize  = Math.round(labelHeight * 0.45);
  ctx.fillStyle    = 'white';
  ctx.font         = `bold ${fontSize}px sans-serif`;
  ctx.textAlign    = 'center';
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
  total: number
): Promise<Blob> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total);
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
  total: number
): Promise<string> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total);
  // toDataURL sinkronus dan cepat (hanya encoding base64), tidak memblok
  return canvas.toDataURL('image/jpeg', 0.92);
}
