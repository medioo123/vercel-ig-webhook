import type { VercelRequest, VercelResponse } from '@vercel/node';

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
        
        try {
          // Use pure fetch - no SDK
          const upstashUrl = process.env.UPSTASH_REDIS_REST_URL!;
          const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN!;
          
          console.log('🌐 Calling Upstash REST API...');
          
          // Upstash REST API: POST https://xxx.upstash.io/lpush/key
          // Body: JSON array of values to push
          const response = await fetch(`${upstashUrl}/lpush/instagram:mentions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${upstashToken}`,
            },
            body: JSON.stringify([JSON.stringify(job)]),
          });
          
          console.log('📡 Response status:', response.status);
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ API Error:', errorText);
            throw new Error(`Upstash failed: ${response.status}`);
          }
          
          const result = await response.json();
          console.log('✅ SUCCESS! Result:', result);
        } catch (err: any) {
          console.error('❌ Error:', err.message);
          console.error('Stack:', err.stack);
        }
      }
    }
    
    console.log('🏁 Done!');
    return;
  }

  return res.status(405).send('method not allowed');
}