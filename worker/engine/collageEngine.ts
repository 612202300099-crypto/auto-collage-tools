/**
 * collageEngine.ts — Server-side polaroid collage generator.
 *
 * Port dari src/utils/collageGenerator.ts ke Node.js:
 * - Menggunakan `canvas` (node-canvas) sebagai pengganti browser Canvas API
 * - Menggunakan file paths (string) sebagai pengganti File objects
 * - Dimensi, layout, crop marks, label — IDENTIK dengan versi browser
 * - Mendukung batch color tag
 *
 * Layout: 5×5 grid polaroid di atas kertas A3+ (31×47 cm, ~350 DPI)
 */
import { createCanvas, loadImage, type Canvas } from 'canvas';
import path from 'path';
import { logger } from '../utils/logger.ts';
import sharp from 'sharp';

// ─── DIMENSIONS (identik dengan src/utils/collageGenerator.ts) ────────────

const PX_PER_CM = 137.795;
const CANVAS_WIDTH = Math.round(31 * PX_PER_CM);   // 4271 px
const CANVAS_HEIGHT = Math.round(47 * PX_PER_CM);  // 6477 px

const PHOTO_WIDTH = Math.round(6 * PX_PER_CM);     // 827 px
const PHOTO_HEIGHT = Math.round(9 * PX_PER_CM);    // 1240 px

const GRID_SIZE = 5;
const GAP_X = 0;
const GAP_Y = 0;

const totalGridWidth = (PHOTO_WIDTH * GRID_SIZE) + (GAP_X * (GRID_SIZE - 1));
const totalGridHeight = (PHOTO_HEIGHT * GRID_SIZE) + (GAP_Y * (GRID_SIZE - 1));

const MARGIN_X = (CANVAS_WIDTH - totalGridWidth) / 2;
const MARGIN_Y = CANVAS_HEIGHT - totalGridHeight;

const FRAME_PADDING = Math.round(PHOTO_WIDTH * 0.04);
const FRAME_BOTTOM_PADDING = Math.round(PHOTO_HEIGHT * 0.10);

// ─── MAIN COLLAGE BUILDER ────────────────────────────────────────────────────

export interface CollageOptions {
  /** Array of local image file paths */
  imagePaths: string[];
  /** Label text (typically resi number) */
  label: string;
  /** Current page index (1-based) */
  pageIndex: number;
  /** Total number of pages */
  totalPages: number;
  /** Optional color tag for batch identification */
  tagColor?: string | null;
  /** Callback for progress reporting */
  onProgress?: (current: number, total: number, status: string) => void;
}

/**
 * Generate a single collage page as a Canvas object.
 * Returns the Canvas which can be exported to PNG buffer or JPEG data URL.
 */
