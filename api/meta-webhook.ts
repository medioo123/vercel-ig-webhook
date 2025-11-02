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
  // Allow preflight if Meta ever sends it
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1) VERIFY (GET)
  if (req.method === 'GET') {
    const mode      = first(req.query['hub.mode']);
    const token     = first(req.query['hub.verify_token']);
    const challenge = first(req.query['hub.challenge']);

    if (mode === 'subscribe' && token && challenge && token === VERIFY_TOKEN) {
      return res.status(200).send(String(challenge));
    }
    console.warn('Verification failed', {
      mode, tokenProvidedLen: token?.length ?? 0,
      haveEnv: Boolean(VERIFY_TOKEN), envLen: VERIFY_TOKEN.length,
    });
    return res.status(403).send('verification failed');
  }

  // 2) EVENTS (POST)
  if (req.method === 'POST') {
    try {
      // log loudly so you can see Meta’s Test payloads
      console.log('🛈 headers:', JSON.stringify(req.headers));
      console.log('🛈 body:', JSON.stringify(req.body));

      // ACK quickly to avoid retries
      res.status(200).json({ status: 'ok' });

      const payload = req.body as any;
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          if (change.field !== 'mentions') continue;

          const mediaId   = change.value?.media_id as string | undefined;
          const commentId = change.value?.comment_id as string | undefined;
          console.log('📩 mention event:', { mediaId, commentId });

          // Context
          let media: any = null;
          if (mediaId) {
            try {
              media = await graphGET(mediaId, { fields: 'id,username,permalink,caption,media_type' });
            } catch (e) { console.warn('media fetch failed', e); }
          }

          let comment: any = null;
          if (commentId) {
            try {
              comment = await graphGET(commentId, { fields: 'id,text,username,timestamp' });
            } catch (e) { console.warn('comment fetch failed', e); }
          }

          console.log('🧠 context:', { media, comment });

          // Auto-reply ONLY if the media is yours
          if (media?.username && IG_USERNAME && media.username.toLowerCase() === IG_USERNAME && commentId) {
            try {
              await graphPOST(`${mediaId}/comments`, {
                message: `Thanks for the mention, @${comment?.username || ''}! 🙌`,
                parent_comment_id: commentId,
              });
              console.log('✅ replied to comment', commentId);
            } catch (e) { console.warn('reply failed', e); }
          } else {
            console.log('ℹ️ mention not on our media; logging only.');
          }
        }
      }
    } catch (e: any) {
      console.error('webhook error:', e?.message || e);
      // already responded 200
    }
    return;
  }

  return res.status(405).send('method not allowed');
}
