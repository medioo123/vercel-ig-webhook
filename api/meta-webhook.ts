import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
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
    console.log('📨 POST event received');
    
    // ACK immediately
    res.status(200).json({ status: 'ok' });
    
    try {
      // Initialize Redis with retry DISABLED (fixes hanging issue in Vercel)
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
        retry: {
          retries: 0, // Disable retries
        },
      });

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
          
          await redis.lpush('instagram:mentions', JSON.stringify(job));
          
          console.log('✅ Success!');
        }
      }
      
      console.log('🏁 Done!');
    } catch (e: any) {
      console.error('❌ Error:', e.message, e.stack);
    }
    return;
  }

  return res.status(405).send('method not allowed');
}