import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Missing image' });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { 
              type: "text", 
              text: "You are a professional photographer's assistant. Detect all human faces in this image and return the bounding box coordinates (xmin, ymin, xmax, ymax) on a scale of 0-1000. If multiple faces, return a box that covers ALL faces. Return ONLY JSON format: {\"xmin\": 0, \"ymin\": 0, \"xmax\": 0, \"ymax\": 0}. If no face, return null." 
            },
            {
              type: "image_url",
              image_url: { url: image, detail: "low" },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 100,
    });

    const content = response.choices[0].message.content;
    const result = content ? JSON.parse(content) : null;

    return res.status(200).json(result);
  } catch (error: any) {
    console.error('AI Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
