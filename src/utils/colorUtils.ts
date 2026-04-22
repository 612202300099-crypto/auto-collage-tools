/**
 * colorUtils.ts — Utilitas untuk menghasilkan variasi warna yang tak terbatas.
 * Menggunakan algoritma Golden Ratio Conjugate untuk distribusi Hue yang maksimal.
 */

const GOLDEN_RATIO_CONJUGATE = 0.618033988749895;

/**
 * generateRandomBatchColor: Menghasilkan warna HSL yang unik dan acak.
 * Setiap kali dipanggil, ia akan menghasilkan warna yang berbeda drastis dari sebelumnya.
 */
export function generateRandomBatchColor(): string {
  // Gunakan basis random awal agar antar editor (laptop berbeda) punya titik mulai berbeda
  const seed = Math.random();
  const hue = Math.floor((seed + GOLDEN_RATIO_CONJUGATE) * 360) % 360;
  
  // Saturation 75% & Lightness 50% untuk warna yang vibrant tapi solid (Deep Colors)
  return `hsl(${hue}, 75%, 50%)`;
}

/**
 * generateNextColorByStep: Menghasilkan warna berdasarkan langkah (step).
 * Cocok untuk urutan dalam satu sesi agar tiap klik 'Next' menghasilkan warna berbeda.
 */
export function generateNextColorByStep(step: number): string {
  let h = (step * GOLDEN_RATIO_CONJUGATE) % 1;
  const hue = Math.floor(h * 360);
  return `hsl(${hue}, 80%, 45%)`;
}
