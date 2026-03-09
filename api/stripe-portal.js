// api/stripe-portal.js — FollowOffer
// Crée une session du portail client Stripe (fetch natif, sans SDK)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe non configuré' });

  const { email, returnUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    // 1. Trouver le customer
    const customersRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const customers = await customersRes.json();

    if (!customers.data?.length) {
      return res.status(404).json({ error: 'Aucun abonnement trouvé pour cet email' });
    }

    const customerId = customers.data[0].id;

    // 2. Créer la session portail
    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', returnUrl || 'https://relance-offre.vercel.app');

    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!portalRes.ok) {
      const errData = await portalRes.json();
      console.error('Stripe portal error:', errData);
      return res.status(400).json({ error: errData.error?.message || 'Erreur portail Stripe' });
    }

    const session = await portalRes.json();
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('stripe-portal exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
