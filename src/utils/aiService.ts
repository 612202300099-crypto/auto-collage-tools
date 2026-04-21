/**
 * aiService.ts — Hybrid AI Face Detection (Local & Premium OpenAI).
 * Memberikan fleksibilitas: Kecepatan Lokal vs Kecerdasan OpenAI.
 */
import * as faceapi from '@vladmandic/face-api';

export type AIEngine = 'local' | 'openai';

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

// ── AI MODEL INITIALIZATION (LOCAL) ────────────────────────────────────────
let isModelLoaded = false;

async function ensureModelsLoaded() {
  if (isModelLoaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
  isModelLoaded = true;
  console.log('[AI] Local Face Detection Models Loaded');
}

// ── CORE HYBRID LOGIC ──────────────────────────────────────────────────────

/**
 * detectFace: Mendeteksi wajah menggunakan mesin yang dipilih.
 */
export async function detectFace(file: File, engine: AIEngine = 'local'): Promise<FaceResult | null> {
  // 1. Unique Cache Key (Sertakan Engine agar User bisa 'Upgrade' hasil scan)
  const cacheKey = `${file.name}-${file.size}-${file.lastModified}-${engine}`;

  // 2. Cek Cache
  const cached = await getCachedFace(cacheKey);
  if (cached) {
    console.log(`[AI] Cache Hit for ${file.name} using ${engine}`);
    return cached;
  }

  try {
    if (engine === 'local') {
      return await detectLocal(file, cacheKey);
    } else {
      return await detectOpenAI(file, cacheKey);
    }
  } catch (err) {
    console.error(`[AI] Detection Error (${engine}):`, err);
    return null;
  }
}

/**
 * detectLocal: Deteksi cepat di browser.
 */
async function detectLocal(file: File, cacheKey: string): Promise<FaceResult | null> {
  await ensureModelsLoaded();
  const img = await faceapi.bufferToImage(file);
  const detections = await faceapi.detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));

  if (detections.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  detections.forEach(det => {
    const box = det.box;
    if (box.left < minX) minX = box.left;
    if (box.top < minY) minY = box.top;
    if (box.right > maxX) maxX = box.right;
    if (box.bottom > maxY) maxY = box.bottom;
  });

  const result: FaceResult = {
    xmin: Math.max(0, Math.round((minX / img.width) * 1000)),
    ymin: Math.max(0, Math.round((minY / img.height) * 1000)),
    xmax: Math.min(1000, Math.round((maxX / img.width) * 1000)),
    ymax: Math.min(1000, Math.round((maxY / img.height) * 1000))
  };

  await setCachedFace(cacheKey, result);
  return result;
}

/**
 * detectOpenAI: Deteksi pintar via GPT-4o-mini.
 * Mengompres gambar agar hemat bandwidth & tidak timeout.
 */
async function detectOpenAI(file: File, cacheKey: string): Promise<FaceResult | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const img = new Image();
      img.onload = async () => {
        // Optimize untuk OpenAI (512px cukup cerdas untuk GPT-4o-mini)
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 512;
        let w = img.width;
        let h = img.height;
        if (w > h && w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; }
        else if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; }
        
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, w, h);
        
        // Kompres tinggi agar upload kilat (di bawah 10 detik)
        const base64 = canvas.toDataURL('image/jpeg', 0.4);

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
          console.error('[AI] Premium API Failed:', err);
          resolve(null);
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}
