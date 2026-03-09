// api/stripe-status.js — FollowOffer
// Vérifie le plan Stripe d'un utilisateur via son email

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requis', plan: 'free', status: 'none' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY manquante');
    return res.status(200).json({ plan: 'free', status: 'none', active: false });
  }

  try {
    // Chercher le customer par email via l'API REST Stripe (sans SDK)
    const customersRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );

    if (!customersRes.ok) {
      const err = await customersRes.text();
      console.error('Stripe customers error:', err);
      return res.status(200).json({ plan: 'free', status: 'none', active: false });
    }

    const customers = await customersRes.json();

    if (!customers.data || customers.data.length === 0) {
      return res.status(200).json({ plan: 'free', status: 'none', active: false });
    }

    const customerId = customers.data[0].id;

    // Récupérer les subscriptions actives
    const subsRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=all&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );

    if (!subsRes.ok) {
      return res.status(200).json({ plan: 'free', status: 'none', active: false });
    }

    const subs = await subsRes.json();

    if (!subs.data || subs.data.length === 0) {
      return res.status(200).json({ plan: 'free', status: 'none', active: false });
    }

    const sub = subs.data[0];
    const priceId = sub.items?.data?.[0]?.price?.id;
    const isPro = priceId === process.env.STRIPE_PRICE_PRO;
    const active = sub.status === 'active' || sub.status === 'trialing';

    return res.status(200).json({
      plan: (isPro && active) ? 'pro' : 'free',
      status: sub.status,
      active,
      periodEnd: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
      customerId,
      subscriptionId: sub.id,
      priceId
    });

  } catch (err) {
    console.error('stripe-status exception:', err.message);
    // Fail silently — retourner free plutôt que crasher l'app
    return res.status(200).json({ plan: 'free', status: 'error', active: false });
  }
}
