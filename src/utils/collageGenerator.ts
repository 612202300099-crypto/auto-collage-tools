export async function generateCollageLocal(
  imageFiles: File[],
  customerName: string,
  index: number,
  total: number
): Promise<Blob> {
  const PX_PER_CM = 137.795;
  const CANVAS_WIDTH = Math.round(31.5 * PX_PER_CM); // 4341
  const CANVAS_HEIGHT = Math.round(47.5 * PX_PER_CM); // 6545
  
  const PHOTO_WIDTH = Math.round(6 * PX_PER_CM); // 827
  const PHOTO_HEIGHT = Math.round(9 * PX_PER_CM); // 1240
  
  const GRID_SIZE = 5;
  const GAP_X = Math.round(0.3 * PX_PER_CM);
  const GAP_Y = Math.round(0.5 * PX_PER_CM);
  
  const totalGridWidth = (PHOTO_WIDTH * GRID_SIZE) + (GAP_X * (GRID_SIZE - 1));
  const totalGridHeight = (PHOTO_HEIGHT * GRID_SIZE) + (GAP_Y * (GRID_SIZE - 1));
  
  const MARGIN_X = (CANVAS_WIDTH - totalGridWidth) / 2;
  const MARGIN_Y = (CANVAS_HEIGHT - totalGridHeight) / 2;

  const FRAME_PADDING = Math.round(PHOTO_WIDTH * 0.08); // 66
  const FRAME_BOTTOM_PADDING = Math.round(PHOTO_HEIGHT * 0.15); // 186
  
  const innerWidth = Math.round(PHOTO_WIDTH - (FRAME_PADDING * 2));
  const innerHeight = Math.round(PHOTO_HEIGHT - FRAME_PADDING - FRAME_BOTTOM_PADDING);

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  
  if (!ctx) throw new Error("Canvas tidak didukung di browser ini!");

  // Background Putih Kertas
  ctx.fillStyle = "rgb(255, 255, 255)";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Helper untuk load file gambar menjadi HTMLImageElement
  const loadImage = (file: File): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Gagal memuat gambar ${file.name}`));
      };
      img.src = url;
    });
  };

  // Muat semua gambar, padding hingga 25 kalau kurang (seperti aslinya)
  const imgElements: HTMLImageElement[] = [];
  if (imageFiles.length === 0) throw new Error("Tidak ada gambar");
  
  for (let i = 0; i < imageFiles.length; i++) {
     try {
       const img = await loadImage(imageFiles[i]);
       imgElements.push(img);
     } catch (err) {
       console.error(err); // Skip corrupt
     }
  }

  if (imgElements.length === 0) throw new Error("Tidak ada gambar yang valid");

  const paddedElements = [...imgElements];
  while (paddedElements.length < 25) {
    paddedElements.push(imgElements[paddedElements.length % imgElements.length]);
  }

  // Draw 25 Polaroid frames
  for (let i = 0; i < Math.min(paddedElements.length, 25); i++) {
    const row = Math.floor(i / GRID_SIZE);
    const col = i % GRID_SIZE;
    
    const left = Math.round(MARGIN_X + (col * (PHOTO_WIDTH + GAP_X)));
    const top = Math.round(MARGIN_Y + (row * (PHOTO_HEIGHT + GAP_Y)));

    // 1. Gambar frame off-white polaroid
    ctx.fillStyle = "rgb(245, 245, 240)";
    ctx.fillRect(left, top, PHOTO_WIDTH, PHOTO_HEIGHT);

    // 2. Gambar foto dalam frame (Object Fit Cover)
    const img = paddedElements[i];
    const targetX = left + FRAME_PADDING;
    const targetY = top + FRAME_PADDING;
    
    const scale = Math.max(innerWidth / img.naturalWidth, innerHeight / img.naturalHeight);
    const sw = innerWidth / scale;
    const sh = innerHeight / scale;
    const sx = (img.naturalWidth - sw) / 2;
    const sy = (img.naturalHeight - sh) / 2;

    ctx.save();
    // Potong agar membulat atau rapi dalam inner rect (opsional, polaroid biasa kotak tajam)
    ctx.beginPath();
    ctx.rect(targetX, targetY, innerWidth, innerHeight);
    ctx.clip();
    
    ctx.drawImage(img, sx, sy, sw, sh, targetX, targetY, innerWidth, innerHeight);
    ctx.restore();
  }

  // Gambar Label SVG "Nama Customer - P1"
  const lastPhotoLeft = Math.round(MARGIN_X + (4 * (PHOTO_WIDTH + GAP_X)));
  const lastPhotoTop = Math.round(MARGIN_Y + (4 * (PHOTO_HEIGHT + GAP_Y)));
  
  const labelWidth = 400;
  const labelHeight = 60;
  const labelX = lastPhotoLeft + (PHOTO_WIDTH - labelWidth); 
  const labelY = lastPhotoTop - 70; // 70px above the last photo
  
  // Background Label (Hitam)
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 5); // Corner radius 5
  ctx.fill();

  // Text label
  const labelText = `${customerName.toUpperCase()} - P${index}`;
  ctx.fillStyle = "white";
  ctx.font = "bold 24px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(labelText, labelX + (labelWidth / 2), labelY + (labelHeight / 2));

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Gagal membuat Blob dari Canvas"));
    }, "image/png", 1.0); // Gunakan standard compression
  });
}
