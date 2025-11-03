import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();

// Initialize Redis with extra logging
console.log('🔧 Initializing Redis with URL:', process.env.UPSTASH_REDIS_REST_URL ? 'present' : 'MISSING');
console.log('🔧 Redis token:', process.env.UPSTASH_REDIS_REST_TOKEN ? 'present' : 'MISSING');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ===== LOG EVERY REQUEST FIRST =====
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🚀 WEBHOOK HIT:', {
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString(),
  });
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));
  console.log('═══════════════════════════════════════════════════════════');

  // Allow preflight if Meta ever sends it
  if (req.method === 'OPTIONS') {
    console.log('✅ Responding to OPTIONS');
    return res.status(200).end();
  }

  // 1) VERIFY (GET)
  if (req.method === 'GET') {
    console.log('🔍 Processing GET verification request');
    
    const mode      = first(req.query['hub.mode']);
    const token     = first(req.query['hub.verify_token']);
    const challenge = first(req.query['hub.challenge']);

    console.log('🔐 Verification details:', {
      mode,
      tokenMatch: token === VERIFY_TOKEN,
      hasChallenge: Boolean(challenge),
    });

    if (mode === 'subscribe' && token && challenge && token === VERIFY_TOKEN) {
      console.log('✅ Verification SUCCESS - sending challenge:', challenge);
      return res.status(200).send(String(challenge));
    }
    
    console.warn('❌ Verification FAILED');
    return res.status(403).send('verification failed');
  }

  // 2) EVENTS (POST)
  if (req.method === 'POST') {
    console.log('📨 Processing POST webhook event');
    
    try {
      // ACK quickly to avoid retries
      res.status(200).json({ status: 'ok' });
      console.log('✅ Sent 200 OK response to Meta');

      const payload = req.body as any;
      
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          if (change.field !== 'mentions') {
            console.log(`⏭️  Skipping non-mention field: ${change.field}`);
            continue;
          }

          const mediaId   = change.value?.media_id as string | undefined;
          const commentId = change.value?.comment_id as string | undefined;
          
          if (!mediaId || !commentId) {
            console.log('⚠️  Missing mediaId or commentId, skipping');
            continue;
          }

          console.log('📩 Mention event:', { mediaId, commentId });

          try {
            // Create job with minimal data - agent will fetch everything
            const job = {
              id: `${commentId}_${Date.now()}`,
              mediaId,
              commentId,
              username: IG_USERNAME,
              status: 'pending',
              createdAt: new Date().toISOString(),
            };

            console.log('📤 Pushing to Redis queue:', job.id);
            console.log('📦 Job data:', JSON.stringify(job));
            
            // Push to list (queue)
            const result = await redis.lpush('instagram:mentions', JSON.stringify(job));
            
            console.log('✅ Successfully pushed to Redis queue!');
            console.log('✅ Redis returned:', result);
          } catch (redisError: any) { 
            console.error('❌ Redis push failed with error:', redisError);
            console.error('❌ Error message:', redisError?.message);
            console.error('❌ Error stack:', redisError?.stack);
            console.error('❌ Full error:', JSON.stringify(redisError, null, 2));
          }
        }
      }
      
      console.log('🏁 Finished processing all entries');
    } catch (e: any) {
      console.error('❌ Webhook error:', e?.message || e);
      console.error('❌ Stack:', e?.stack);
      console.error('❌ Full error:', JSON.stringify(e, null, 2));
    }
    return;
  }

  console.log('❌ Method not allowed:', req.method);
  return res.status(405).send('method not allowed');
}