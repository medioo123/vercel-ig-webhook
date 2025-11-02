import type { VercelRequest, VercelResponse } from '@vercel/node';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN!;
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN!;
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase(); // optional

async function graphGET<T = any>(path: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/v24.0/${path}`);
  url.searchParams.set('access_token', PAGE_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`Graph GET ${path} failed ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function graphPOST<T = any>(path: string, body: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/v24.0/${path}`);
  const form = new URLSearchParams({ access_token: PAGE_TOKEN, ...body });
  const r = await fetch(url.toString(), { method: 'POST', body: form });
  if (!r.ok) throw new Error(`Graph POST ${path} failed ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1) webhook verification
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      // must echo the challenge exactly
      return res.status(200).send(String(challenge));
    }
    return res.status(403).send('verification failed');
  }

  // 2) receive events
  if (req.method === 'POST') {
    try {
      const payload = req.body as any;
      // Always ACK quickly
      res.status(200).json({ status: 'ok' });

      // Process async (no await after res.send)
      const entries = payload?.entry ?? [];
      for (const entry of entries) {
        const changes = entry?.changes ?? [];
        for (const change of changes) {
          if (change.field !== 'mentions') continue;

          const value = change.value || {};
          const mediaId   = value.media_id as string | undefined;
          const commentId = value.comment_id as string | undefined;

          console.log('📩 mention event:', { mediaId, commentId });

          // Fetch media context (who posted, permalink)
          let media: any = null;
          if (mediaId) {
            try {
              media = await graphGET(mediaId, { fields: 'id,username,permalink,caption,media_type' });
            } catch (e) {
              console.warn('media fetch failed', e);
            }
          }

          // Fetch comment text (if it was a comment mention)
          let comment: any = null;
          if (commentId) {
            try {
              comment = await graphGET(commentId, { fields: 'id,text,username,timestamp' });
            } catch (e) {
              console.warn('comment fetch failed', e);
            }
          }

          console.log('🧠 context:', { media, comment });

          // OPTIONAL: auto-reply only if the mention happened on YOUR media
          // We do this by comparing the media.username to your IG handle.
          if (media?.username && IG_USERNAME && media.username.toLowerCase() === IG_USERNAME) {
            // reply under the same comment thread if a comment mention exists
            if (commentId) {
              try {
                await graphPOST(`${mediaId}/comments`, {
                  message: `Thanks for the mention, @${comment?.username || ''}! 🙌`,
                  parent_comment_id: commentId,
                });
                console.log('✅ replied to comment', commentId);
              } catch (e) {
                console.warn('reply failed', e);
              }
            }
          } else {
            // For mentions on other people’s posts: log or forward to Slack/DB
            console.log('ℹ️ mention not on our media; storing or notifying only.');
          }
        }
      }
    } catch (e: any) {
      console.error('webhook error:', e?.message || e);
      // We already responded 200 above to avoid retries
    }
    return;
  }

  return res.status(405).send('method not allowed');
}
