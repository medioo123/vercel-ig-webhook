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
    
    // LOG THE FULL PAYLOAD FROM META
    console.log('📦 Full Meta payload:', JSON.stringify(req.body, null, 2));
    
    // ACK immediately
    res.status(200).json({ status: 'ok' });
    
    try {
      // Initialize Redis INSIDE handler (same as local test)
      console.log('🔧 Initializing Redis client...');
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      });
      console.log('✅ Redis client created');

      const payload = req.body as any;
      
      for (const entry of payload?.entry ?? []) {
        console.log('📝 Processing entry:', entry);
        
        for (const change of entry?.changes ?? []) {
          console.log('🔔 Processing change:', change);
          
          if (change.field !== 'mentions') {
            console.log('⏭️  Skipping field:', change.field);
            continue;
          }

          const mediaId = change.value?.media_id;
          const commentId = change.value?.comment_id;
          
          console.log('📊 Extracted IDs:', { mediaId, commentId });
          
          if (!mediaId || !commentId) {
            console.log('⚠️  Missing IDs, skipping');
            continue;
          }

          const job = {
            id: `${commentId}_${Date.now()}`,
            mediaId,
            commentId,
            username: IG_USERNAME,
            status: 'pending',
            createdAt: new Date().toISOString(),
          };

          console.log('📤 About to push job:', JSON.stringify(job));
          
          try {
            // Use EXACT same method as local test
            console.log('⏳ Calling redis.lpush...');
            await redis.lpush('instagram:mentions', JSON.stringify(job));
            console.log('✅ SUCCESSFULLY PUSHED TO REDIS!');
          } catch (redisError: any) {
            console.error('❌ Redis push error:', redisError);
            console.error('Error message:', redisError?.message);
            console.error('Error stack:', redisError?.stack);
          }
        }
      }
      
      console.log('🏁 All processing complete!');
    } catch (e: any) {
      console.error('❌ Outer error:', e);
      console.error('Error message:', e?.message);
      console.error('Error stack:', e?.stack);
    }
    return;
  }

  return res.status(405).send('method not allowed');
}