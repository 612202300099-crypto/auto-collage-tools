/**
 * api/detect-face.ts
 *
 * Vercel Serverless Function — Proxy aman ke OpenAI Vision API.
 *
 * KEAMANAN:
 *   - OPENAI_API_KEY hanya dibaca dari server-side environment (tidak pernah masuk ke bundle browser).
 *   - Rate limiting per IP untuk mencegah penyalahgunaan endpoint.
 *   - Validasi ketat pada input (ukuran, format, tipe konten).
 *   - Hanya metode POST yang diizinkan.
 *   - Respons error tidak pernah mengekspos detail internal sistem.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ─── Konstanta & Konfigurasi ──────────────────────────────────────────────────

/** Batas ukuran body request: 4 MB (cukup untuk gambar 512px JPEG) */
const MAX_BODY_SIZE_BYTES = 4 * 1024 * 1024;

/** Ukuran maksimum string base64 yang diterima (~3 MB payload gambar) */
const MAX_BASE64_LENGTH = 3 * 1024 * 1024;

/** Rate limiting sederhana (in-memory). Di production dengan traffic tinggi, ganti Redis. */
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 30;       // maks 30 request
const RATE_LIMIT_WINDOW_MS = 60_000; // per 60 detik per IP

// ─── Tipe ─────────────────────────────────────────────────────────────────────

interface DetectFaceRequestBody {
  /** Gambar yang telah di-resize, dikodekan ke Base64 JPEG (tanpa prefix data URI) */
  imageBase64: string;
}

interface FaceBBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

interface DetectFaceSuccessResponse {
  face: FaceBBox | null;
}

interface DetectFaceErrorResponse {
  error: string;
}

// ─── Utilitas ─────────────────────────────────────────────────────────────────

/**
 * Mengambil IP nyata klien, mendukung header proxy standar Vercel.
 */
function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Rate limiter in-memory.
 * Mengembalikan true jika klien masih dalam batas, false jika sudah melebihi.
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count += 1;
  return true;
}

/**
 * Memvalidasi string base64 (hanya karakter base64 yang valid).
 */
function isValidBase64(str: string): boolean {
  if (str.length === 0 || str.length > MAX_BASE64_LENGTH) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(str);
}

// ─── Handler Utama ────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {

  // 1. Hanya izinkan metode POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 2. Rate limiting
  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 3. Pastikan API Key tersedia (akan crash dengan pesan jelas di logs Vercel, bukan ke user)
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[detect-face] FATAL: OPENAI_API_KEY environment variable is not set.');
    res.status(503).json({ error: 'AI service is temporarily unavailable.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 4. Validasi Content-Type
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    res.status(415).json({ error: 'Content-Type must be application/json.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 5. Parse & validasi body request
  const body = req.body as Partial<DetectFaceRequestBody>;

  if (!body || typeof body.imageBase64 !== 'string') {
    res.status(400).json({ error: 'Missing required field: imageBase64.' } satisfies DetectFaceErrorResponse);
    return;
  }

  if (!isValidBase64(body.imageBase64)) {
    res.status(400).json({ error: 'Invalid imageBase64: must be a valid Base64-encoded JPEG string under 3 MB.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 6. Panggil OpenAI Vision API dari sisi server
  try {
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API Key HANYA ada di sini, di sisi server. Tidak pernah keluar ke browser.
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Respond ONLY with a valid JSON. Detect ALL human faces in this image and return a single bounding box encompassing ALL of them in normalized coordinates [0-1000]. Format: {"face": [ymin, xmin, ymax, xmax]}. If no face found, return {"face": null}. Purpose: smart cropping to ensure no face is cut off.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${body.imageBase64}`,
                  // "low" = hemat token, cukup untuk deteksi posisi wajah
                  detail: 'low',
                },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 100,
        temperature: 0, // Deterministic: tidak butuh kreativitas untuk tugas ini
      }),
    });

    // 7. Handle error dari OpenAI
    if (!openAiResponse.ok) {
      const errorData = await openAiResponse.json() as { error?: { message?: string } };
      // Log detail error di server (bisa dilihat di Vercel Logs), TIDAK dikembalikan ke user
      console.error('[detect-face] OpenAI API error:', errorData);
      res.status(502).json({ error: 'Failed to process image. Please try again.' } satisfies DetectFaceErrorResponse);
      return;
    }

    // 8. Parse & validasi respons OpenAI
    const openAiData = await openAiResponse.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawContent = openAiData?.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new Error('OpenAI returned an empty response.');
    }

    const parsed = JSON.parse(rawContent) as { face?: unknown };

    // 9. Susun respons yang bersih untuk client
    let faceBBox: FaceBBox | null = null;

    if (Array.isArray(parsed.face) && parsed.face.length === 4) {
      const [ymin, xmin, ymax, xmax] = parsed.face as number[];
      // Validasi bahwa nilai ada dalam rentang yang sah [0..1000]
      const isValidCoord = [ymin, xmin, ymax, xmax].every(
        (v) => typeof v === 'number' && v >= 0 && v <= 1000
      );
      if (isValidCoord) {
        faceBBox = { ymin, xmin, ymax, xmax };
      }
    }

    const successResponse: DetectFaceSuccessResponse = { face: faceBBox };
    res.status(200).json(successResponse);

  } catch (err) {
    // Tangkap semua error tak terduga, log di server, sembunyikan dari user
    console.error('[detect-face] Unexpected error:', err);
    res.status(500).json({ error: 'An internal error occurred. Please try again.' } satisfies DetectFaceErrorResponse);
  }
}

// Konfigurasi Vercel: matikan body parser bawaan agar kita bisa kontrol sendiri
// Catatan: Kita tetap menggunakan body parser bawaan Vercel (json) untuk kemudahan,
// tapi bisa diubah ke false jika ingin parsing manual untuk streaming.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb', // Batasi ukuran request ke 4 MB
    },
  },
};
