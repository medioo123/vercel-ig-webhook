// api/instagram-webhook.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const IG_USERNAME  = (process.env.IG_USERNAME || '').toLowerCase();
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || ''; // optional but recommended

function first(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function isMetaVerify(req: VercelRequest) {
  return req.query['hub.mode'] !== undefined ||
         req.query['hub.verify_token'] !== undefined ||
         req.query['hub.challenge'] !== undefined;
}

function ok(res: VercelResponse, body: any, status = 200) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(status).send(JSON.stringify(body, null, 2));
}

function unauthorized(res: VercelResponse) {
  return ok(res, { error: 'unauthorized' }, 401);
}

async function handleDebugGet(req: VercelRequest, res: VercelResponse) {
  const admin = first(req.query.admin) || '';
  if (ADMIN_TOKEN && admin !== ADMIN_TOKEN) {
    return unauthorized(res);
  }

  const op = (first(req.query.op) || 'peek').toLowerCase();
  const n  = Math.max(1, Math.min(200, parseInt(first(req.query.n) || '10', 10) || 10));
  const key = 'instagram:mentions';

  try {
    if (op === 'peek') {
      const items = await kv.lrange<string>(key, 0, n - 1);
      return ok(res, {
        op,
        key,
        count: items.length,
        items: items.map((x) => { try { return JSON.parse(x); } catch { return x; } }),
      });
    }

    if (op === 'pop') {
      const out: any[] = [];
      for (let i = 0; i < n; i++) {
        // Pop from head to consume newest first (LPUSH adds to head)
        // If you prefer oldest first, use RPOP instead.
        // @ts-ignore - vercel/kv has lpop
        const v = await (kv as any).lpop<string>(key);
        if (!v) break;
        try { out.push(JSON.parse(v)); } catch { out.push(v); }
      }
      return ok(res, { op, key, popped: out.length, items: out });
    }

    if (op === 'purge') {
      // delete whole list
      await kv.del(key);
      return ok(res, { op, key, result: 'deleted' });
    }

    if (op === 'stats') {
      const url =
        process.env.KV_REST_API_URL ||
        process.env.UPSTASH_REDIS_REST_URL ||
        'n/a';
      const hasToken =
        !!process.env.KV_REST_API_TOKEN || !!process.env.UPSTASH_REDIS_REST_TOKEN;

      // @ts-ignore - vercel/kv has llen
      const len = await (kv as any).llen(key).catch(async () => {
        const all = await kv.lrange<string>(key, 0, -1);
        return all.length;
      });

      // sanity writes to prove DB matches what you see in console
      const c = await kv.incr('debug:counter');
      await kv.set('debug:ts', Date.now().toString());

      return ok(res, {
        op,
        key,
        listLength: len,
        usingUrlPrefix: url.slice(0, 60),
        hasToken,
        debugCounter: c,
        note: 'Match usingUrlPrefix with the DB URL you open in Upstash.',
      });
    }

    return ok(res, { error: `unknown op "${op}"` }, 400);
  } catch (e: any) {
    return ok(res, { error: e?.message || String(e) }, 500);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('🚀 WEBHOOK HIT:', { method: req.method });

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    return res.status(200).end();
  }

  // GET: Meta verification OR debug ops
  if (req.method === 'GET') {
    if (isMetaVerify(req)) {
      const mode = first(req.query['hub.mode']);
      const token = first(req.query['hub.verify_token']);
      const challenge = first(req.query['hub.challenge']);
      if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
        console.log('✅ Verification success');
        // Return raw challenge string, not JSON
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(String(challenge));
      }
      return res.status(403).send('verification failed');
    }

    // our single-file debug surface
    return handleDebugGet(req, res);
  }

  // POST: process webhook
  if (req.method === 'POST') {
    console.log('📨 POST event received');
    console.log('📦 META PAYLOAD:', JSON.stringify(req.body, null, 2));

    try {
      const payload = req.body as any;
      let pushes = 0;

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
          const result = await kv.lpush('instagram:mentions', JSON.stringify(job));
          pushes += 1;
          console.log('✅ SUCCESS! Queue length:', result);
        }
      }

      console.log('🏁 Done - now sending response');
      return ok(res, { status: 'ok', pushes });

    } catch (e: any) {
      console.error('❌ KV write error:', e?.message);
      // Still 200 so Meta doesn't disable webhook, but include note
      return ok(res, { status: 'ok', note: 'kv error (see logs)', error: e?.message });
    }
  }

  return res.status(405).send('method not allowed');
}