export async function buildCollageCanvas(options: CollageOptions): Promise<Canvas> {
  const { imagePaths, label, pageIndex, totalPages, tagColor, onProgress } = options;

  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background putih kertas
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Load all images
  const images: any[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    try {
      // Decode and Enhance with Sharp
      const processedBuffer = await sharp(imagePaths[i])
        .modulate({
          brightness: 1.05,
          saturation: 1.2
        })
        .normalize() // Auto-contrast / histogram equalization
        .toFormat('jpeg')
        .jpeg({ quality: 90 })
        .toBuffer();

      const img = await loadImage(processedBuffer);
      images.push(img);
      onProgress?.(i + 1, imagePaths.length, `Loaded & Enhanced ${path.basename(imagePaths[i])}`);
    } catch (err: any) {
      logger.warn('COLLAGE', `Failed to load image: ${path.basename(imagePaths[i])}: ${err.message}`);
    }
  }

  if (images.length === 0) {
    throw new Error('No valid images to process');
  }

  // Pad images hingga 25 slot (loop jika kurang)
  const paddedImages = [...images];
  while (paddedImages.length < 25) {
    paddedImages.push(images[paddedImages.length % images.length]);
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
    const img = paddedImages[i];
    const photoAreaW = PHOTO_WIDTH - FRAME_PADDING * 2;
    const photoAreaH = PHOTO_HEIGHT - FRAME_PADDING - FRAME_BOTTOM_PADDING;
    const photoAreaX = left + FRAME_PADDING;
    const photoAreaY = top + FRAME_PADDING;

    // SMART-FIT: Center crop (konsisten dengan versi browser tanpa AI)
    const scale = Math.max(photoAreaW / img.naturalWidth, photoAreaH / img.naturalHeight);
    const focalX = img.naturalWidth / 2;
    const focalY = img.naturalHeight / 2;

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

    // Clip & draw
    ctx.save();
    ctx.beginPath();
    ctx.rect(photoAreaX, photoAreaY, photoAreaW, photoAreaH);
    ctx.clip();
    ctx.drawImage(img, destX, destY, drawW, drawH);
    ctx.restore();

    // Batch color tag (triangle di pojok kiri atas foto)
    if (tagColor) {
      const tagSize = Math.round(photoAreaW * 0.04);
      ctx.fillStyle = tagColor;
      ctx.beginPath();
      ctx.moveTo(photoAreaX, photoAreaY);
      ctx.lineTo(photoAreaX + tagSize, photoAreaY);
      ctx.lineTo(photoAreaX, photoAreaY + tagSize);
      ctx.closePath();
      ctx.fill();
    }

    onProgress?.(i + 1, 25, `Drawing photo ${i + 1}/25`);
  }

  // ─── CROP MARKS ────────────────────────────────────────────────────────
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

  // ─── DYNAMIC LABEL ────────────────────────────────────────────────────
  const labelText = `${label.toUpperCase()} - PAGES ${pageIndex}/${totalPages}`;
  const labelHeight = Math.round(MARGIN_Y * 0.7);
  const fontSize = Math.round(labelHeight * 0.45);
  ctx.font = `bold ${fontSize}px sans-serif`;

  const textMetrics = ctx.measureText(labelText);
  const horizontalPadding = fontSize * 1.5;
  const labelWidth = textMetrics.width + horizontalPadding;

  const labelX = Math.round((CANVAS_WIDTH - labelWidth) / 2);
  const labelY = Math.round((MARGIN_Y - labelHeight) / 2);

  // Rounded rectangle background
  ctx.fillStyle = 'black';
  ctx.beginPath();
  const radius = Math.round(labelHeight * 0.25);
  ctx.moveTo(labelX + radius, labelY);
  ctx.lineTo(labelX + labelWidth - radius, labelY);
  ctx.arcTo(labelX + labelWidth, labelY, labelX + labelWidth, labelY + radius, radius);
  ctx.lineTo(labelX + labelWidth, labelY + labelHeight - radius);
  ctx.arcTo(labelX + labelWidth, labelY + labelHeight, labelX + labelWidth - radius, labelY + labelHeight, radius);
  ctx.lineTo(labelX + radius, labelY + labelHeight);
  ctx.arcTo(labelX, labelY + labelHeight, labelX, labelY + labelHeight - radius, radius);
  ctx.lineTo(labelX, labelY + radius);
  ctx.arcTo(labelX, labelY, labelX + radius, labelY, radius);
  ctx.closePath();
  ctx.fill();

  // Label text
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, labelX + labelWidth / 2, labelY + labelHeight / 2);

  return canvas;
}

/**
 * Generate a collage and return it as a JPEG Buffer.
 * Used by the PDF engine for embedding.
 */
export async function generateCollageJpegBuffer(options: CollageOptions): Promise<Buffer> {
  const canvas = await buildCollageCanvas(options);
  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

/**
 * Generate a collage and return it as a PNG Buffer.
 */
export async function generateCollagePngBuffer(options: CollageOptions): Promise<Buffer> {
  const canvas = await buildCollageCanvas(options);
  return canvas.toBuffer('image/png');
}
