// api/stripe-webhook.js — Vercel Serverless Function
// Variables d'environnement nécessaires :
// STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Désactiver le bodyParser pour Stripe (nécessaire pour la vérification de signature)
export const config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function updateSupabasePlan(userId, plan, status, customerId, subscriptionId) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  const fields = [
    { key: 'plan', value: plan },
    { key: 'plan_status', value: status },
    { key: 'stripe_customer_id', value: customerId || '' },
    { key: 'stripe_subscription_id', value: subscriptionId || '' },
  ];

  for (const { key, value } of fields) {
    await fetch(`${SB_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ user_id: userId, key, value })
    });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const obj = event.data.object;

  try {
    switch (event.type) {

      // Paiement réussi → activer Pro
      case 'checkout.session.completed': {
        const userId = obj.metadata?.user_id;
        if (!userId) break;
        await updateSupabasePlan(userId, 'pro', 'active', obj.customer, obj.subscription);
        console.log(`✅ Pro activé pour user ${userId}`);
        break;
      }

      // Renouvellement réussi → maintenir Pro
      case 'invoice.payment_succeeded': {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const userId = sub.metadata?.user_id;
        if (!userId) break;
        await updateSupabasePlan(userId, 'pro', 'active', obj.customer, obj.subscription);
        break;
      }

      // Paiement échoué → passer en past_due
      case 'invoice.payment_failed': {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const userId = sub.metadata?.user_id;
        if (!userId) break;
        await updateSupabasePlan(userId, 'pro', 'past_due', obj.customer, obj.subscription);
        console.log(`⚠️ Paiement échoué pour user ${userId}`);
        break;
      }

      // Abonnement annulé → repasser en gratuit
      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.user_id;
        if (!userId) break;
        await updateSupabasePlan(userId, 'free', 'active', obj.customer, '');
        console.log(`🔻 Abonnement annulé pour user ${userId}`);
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  return res.status(200).json({ received: true });
};
