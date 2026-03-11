// api/stripe-webhook.js
// Reçoit les events Stripe et met à jour le plan dans Supabase

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

async function getSubscription(subId) {
  const r = await fetch('https://api.stripe.com/v1/subscriptions/' + subId, {
    headers: { 'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET + ':').toString('base64') }
  });
  return r.json();
}

// settings = key/value store → upsert chaque clé séparément
async function upsertSetting(user_id, key, value) {
  const r = await fetch(`${SB_URL}/rest/v1/settings?user_id=eq.${user_id}&key=eq.${key}`, {
    method: 'GET',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  });
  const existing = await r.json();

  if (existing && existing.length > 0) {
    await fetch(`${SB_URL}/rest/v1/settings?user_id=eq.${user_id}&key=eq.${key}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ value: String(value) })
    });
  } else {
    await fetch(`${SB_URL}/rest/v1/settings`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ user_id, key, value: String(value) })
    });
  }
}

async function updateUserPlan(user_id, plan, stripe_customer_id, stripe_subscription_id, status) {
  if (!user_id) { console.error('updateUserPlan: missing user_id'); return; }
  const updates = {
    plan,
    plan_status: status,
    stripe_customer_id: stripe_customer_id || '',
    stripe_subscription_id: stripe_subscription_id || '',
    plan_updated_at: new Date().toISOString()
  };
  for (const [key, value] of Object.entries(updates)) {
    await upsertSetting(user_id, key, value);
  }
  console.log(`✅ Plan mis à jour: user=${user_id} plan=${plan} status=${status}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    if (webhookSecret && sig) {
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
      console.warn('[webhook] ⚠️ Signature non vérifiée');
    }
  } catch (e) {
    console.error('[webhook] Erreur parsing:', e.message);
    return res.status(400).json({ error: 'Webhook error' });
  }

  console.log('[webhook] Event:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const user_id = session.metadata?.user_id;
        const plan = session.metadata?.plan || 'pro';
        if (user_id) {
          await updateUserPlan(user_id, plan, session.customer, session.subscription, 'active');
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub = await getSubscription(invoice.subscription);
        const user_id = sub.metadata?.user_id;
        const plan = sub.metadata?.plan || 'pro';
        if (user_id) {
          await updateUserPlan(user_id, plan, invoice.customer, invoice.subscription, 'active');
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub = await getSubscription(invoice.subscription);
        const user_id = sub.metadata?.user_id;
        if (user_id) {
          await updateUserPlan(user_id, 'pro', invoice.customer, invoice.subscription, 'past_due');
        }
        break;
      }

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
