/**
 * api/detect-face.ts
 *
 * Vercel Serverless Function — Proxy aman ke OpenAI Vision API.
 *
 * KEAMANAN:
 *   - OPENAI_API_KEY hanya dibaca dari server-side environment.
 *     Tidak pernah masuk ke bundle browser, tidak terlihat di DevTools manapun.
 *   - Validasi ketat pada input (ukuran, format, tipe konten).
 *   - Hanya metode POST yang diizinkan.
 *   - Respons error tidak mengekspos detail internal sistem.
 *
 * CATATAN BIAYA:
 *   Pasang Usage Limit di https://platform.openai.com/account/limits
 *   sebagai pengaman biaya, bukan di kode ini.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ─── Konstanta ────────────────────────────────────────────────────────────────

/** Ukuran maksimum string base64 yang diterima (~3 MB payload gambar) */
const MAX_BASE64_LENGTH = 3 * 1024 * 1024;

// ─── Tipe ────────────────────────────────────────────────────────────────────

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
 * Memvalidasi string base64 (hanya karakter base64 yang valid, dalam batas ukuran).
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

  // 2. Pastikan API Key tersedia di environment server
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[detect-face] FATAL: OPENAI_API_KEY environment variable is not set.');
    res.status(503).json({ error: 'AI service is temporarily unavailable.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 3. Validasi Content-Type
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    res.status(415).json({ error: 'Content-Type must be application/json.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 4. Parse & validasi body request
  const body = req.body as Partial<DetectFaceRequestBody>;

  if (!body || typeof body.imageBase64 !== 'string') {
    res.status(400).json({ error: 'Missing required field: imageBase64.' } satisfies DetectFaceErrorResponse);
    return;
  }

  if (!isValidBase64(body.imageBase64)) {
    res.status(400).json({ error: 'Invalid imageBase64: must be a valid Base64-encoded JPEG string under 3 MB.' } satisfies DetectFaceErrorResponse);
    return;
  }

  // 5. Panggil OpenAI Vision API dari sisi server
  try {
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API Key HANYA ada di sini — di sisi server Vercel, tidak pernah ke browser.
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
                  detail: 'low', // hemat token, cukup untuk deteksi posisi wajah
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

    // 6. Handle error dari OpenAI
    if (!openAiResponse.ok) {
      const errorData = await openAiResponse.json() as { error?: { message?: string } };
      // Log detail error di server (Vercel Logs), TIDAK dikembalikan ke user
      console.error('[detect-face] OpenAI API error:', errorData);
      res.status(502).json({ error: 'Failed to process image. Please try again.' } satisfies DetectFaceErrorResponse);
      return;
    }

    // 7. Parse & validasi respons OpenAI
    const openAiData = await openAiResponse.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawContent = openAiData?.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new Error('OpenAI returned an empty response.');
    }

    const parsed = JSON.parse(rawContent) as { face?: unknown };

    // 8. Susun respons yang bersih untuk client
    let faceBBox: FaceBBox | null = null;

    if (Array.isArray(parsed.face) && parsed.face.length === 4) {
      const [ymin, xmin, ymax, xmax] = parsed.face as number[];
      // Validasi bahwa semua nilai ada dalam rentang yang sah [0..1000]
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
    // Tangkap semua error tak terduga — log di server, sembunyikan dari user
    console.error('[detect-face] Unexpected error:', err);
    res.status(500).json({ error: 'An internal error occurred. Please try again.' } satisfies DetectFaceErrorResponse);
  }
}

// Konfigurasi Vercel: batasi ukuran request body ke 4 MB
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};
