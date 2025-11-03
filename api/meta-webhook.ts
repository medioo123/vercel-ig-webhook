import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

// Wrap with timeout
async function lpushWithTimeout(key: string, value: string) {
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('KV lpush timed out after 3 seconds')), 3000)
  );
  
  const lpushPromise = kv.lpush(key, value);
  
  return Promise.race([lpushPromise, timeoutPromise]);
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
    console.log('📦 Payload:', JSON.stringify(req.body));
    
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

        console.log('📤 Push:', job.id);
        console.log('🔑 Has URL:', !!process.env.KV_REST_API_URL);
        console.log('🔑 Has Token:', !!process.env.KV_REST_API_TOKEN);
        
        const jobString = JSON.stringify(job);
        console.log('📝 Key:', 'instagram:mentions');
        console.log('📝 Value:', jobString);
        console.log('📝 Value length:', jobString.length);
        
        try {
          console.log('⏳ Calling kv.lpush...');
          const result = await lpushWithTimeout('instagram:mentions', jobString);
          console.log('✅ SUCCESS!', result);
        } catch (err: any) {
          console.error('❌ ERROR:', err.message);
        }
      }
    }
    
    console.log('🏁 Done');
    return;
  }

  return res.status(405).send('method not allowed');
}