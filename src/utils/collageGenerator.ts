import { yieldToMain } from './yieldToMain';

export async function generateCollageLocal(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number
): Promise<Blob> {
  const PX_PER_CM = 137.795;
  const CANVAS_WIDTH = Math.round(31 * PX_PER_CM);  // 4271 px | ukuran kertas 31 cm
  const CANVAS_HEIGHT = Math.round(47 * PX_PER_CM); // 6477 px | ukuran kertas 47 cm

  const PHOTO_WIDTH = Math.round(6 * PX_PER_CM); // 827 px
  const PHOTO_HEIGHT = Math.round(9 * PX_PER_CM); // 1240 px

  const GRID_SIZE = 5;
  const GAP_X = Math.round(0.25 * PX_PER_CM); // 0.25 cm = jarak samping antar foto (kiri-kanan)
  const GAP_Y = Math.round(0.25 * PX_PER_CM); // 0.25 cm = jarak bawah  antar baris (atas-bawah)

  const totalGridWidth = (PHOTO_WIDTH * GRID_SIZE) + (GAP_X * (GRID_SIZE - 1));
  const totalGridHeight = (PHOTO_HEIGHT * GRID_SIZE) + (GAP_Y * (GRID_SIZE - 1));

  // Horizontal: foto ditengahkan kiri-kanan
  const MARGIN_X = (CANVAS_WIDTH - totalGridWidth) / 2;
  // Vertical: foto ditekan ke BAWAH kertas. Semua sisa ruang (~1cm) naik ke atas.
  const MARGIN_Y = CANVAS_HEIGHT - totalGridHeight;

  const FRAME_PADDING = Math.round(PHOTO_WIDTH * 0.08);        // 66px  | jarak foto dari tepian frame
  const FRAME_BOTTOM_PADDING = Math.round(PHOTO_HEIGHT * 0.15); // 186px | ruang putih bawah polaroid

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Canvas tidak didukung di browser ini!');

  // Background Putih Kertas
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Helper: load file gambar menjadi HTMLImageElement
  const loadImage = (file: File): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Gagal memuat gambar ${file.name}`)); };
      img.src = url;
    });
  };

  // Muat semua gambar satu per satu dengan yield agar browser tidak freeze saat decode
  const imgElements: HTMLImageElement[] = [];
  if (imageFiles.length === 0) throw new Error('Tidak ada gambar');

  for (let i = 0; i < imageFiles.length; i++) {
    try {
      const img = await loadImage(imageFiles[i]);
      imgElements.push(img);
      // Yield setelah setiap load — cegah freeze saat decode banyak file
      await yieldToMain();
    } catch (err) {
      console.error(err); // Skip gambar corrupt
    }
  }

  if (imgElements.length === 0) throw new Error('Tidak ada gambar yang valid');

  // Padding hingga 25 foto
  const paddedElements = [...imgElements];
  while (paddedElements.length < 25) {
    paddedElements.push(imgElements[paddedElements.length % imgElements.length]);
  }

  // Tebal outer border hitam: 0.2 mm = 0.02 cm → ~3px @ 350DPI
  const OUTER_BORDER_PX = Math.round(0.02 * PX_PER_CM); // ~3px

  // Draw 25 Polaroid frames — yield setelah setiap foto untuk mencegah main thread blocking
  for (let i = 0; i < Math.min(paddedElements.length, 25); i++) {
    const row = Math.floor(i / GRID_SIZE);
    const col = i % GRID_SIZE;

    const left = Math.round(MARGIN_X + (col * (PHOTO_WIDTH + GAP_X)));
    const top  = Math.round(MARGIN_Y + (row * (PHOTO_HEIGHT + GAP_Y)));

    // 1. Outer border hitam (tipis 0.2mm)
    ctx.strokeStyle = 'rgb(0, 0, 0)';
    ctx.lineWidth = OUTER_BORDER_PX;
    ctx.strokeRect(
      left + OUTER_BORDER_PX / 2,
      top  + OUTER_BORDER_PX / 2,
      PHOTO_WIDTH  - OUTER_BORDER_PX,
      PHOTO_HEIGHT - OUTER_BORDER_PX
    );

    // 2. Frame putih murni (sama dengan background kertas)
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.fillRect(
      left + OUTER_BORDER_PX,
      top  + OUTER_BORDER_PX,
      PHOTO_WIDTH  - OUTER_BORDER_PX * 2,
      PHOTO_HEIGHT - OUTER_BORDER_PX * 2
    );

    // 3. Foto dalam frame (Object Fit Cover)
    const img = paddedElements[i];
    const innerLeft        = left + OUTER_BORDER_PX;
    const innerTop         = top  + OUTER_BORDER_PX;
    const innerFrameWidth  = PHOTO_WIDTH  - OUTER_BORDER_PX * 2;
    const innerFrameHeight = PHOTO_HEIGHT - OUTER_BORDER_PX * 2;

    const photoAreaX = innerLeft + FRAME_PADDING;
    const photoAreaY = innerTop  + FRAME_PADDING;
    const photoAreaW = innerFrameWidth  - FRAME_PADDING * 2;
    const photoAreaH = innerFrameHeight - FRAME_PADDING - FRAME_BOTTOM_PADDING;

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

    // ⚡ KRUSIAL: yield setelah setiap foto digambar.
    // Menggambar 25 foto pada kanvas 27 Megapiksel bisa memblok
    // main thread selama puluhan detik dan menyebabkan browser freeze.
    await yieldToMain();
  }

  // Label "NAMA - P1/3" di ruang kosong ~1cm bagian atas kertas
  const labelWidth  = Math.round(5 * PX_PER_CM);       // ~690px ≈ 5cm
  const labelHeight = Math.round(MARGIN_Y * 0.6);       // 60% dari tinggi ruang atas

  const labelX = Math.round((CANVAS_WIDTH - labelWidth) / 2); // center horizontal
  const labelY = Math.round((MARGIN_Y - labelHeight) / 2);    // center vertikal dalam ruang atas

  // Background label (hitam)
  const labelRadius = Math.round(labelHeight * 0.2);
  ctx.fillStyle = 'black';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, labelRadius);
  ctx.fill();

  // Text label
  const labelText = `${customerName.toUpperCase()} - P${index}/${total}`;
  const fontSize  = Math.round(labelHeight * 0.45);
  ctx.fillStyle    = 'white';
  ctx.font         = `bold ${fontSize}px sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, labelX + (labelWidth / 2), labelY + (labelHeight / 2));

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Gagal membuat Blob dari Canvas'));
    }, 'image/png', 1.0);
  });
}
