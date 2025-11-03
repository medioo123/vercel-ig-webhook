import type { VercelRequest, VercelResponse } from '@vercel/node';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

async function pushToRedis(job: any): Promise<void> {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;
  
  const url = `${UPSTASH_URL}/lpush/instagram:mentions`;
  
  console.log('🌐 Calling Upstash API:', url);
  console.log('🔑 Token length:', UPSTASH_TOKEN.length);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      },
      body: JSON.stringify([JSON.stringify(job)]),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    console.log('📡 Response status:', response.status);
    
    if (!response.ok) {
      const text = await response.text();
      console.error('❌ Response error:', text);
      throw new Error(`Upstash API failed: ${response.status} - ${text}`);
    }
    
    const result = await response.json();
    console.log('✅ Upstash response:', result);
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      console.error('❌ Request timed out after 5 seconds');
      throw new Error('Upstash request timeout');
    }
    
    console.error('❌ Fetch error:', error.message);
    throw error;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('🚀 WEBHOOK HIT:', { method: req.method });

  if (req.method === 'OPTIONS') return res.status(200).end();

  // VERIFY (GET)
  if (req.method === 'GET') {
    const mode = first(req.query['hub.mode']);
    const token = first(req.query['hub.verify_token']);
    const challenge = first(req.query['hub.challenge']);

    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return res.status(200).send(String(challenge));
    }
    return res.status(403).send('verification failed');
  }

  // EVENTS (POST)
  if (req.method === 'POST') {
    console.log('📨 POST event');
    
    // ACK immediately
    res.status(200).json({ status: 'ok' });
    
    try {
      const payload = req.body as any;
      
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          if (change.field !== 'mentions') continue;

          const mediaId = change.value?.media_id;
          const commentId = change.value?.comment_id;
          
          if (!mediaId || !commentId) continue;

          const job = {
            id: `${commentId}_${Date.now()}`,
            mediaId,
            commentId,
            username: IG_USERNAME,
            status: 'pending',
            createdAt: new Date().toISOString(),
          };

          console.log('📤 Pushing:', job.id);
          
          await pushToRedis(job);
          
          console.log('✅ Success!');
        }
      }
      
      console.log('🏁 Done!');
    } catch (e: any) {
      console.error('❌ Error:', e.message);
    }
    return;
  }

  return res.status(405).send('method not allowed');
}