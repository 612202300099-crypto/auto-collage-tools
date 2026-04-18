/**
 * aiService.ts — Client aman untuk AI Face Detection dengan Persistent Cache.
 * Menggunakan IndexedDB agar hasil scan wajah disimpan permanen di browser.
 */

interface FaceResult {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

// ── SETUP INDEXEDDB ────────────────────────────────────────────────────────
const DB_NAME = 'AutoCollageCache';
const STORE_NAME = 'FaceDetection';
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedFace(key: string): Promise<FaceResult | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function setCachedFace(key: string, data: FaceResult): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(data, key);
  } catch (e) { console.warn('Gagal menyimpan cache:', e); }
}

// ── CORE LOGIC ─────────────────────────────────────────────────────────────

/**
 * detectFace: Mendeteksi wajah melalui proxy API (api/detect-face).
 * Dilengkapi dengan persistent caching di IndexedDB.
 */
export async function detectFace(file: File): Promise<FaceResult | null> {
  // 1. Generate Unique Key (Nama + Size + LastModified)
  const cacheKey = `${file.name}-${file.size}-${file.lastModified}`;

  // 2. Cek Cache
  const cached = await getCachedFace(cacheKey);
  if (cached) {
    console.log(`[AI] Cache Hit for ${file.name} (Using Smart-Memory)`);
    return cached;
  }

  // 3. Jika tidak di cache, convert ke Base64 (Resize dikit ke max 800px agar hemat bandwidth)
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const img = new Image();
      img.onload = async () => {
        // Resize sederhana agar upload tidak berat
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 800;
        let w = img.width;
        let h = img.height;
        if (w > h && w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; }
        else if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; }
        
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, w, h);
        
        const base64 = canvas.toDataURL('image/jpeg', 0.6);

        try {
          const res = await fetch('/api/detect-face', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64 }),
          });
          const data = await res.json();
          
          if (data && typeof data.xmin === 'number') {
            await setCachedFace(cacheKey, data);
            resolve(data);
          } else {
            resolve(null);
          }
        } catch (err) {
          console.error('API Detection Failed:', err);
          resolve(null);
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}
