import type { VercelRequest, VercelResponse } from '@vercel/node';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

async function graphGET<T = any>(path: string, params: Record<string, string> = {}) {
  if (!PAGE_TOKEN) throw new Error('PAGE_ACCESS_TOKEN missing');
  const url = new URL(`https://graph.facebook.com/v24.0/${path}`);
  url.searchParams.set('access_token', PAGE_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`Graph GET ${path} failed ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function graphPOST<T = any>(path: string, body: Record<string, string>) {
  if (!PAGE_TOKEN) throw new Error('PAGE_ACCESS_TOKEN missing');
  const url = new URL(`https://graph.facebook.com/v24.0/${path}`);
  const form = new URLSearchParams({ access_token: PAGE_TOKEN, ...body });
  const r = await fetch(url.toString(), { method: 'POST', body: form });
  if (!r.ok) throw new Error(`Graph POST ${path} failed ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ===== LOG EVERY REQUEST FIRST =====
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🚀 WEBHOOK HIT:', {
    method: req.method,
    url: req.url,
    timestamp: new Date().toISOString(),
  });
  console.log('📋 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('📦 Query:', JSON.stringify(req.query, null, 2));
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
      tokenLength: token?.length || 0,
      expectedTokenLength: VERIFY_TOKEN.length,
    });

    if (mode === 'subscribe' && token && challenge && token === VERIFY_TOKEN) {
      console.log('✅ Verification SUCCESS - sending challenge:', challenge);
      return res.status(200).send(String(challenge));
    }
    
    console.warn('❌ Verification FAILED', {
      mode, 
      tokenProvidedLen: token?.length ?? 0,
      haveEnv: Boolean(VERIFY_TOKEN), 
      envLen: VERIFY_TOKEN.length,
    });
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
      
      console.log('🔍 Payload structure:', {
        hasEntry: Boolean(payload?.entry),
        entryCount: payload?.entry?.length || 0,
        object: payload?.object,
      });

      for (const entry of payload?.entry ?? []) {
        console.log('📝 Processing entry:', {
          id: entry?.id,
          changesCount: entry?.changes?.length || 0,
        });
        
        for (const change of entry?.changes ?? []) {
          console.log('🔔 Change detected:', {
            field: change.field,
            value: change.value,
          });
          
          if (change.field !== 'mentions') {
            console.log(`⏭️  Skipping non-mention field: ${change.field}`);
            continue;
          }

          const mediaId   = change.value?.media_id as string | undefined;
          const commentId = change.value?.comment_id as string | undefined;
          console.log('📩 Mention event:', { mediaId, commentId });

          // Context
          let media: any = null;
          if (mediaId) {
            try {
              console.log('🔍 Fetching media details...');
              media = await graphGET(mediaId, { fields: 'id,username,permalink,caption,media_type' });
              console.log('✅ Media fetched:', media);
            } catch (e) { 
              console.warn('❌ Media fetch failed:', e); 
            }
          }

          let comment: any = null;
          if (commentId) {
            try {
              console.log('🔍 Fetching comment details...');
              comment = await graphGET(commentId, { fields: 'id,text,username,timestamp' });
              console.log('✅ Comment fetched:', comment);
            } catch (e) { 
              console.warn('❌ Comment fetch failed:', e); 
            }
          }

          console.log('🧠 Full context:', { media, comment });

          // Auto-reply ONLY if the media is yours
          const isOurMedia = media?.username && IG_USERNAME && media.username.toLowerCase() === IG_USERNAME;
          console.log('🎯 Reply check:', {
            mediaUsername: media?.username,
            ourUsername: IG_USERNAME,
            isMatch: isOurMedia,
            hasCommentId: Boolean(commentId),
          });

          if (isOurMedia && commentId) {
            try {
              console.log('💬 Attempting to reply...');
              await graphPOST(`${mediaId}/comments`, {
                message: `Thanks for the mention, @${comment?.username || ''}! 🙌`,
                parent_comment_id: commentId,
              });
              console.log('✅ Successfully replied to comment', commentId);
            } catch (e) { 
              console.warn('❌ Reply failed:', e); 
            }
          } else {
            console.log('ℹ️  Mention not on our media; logging only.');
          }
        }
      }
    } catch (e: any) {
      console.error('❌ Webhook error:', e?.message || e);
      console.error('Stack:', e?.stack);
      // already responded 200
    }
    return;
  }

  console.log('❌ Method not allowed:', req.method);
  return res.status(405).send('method not allowed');
}