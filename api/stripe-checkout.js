import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, email, priceId, successUrl, cancelUrl } = req.body;

  if (!userId || !email || !priceId) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    // Cherche ou crée le customer Stripe
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${process.env.APP_URL}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.APP_URL}?stripe=cancel`,
      metadata: { supabase_user_id: userId },
      subscription_data: {
        metadata: { supabase_user_id: userId }
      },
      // Options Suisse
      currency: 'chf',
      locale: 'fr',
      billing_address_collection: 'auto',
      tax_id_collection: { enabled: true }, // Pour TVA entreprises
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
