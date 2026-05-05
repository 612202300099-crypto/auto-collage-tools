/**
 * colorUtils.ts — Server-side batch color generation.
 *
 * Identical algorithm to src/utils/colorUtils.ts (Golden Ratio Conjugate).
 * Duplicated here to avoid importing browser-targeted code into Node.js.
 */

const GOLDEN_RATIO_CONJUGATE = 0.618033988749895;

/**
 * Generate a unique random HSL color for batch identification.
 */
export function generateRandomBatchColor(): string {
  const seed = Math.random();
  const hue = Math.floor((seed + GOLDEN_RATIO_CONJUGATE) * 360) % 360;
  return `hsl(${hue}, 75%, 50%)`;
}
