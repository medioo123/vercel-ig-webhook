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
  
  // Upstash REST API: POST to /lpush/{key} with JSON body
  const url = `${UPSTASH_URL}/lpush/instagram:mentions`;
  
  console.log('🌐 Calling Upstash API:', url);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
    },
    body: JSON.stringify([JSON.stringify(job)]), // Array of values to push
  });
  
  console.log('📡 Response status:', response.status);
  
  if (!response.ok) {
    const text = await response.text();
    console.error('❌ Response error:', text);
    throw new Error(`Upstash API failed: ${response.status} - ${text}`);
  }
  
  const result = await response.json();
  console.log('✅ Upstash response:', result);
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
      console.log('✅ Verification success');
      return res.status(200).send(String(challenge));
    }
    return res.status(403).send('verification failed');
  }

  // EVENTS (POST)
  if (req.method === 'POST') {
    console.log('📨 POST event received');
    console.log('📦 Payload:', JSON.stringify(req.body, null, 2));
    
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

          console.log('📤 Pushing job:', job.id);
          
          await pushToRedis(job);
          
          console.log('✅ Job pushed successfully!');
        }
      }
      
      console.log('🏁 Complete!');
    } catch (e: any) {
      console.error('❌ Error:', e.message, e.stack);
    }
    return;
  }

  return res.status(405).send('method not allowed');
}