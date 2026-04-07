/**
 * yieldToMain — Menyerahkan kontrol kembali ke browser sebentar.
 *
 * Digunakan untuk mencegah main thread blocking saat operasi berat
 * (canvas draw 27MP, PDF embed, dll). Standar industri untuk long tasks.
 *
 * Prioritas:
 * 1. scheduler.yield() — Chrome 115+, paling efisien
 * 2. MessageChannel    — Lebih cepat dari setTimeout (microtask boundary)
 * 3. setTimeout(0)     — Fallback universal
 */
export function yieldToMain(): Promise<void> {
  // Gunakan Scheduler API jika tersedia (Chrome 115+)
  if (
    typeof globalThis !== 'undefined' &&
    'scheduler' in globalThis &&
    typeof (globalThis as any).scheduler?.yield === 'function'
  ) {
    return (globalThis as any).scheduler.yield();
  }

  // Fallback: MessageChannel lebih cepat dari setTimeout
  return new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(undefined);
  });
}
