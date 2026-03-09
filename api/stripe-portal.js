import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, returnUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'Aucun abonnement trouvé' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: returnUrl || process.env.APP_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err);
    res.status(500).json({ error: err.message });
  }
}
