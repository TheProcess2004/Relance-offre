// api/stripe-checkout.js — FollowOffer
// Crée une session Stripe Checkout (fetch natif, sans SDK)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });

  const { userId, email, priceId, successUrl, cancelUrl } = req.body;

  if (!email || !priceId || !successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    // Construire les params en URLSearchParams (format Stripe API)
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    params.append('customer_email', email);
    params.append('allow_promotion_codes', 'true');
    params.append('billing_address_collection', 'required');
    if (userId) params.append('metadata[userId]', userId);
    // Locale FR
    params.append('locale', 'fr');

    const checkoutRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!checkoutRes.ok) {
      const errData = await checkoutRes.json();
      console.error('Stripe checkout error:', errData);
      return res.status(400).json({ error: errData.error?.message || 'Erreur Stripe' });
    }

    const session = await checkoutRes.json();
    return res.status(200).json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('stripe-checkout exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
