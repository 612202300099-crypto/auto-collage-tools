import { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'Image is required' });
  }

  try {
    // 1. Kirim ke OpenAI GPT-4o-mini (Visi yang sangat cerdas & terjangkau)
    // Gunakan prompt yang sangat spesifik agar outputnya hanya JSON
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: "Return the bounding box of the main face in this image as JSON: { \"xmin\": number, \"ymin\": number, \"xmax\": number, \"ymax\": number }. Scale: 0-1000. Only return the JSON object." 
            },
            {
              type: "image_url",
              image_url: {
                url: image, // Base64 data:image/jpeg;base64,...
                detail: "low" // Gunakan low detail agar super cepat & hemat token/biaya
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 100,
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error('No response from AI');

    const result = JSON.parse(content);

    // 2. Return ke Client
    return res.status(200).json({
      xmin: result.xmin ?? 0,
      ymin: result.ymin ?? 0,
      xmax: result.xmax ?? 1000,
      ymax: result.ymax ?? 1000
    });

  } catch (err: any) {
    console.error('OpenAI Detection Error:', err);
    return res.status(500).json({ 
      error: 'AI Detection failed', 
      details: err.message 
    });
  }
}
