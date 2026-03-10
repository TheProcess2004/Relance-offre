// api/create-checkout.js — Vercel Serverless Function
// Utilise l'API Stripe REST directement (pas de dépendance npm)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { plan, user_email, user_id, success_url, cancel_url } = req.body;
    if (!user_email || !user_id) return res.status(400).json({ error: 'Missing user info' });

    const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
    const PRICE_ID = process.env.STRIPE_PRICE_PRO;

    if (!STRIPE_SECRET || !PRICE_ID) {
      return res.status(500).json({ error: 'Stripe non configuré — contactez contact@aubrymr.ch' });
    }

    // Appel API Stripe REST direct (pas de require)
    const params = new URLSearchParams({
      mode: 'subscription',
      'payment_method_types[]': 'card',
      customer_email: user_email,
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user_id,
      'metadata[plan]': plan || 'pro',
      'subscription_data[metadata][user_id]': user_id,
      success_url: (success_url || 'https://followoffer.com') + '?payment=success',
      cancel_url: cancel_url || 'https://followoffer.com',
      locale: 'fr',
      allow_promotion_codes: 'true',
    });

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await response.json();

    if (!response.ok || !session.url) {
      console.error('Stripe error:', session);
      return res.status(500).json({ error: session.error?.message || 'Erreur Stripe' });
    }

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: err.message });
  }
};
