// api/stripe-webhook.js
// Reçoit les events Stripe et met à jour le plan dans Supabase

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

// Récupérer une subscription Stripe via REST (pas de require)
async function getSubscription(subId) {
  const r = await fetch('https://api.stripe.com/v1/subscriptions/' + subId, {
    headers: { 'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET + ':').toString('base64') }
  });
  return r.json();
}

async function updateUserPlan(user_id, plan, stripe_customer_id, stripe_subscription_id, status) {
  const body = {
    plan: plan,
    stripe_customer_id: stripe_customer_id,
    stripe_subscription_id: stripe_subscription_id,
    plan_status: status, // 'active' | 'canceled' | 'past_due'
    plan_updated_at: new Date().toISOString()
  };

  // Upsert dans settings
  const r = await fetch(`${SB_URL}/rest/v1/settings?user_id=eq.${user_id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const txt = await r.text();
    console.error('Supabase update error:', r.status, txt);
    // Si aucune row à patcher (settings pas encore créé), on insère
    await fetch(`${SB_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ user_id, ...body })
    });
  }
  console.log(`✅ Plan mis à jour: user=${user_id} plan=${plan} status=${status}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // Récupérer le raw body pour la vérification signature
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    if (webhookSecret && sig) {
      // Vérification signature HMAC manuelle
      const crypto = require('crypto');
      const parts = sig.split(',').reduce((acc, p) => {
        const [k, v] = p.split('='); acc[k] = v; return acc;
      }, {});
      const timestamp = parts['t'];
      const expected = crypto.createHmac('sha256', webhookSecret)
        .update(timestamp + '.' + rawBody.toString())
        .digest('hex');
      if (expected !== parts['v1']) {
        return res.status(400).json({ error: 'Signature invalide' });
      }
      event = JSON.parse(rawBody.toString());
    } else {
      event = JSON.parse(rawBody.toString());
      console.warn('[webhook] ⚠️ Signature non vérifiée — configurez STRIPE_WEBHOOK_SECRET');
    }
  } catch (e) {
    console.error('[webhook] Signature invalide:', e.message);
    return res.status(400).json({ error: 'Webhook signature invalide' });
  }

  console.log('[webhook] Event:', event.type);

  try {
    switch (event.type) {

      // ── Paiement réussi → activer le plan ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const user_id = session.metadata?.user_id;
        const plan = session.metadata?.plan;
        if (user_id && plan) {
          await updateUserPlan(user_id, plan, session.customer, session.subscription, 'active');
        }
        break;
      }

      // ── Renouvellement mensuel réussi ──
      case 'invoice.paid': {
        const invoice = event.data.object;
        const sub = await getSubscription(invoice.subscription);
        const user_id = sub.metadata?.user_id;
        const plan = sub.metadata?.plan;
        if (user_id && plan) {
          await updateUserPlan(user_id, plan, invoice.customer, invoice.subscription, 'active');
        }
        break;
      }

      // ── Paiement échoué ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const sub = await getSubscription(invoice.subscription);
        const user_id = sub.metadata?.user_id;
        if (user_id) {
          await updateUserPlan(user_id, 'pro', invoice.customer, invoice.subscription, 'past_due');
        }
        break;
      }

      // ── Annulation ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user_id = sub.metadata?.user_id;
        if (user_id) {
          await updateUserPlan(user_id, 'free', sub.customer, sub.id, 'canceled');
        }
        break;
      }

      default:
        console.log('[webhook] Event ignoré:', event.type);
    }
  } catch (e) {
    console.error('[webhook] Erreur traitement:', e.message);
    return res.status(500).json({ error: e.message });
  }

  res.status(200).json({ received: true });
};
