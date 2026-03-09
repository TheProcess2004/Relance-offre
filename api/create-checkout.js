// api/create-checkout.js — Vercel Serverless Function
// Variables d'environnement nécessaires dans Vercel :
// STRIPE_SECRET_KEY, STRIPE_PRICE_PRO

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { plan, user_email, user_id, success_url, cancel_url } = req.body;
    if (!user_email || !user_id) return res.status(400).json({ error: 'Missing user info' });

    const priceId = process.env.STRIPE_PRICE_PRO; // price_1T8zjmRyIs2PnCFKyHAWuQey

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user_email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id, plan: plan || 'pro' },
      success_url: (success_url || 'https://followoffer.com') + '?payment=success',
      cancel_url:  (cancel_url  || 'https://followoffer.com') + '?payment=cancel',
      locale: 'fr',
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { user_id, plan: plan || 'pro' }
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({ error: err.message });
  }
};
