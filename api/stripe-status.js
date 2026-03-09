import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });

    if (customers.data.length === 0) {
      return res.json({ plan: 'free', status: 'none', active: false });
    }

    const customer = customers.data[0];
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      return res.json({ plan: 'free', status: 'none', active: false });
    }

    const sub = subscriptions.data[0];
    const priceId = sub.items.data[0]?.price?.id;
    const isPro = priceId === process.env.STRIPE_PRICE_PRO;
    const active = sub.status === 'active' || sub.status === 'trialing';

    res.json({
      plan: (isPro && active) ? 'pro' : 'free',
      status: sub.status,
      active,
      periodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      customerId: customer.id,
      subscriptionId: sub.id,
      priceId
    });
  } catch (err) {
    console.error('Stripe status error:', err);
    res.status(500).json({ error: err.message });
  }
}
