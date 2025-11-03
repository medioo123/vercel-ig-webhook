import type { VercelRequest, VercelResponse } from '@vercel/node';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('🚀 WEBHOOK HIT:', { method: req.method, url: req.url });

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
    
    // ACK immediately
    res.status(200).json({ status: 'ok' });
    
    try {
      const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
      const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;

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
          
          try {
            // Correct Upstash REST API format: POST /lpush/key with body
            const response = await fetch(`${UPSTASH_URL}/lpush/instagram:mentions`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify([JSON.stringify(job)]),
            });

            if (!response.ok) {
              const text = await response.text();
              console.error('❌ Redis API error:', response.status, text);
              throw new Error(`Redis failed: ${response.status}`);
            }

            const result = await response.json();
            console.log('✅ SUCCESS! Queue length:', result.result);
          } catch (pushError: any) {
            console.error('❌ Push failed:', pushError.message);
          }
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