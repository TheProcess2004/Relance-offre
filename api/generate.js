export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) {
    console.error('[generate] ANTHROPIC_KEY manquante');
    return res.status(500).json({ error: 'Configuration manquante: ANTHROPIC_KEY non définie sur Vercel' });
  }

  try {
    const body = req.body;
    
    // Forcer le bon modèle (alias stable)
    const model = body.model || 'claude-sonnet-4-5-20251022';

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: body.max_tokens || 1000,
        messages: body.messages,
        ...(body.system ? { system: body.system } : {}),
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error('[generate] Anthropic error:', anthropicRes.status, JSON.stringify(data));
      return res.status(anthropicRes.status).json({ 
        error: data.error?.message || `Erreur Anthropic ${anthropicRes.status}`,
        detail: data 
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('[generate] Exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
