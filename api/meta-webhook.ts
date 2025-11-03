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
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🚀 WEBHOOK HIT:', { method: req.method, url: req.url });
  
  // Check env vars
  console.log('🔍 Env check:', {
    hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
    hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    redisUrlLength: process.env.UPSTASH_REDIS_REST_URL?.length || 0,
    redisTokenLength: process.env.UPSTASH_REDIS_REST_TOKEN?.length || 0,
  });

  if (req.method === 'OPTIONS') return res.status(200).end();

  // VERIFY (GET)
  if (req.method === 'GET') {
    const mode = first(req.query['hub.mode']);
    const token = first(req.query['hub.verify_token']);
    const challenge = first(req.query['hub.challenge']);

    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      console.log('✅ Verification SUCCESS');
      return res.status(200).send(String(challenge));
    }
    console.log('❌ Verification FAILED');
    return res.status(403).send('verification failed');
  }

  // EVENTS (POST)
  if (req.method === 'POST') {
    console.log('📨 POST event received');
    console.log('📦 Body:', JSON.stringify(req.body));
    
    // ACK immediately
    res.status(200).json({ status: 'ok' });
    console.log('✅ Sent 200 OK to Meta');
    
    try {
      // Initialize Redis HERE (inside the handler)
      console.log('🔧 Creating Redis client...');
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      });
      console.log('✅ Redis client created');

      const payload = req.body as any;
      
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          if (change.field !== 'mentions') {
            console.log('⏭️  Skipping field:', change.field);
            continue;
          }

          const mediaId = change.value?.media_id;
          const commentId = change.value?.comment_id;
          
          if (!mediaId || !commentId) {
            console.log('⚠️  Missing IDs');
            continue;
          }

          console.log('📩 Processing mention:', { mediaId, commentId });

          const job = {
            id: `${commentId}_${Date.now()}`,
            mediaId,
            commentId,
            username: IG_USERNAME,
            status: 'pending',
            createdAt: new Date().toISOString(),
          };

          const jobString = JSON.stringify(job);
          console.log('📤 About to push:', jobString);
          
          try {
            console.log('⏳ Calling redis.lpush...');
            const result = await redis.lpush('instagram:mentions', jobString);
            console.log('✅ LPUSH SUCCESS! Result:', result);
          } catch (lpushError: any) {
            console.error('❌ LPUSH FAILED!');
            console.error('Error name:', lpushError?.name);
            console.error('Error message:', lpushError?.message);
            console.error('Error cause:', lpushError?.cause);
            console.error('Full error:', JSON.stringify(lpushError, Object.getOwnPropertyNames(lpushError)));
            throw lpushError;
          }
        }
      }
      
      console.log('🏁 All done!');
    } catch (e: any) {
      console.error('❌ OUTER ERROR CAUGHT!');
      console.error('Error type:', typeof e);
      console.error('Error name:', e?.name);
      console.error('Error message:', e?.message);
      console.error('Error stack:', e?.stack);
      console.error('Error cause:', e?.cause);
      console.error('Full error object:', JSON.stringify(e, Object.getOwnPropertyNames(e)));
    }
    return;
  }

  console.log('❌ Method not allowed');
  return res.status(405).send('method not allowed');
}