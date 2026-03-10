// api/generate.js — FollowOffer · Proxy Claude API

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY manquant' });

  try {
    const body = req.body || {};
    
    // Log pour debug
    console.log('[generate] messages count:', body.messages?.length);
    console.log('[generate] has document:', body.messages?.[0]?.content?.some?.(c => c.type === 'document'));

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1024,
        messages: body.messages || [],
        ...(body.system ? { system: body.system } : {})
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('[generate] Claude error:', data);
      return res.status(r.status).json({ error: data.error?.message || 'Erreur Claude' });
    }
    return res.status(200).json(data);
  } catch(e) {
    console.error('[generate] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

handler.config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

module.exports = handler;
