// api/track-open.js — Pixel tracking ouverture email
// VERSION DEBUG — logs détaillés pour diagnostiquer

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { id } = req.query;

  // LOG — visible dans Vercel Dashboard → Functions → Logs
  console.log(`[track-open] id=${id} ua=${(req.headers['user-agent']||'').slice(0,80)}`);

  if (!id || id === 'test-123') {
    return res.status(200).end(PIXEL);
  }

  if (!SB_URL || !SB_KEY) {
    console.error('[track-open] ❌ SUPABASE_URL ou SUPABASE_SERVICE_KEY manquant dans Vercel env!');
    return res.status(200).end(PIXEL);
  }

  try {
    const body = {
      offre_id: id,
      opened_at: new Date().toISOString(),
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
      user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null
    };

    console.log('[track-open] Insert:', JSON.stringify(body));

    const r = await fetch(`${SB_URL}/rest/v1/ouvertures`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    });

    if (r.ok || r.status === 201 || r.status === 204) {
      console.log(`[track-open] ✅ OK — offre ${id}`);
    } else {
      const txt = await r.text();
      console.error(`[track-open] ❌ Supabase ${r.status}: ${txt}`);
    }
  } catch (e) {
    console.error('[track-open] ❌ Exception:', e.message);
  }

  res.status(200).end(PIXEL);
};
