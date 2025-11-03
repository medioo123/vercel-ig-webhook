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
    console.log('📦 META PAYLOAD:', JSON.stringify(req.body, null, 2));
    
    // ACK immediately
    res.status(200).json({ status: 'ok' });
    
    try {
      // Initialize Redis with retry DISABLED
      console.log('🔧 Creating Redis client...');
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
        retry: {
          retries: 0,
        },
      });
      console.log('✅ Redis client created');

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
          console.log('📦 Job data:', JSON.stringify(job));
          
          try {
            console.log('⏳ Calling lpush...');
            const result = await redis.lpush('instagram:mentions', JSON.stringify(job));
            console.log('✅ LPUSH SUCCESS! Result:', result);
          } catch (lpushErr: any) {
            console.error('❌ LPUSH ERROR:', lpushErr.message);
            console.error('Error details:', JSON.stringify(lpushErr, Object.getOwnPropertyNames(lpushErr)));
          }
        }
      }
      
      console.log('🏁 All done!');
    } catch (e: any) {
      console.error('❌ OUTER ERROR:', e.message);
      console.error('Error stack:', e.stack);
    }
    return;
  }

  return res.status(405).send('method not allowed');
}