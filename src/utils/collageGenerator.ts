import { yieldToMain } from './yieldToMain';
import { detectFace, AIEngine } from './aiService';

// ─────────────────────────────────────────────────────────────────
// INTERNAL: build + draw canvas — dipakai oleh kedua export di bawah
// ─────────────────────────────────────────────────────────────────
async function buildCollageCanvas(
  imageFiles: File[],
  customerName: string,
  index: number, // 1-indexed
  total: number,
  aiEngine: AIEngine | null = null, // null means no AI
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
  const GAP_X = 0; // Foto saling menempel sempurna
  const GAP_Y = 0; // Foto saling menempel sempurna

  const totalGridWidth = (PHOTO_WIDTH * GRID_SIZE) + (GAP_X * (GRID_SIZE - 1));
  const totalGridHeight = (PHOTO_HEIGHT * GRID_SIZE) + (GAP_Y * (GRID_SIZE - 1));

  const MARGIN_X = (CANVAS_WIDTH - totalGridWidth) / 2;   // center horizontal
  const MARGIN_Y = CANVAS_HEIGHT - totalGridHeight;        // bottom-aligned (sisa ruang ke atas)

  const FRAME_PADDING = Math.round(PHOTO_WIDTH * 0.04);
  const FRAME_BOTTOM_PADDING = Math.round(PHOTO_HEIGHT * 0.10);

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

  // Load gambar
  const imgElements: HTMLImageElement[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    try {
      const img = await loadImage(imageFiles[i]);
      imgElements.push(img);
      onPhotoProgress?.(i + 1, imageFiles.length, `Decoding ${imageFiles[i].name}...`);
      await yieldToMain();
    } catch (err) {
      console.error(err);
    }
  }

  if (imgElements.length === 0) throw new Error('Tidak ada gambar yang valid');

  // Padding hingga 25 slot
  const paddedElements = [...imgElements];
  while (paddedElements.length < 25) {
    paddedElements.push(imgElements[paddedElements.length % imgElements.length]);
  }

  // Draw 25 polaroid frames
  for (let i = 0; i < 25; i++) {
    const row = Math.floor(i / GRID_SIZE);
    const col = i % GRID_SIZE;
    const left = Math.round(MARGIN_X + (col * (PHOTO_WIDTH + GAP_X)));
    const top = Math.round(MARGIN_Y + (row * (PHOTO_HEIGHT + GAP_Y)));

    // 1. Frame putih
    ctx.fillStyle = 'white';
    ctx.fillRect(left, top, PHOTO_WIDTH, PHOTO_HEIGHT);

    // 2. Foto dalam frame
    const img = paddedElements[i];
    const photoAreaW = PHOTO_WIDTH - FRAME_PADDING * 2;
    const photoAreaH = PHOTO_HEIGHT - FRAME_PADDING - FRAME_BOTTOM_PADDING;
    const photoAreaX = left + FRAME_PADDING;
    const photoAreaY = top + FRAME_PADDING;

    // --- SMART-FIT v2 (POWERFULL & CENTERED) ---
    const currentFile = imageFiles[i % imageFiles.length];
    let scale = Math.max(photoAreaW / img.naturalWidth, photoAreaH / img.naturalHeight);
    let focalX = img.naturalWidth / 2;
    let focalY = img.naturalHeight / 2;

    if (aiEngine) {
      onPhotoProgress?.(i + 1, 25, `${aiEngine.toUpperCase()} AI Analysis: ${currentFile.name}...`);
      const face = await detectFace(currentFile, aiEngine);

      if (face) {
        const fx = (face.xmin / 1000) * img.naturalWidth;
        const fy = (face.ymin / 1000) * img.naturalHeight;
        const fw = ((face.xmax - face.xmin) / 1000) * img.naturalWidth;
        const fh = ((face.ymax - face.ymin) / 1000) * img.naturalHeight;

        const requiredScaleW = photoAreaW / fw;
        const requiredScaleH = photoAreaH / fh;
        
        scale = Math.min(requiredScaleW, requiredScaleH, scale);
        
        focalX = fx + fw / 2;
        focalY = fy + fh / 2;
      }
    }

    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;

    let destX = (photoAreaX + photoAreaW / 2) - (focalX * scale);
    let destY = (photoAreaY + photoAreaH / 2) - (focalY * scale);

    if (drawW >= photoAreaW) {
      destX = Math.min(destX, photoAreaX);
      destX = Math.max(destX, photoAreaX + photoAreaW - drawW);
    } else {
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

    if (tagColor) {
      const tagSize = Math.round(photoAreaW * 0.08);
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

  // --- CROP MARKS ---
  const CROP_MARK_LEN = Math.round(0.5 * PX_PER_CM);
  ctx.strokeStyle = 'black';
  ctx.lineWidth = Math.round(0.015 * PX_PER_CM);

  for (let r = 0; r <= GRID_SIZE; r++) {
    for (let c = 0; c <= GRID_SIZE; c++) {
      const cx = Math.round(MARGIN_X + c * PHOTO_WIDTH);
      const cy = Math.round(MARGIN_Y + r * PHOTO_HEIGHT);
      ctx.beginPath();
      if (r > 0) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - CROP_MARK_LEN); }
      if (r < GRID_SIZE) { ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + CROP_MARK_LEN); }
      if (c > 0) { ctx.moveTo(cx, cy); ctx.lineTo(cx - CROP_MARK_LEN, cy); }
      if (c < GRID_SIZE) { ctx.moveTo(cx, cy); ctx.lineTo(cx + CROP_MARK_LEN, cy); }
      ctx.stroke();
    }
  }

  // --- DYNAMIC LABEL ---
  const labelText = `${customerName.toUpperCase()} - PAGES ${index}/${total}`;
  const labelHeight = Math.round(MARGIN_Y * 0.7);
  const fontSize = Math.round(labelHeight * 0.45);
  ctx.font = `bold ${fontSize}px sans-serif`;

  const textMetrics = ctx.measureText(labelText);
  const horizontalPadding = fontSize * 1.5;
  const labelWidth = textMetrics.width + horizontalPadding;

  const labelX = Math.round((CANVAS_WIDTH - labelWidth) / 2);
  const labelY = Math.round((MARGIN_Y - labelHeight) / 2);

  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, Math.round(labelHeight * 0.25));
  ctx.fill();

  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, labelX + labelWidth / 2, labelY + labelHeight / 2);

  return canvas;
}

// ─────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────

export async function generateCollageLocal(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  aiEngine: AIEngine | null = null,
  onPhotoProgress?: (current: number, total: number, status: string) => void,
  tagColor?: string | null
): Promise<Blob> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total, aiEngine, onPhotoProgress, undefined, tagColor);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error('Gagal membuat PNG')); }, 'image/png', 1.0);
  });
}

export async function generateCollageJpegDataURL(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  aiEngine: AIEngine | null = null,
  onPhotoProgress?: (current: number, total: number, status: string) => void,
  tagColor?: string | null
): Promise<string> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total, aiEngine, onPhotoProgress, undefined, tagColor);
  return canvas.toDataURL('image/jpeg', 0.95);
}

export async function generateCollagePreview(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number,
  aiEngine: AIEngine | null = null,
  tagColor?: string | null
): Promise<string> {
  const canvas = await buildCollageCanvas(imageFiles, customerName, index, total, aiEngine, undefined, 40, tagColor);
  return canvas.toDataURL('image/jpeg', 0.7);
}
