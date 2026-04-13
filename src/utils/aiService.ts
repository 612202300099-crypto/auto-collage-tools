/**
 * aiService.ts — Jembatan ke OpenAI Vision (GPT-4o-mini).
 *
 * Digunakan untuk mendeteksi koordinat wajah agar sistem bisa melakukan
 * "Smart Cropping" (mencegah wajah terpotong di kolase).
 */

const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
const API_URL = 'https://api.openai.com/v1/chat/completions';

export interface FaceBBox {
  ymin: number; // 0 - 1000
  xmin: number; // 0 - 1000
  ymax: number; // 0 - 1000
  xmax: number; // 0 - 1000
}

/**
 * Mendeteksi wajah menggunakan OpenAI Vision.
 * Menggunakan gpt-4o-mini untuk efisiensi biaya dan kecepatan.
 */
export async function detectFace(file: File): Promise<FaceBBox | null> {
  if (!OPENAI_API_KEY) {
    console.error('[AI] API Key tidak ditemukan di environment!');
    return null;
  }

  try {
    // 1. Perkecil gambar ke resolution rendah (misal 512px) 
    // agar hemat bandwidth & biaya API (token vision dihitung berdasarkan resolusi)
    const base64Image = await resizeAndConvertToBase64(file, 512);

    // 2. Kirim ke OpenAI
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Respond ONLY with a valid JSON. Detect ALL human faces in this image and return a single bounding box that encompasses ALL of them in normalized coordinates [0-1000]. Format: {\"face\": [ymin, xmin, ymax, xmax]}. If no face, return {\"face\": null}. This is for smart cropping, so the box should cover the entire group."
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: 100,
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Gagal memanggil OpenAI API');
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);

    if (result.face && Array.isArray(result.face)) {
      const [ymin, xmin, ymax, xmax] = result.face;
      return { ymin, xmin, ymax, xmax };
    }

    return null;
  } catch (error) {
    console.warn('[AI] Deteksi wajah gagal, menggunakan center-crop sebagai fallback:', error);
    return null;
  }
}

/**
 * Helper: Perkecil gambar & ubah ke Base64 JPEG.
 */
async function resizeAndConvertToBase64(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxDim) {
            height *= maxDim / width;
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width *= maxDim / height;
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        
        // JPEG 0.7 quality sudah cukup untuk deteksi wajah
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        resolve(dataUrl.split(',')[1]);
      };
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
  });
}
