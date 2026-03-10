// api/stripe-webhook.js — Vercel Serverless Function
// Sans dépendance npm stripe — vérification signature manuelle

export const config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Vérification HMAC-SHA256 de la signature Stripe
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) return false;
  
  const timestamp = tPart.substring(2);
  const expectedSig = v1Part.substring(3);
  const signedPayload = `${timestamp}.${payload}`;
  
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
  return computedSig === expectedSig;
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
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ user_id: userId, key, value })
    });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let buf, bodyStr;
  try {
    buf = await buffer(req);
    bodyStr = buf.toString('utf8');
  } catch (err) {
    return res.status(400).json({ error: 'Cannot read body' });
  }

  // Vérifier signature
  if (webhookSecret && sig) {
    const valid = await verifyStripeSignature(bodyStr, sig, webhookSecret);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(bodyStr); }
  catch (err) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const obj = event.data?.object;
  
  // Récupérer un abonnement Stripe via l'API REST
  async function getSubscription(subId) {
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY + ':').toString('base64') }
    });
    return r.json();
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const userId = obj.metadata?.user_id;
        if (userId) await updateSupabasePlan(userId, 'pro', 'active', obj.customer, obj.subscription);
        break;
      }
      case 'invoice.payment_succeeded': {
        if (!obj.subscription) break;
        const sub = await getSubscription(obj.subscription);
        const userId = sub.metadata?.user_id;
        if (userId) await updateSupabasePlan(userId, 'pro', 'active', obj.customer, obj.subscription);
        break;
      }
      case 'invoice.payment_failed': {
        if (!obj.subscription) break;
        const sub = await getSubscription(obj.subscription);
        const userId = sub.metadata?.user_id;
        if (userId) await updateSupabasePlan(userId, 'pro', 'past_due', obj.customer, obj.subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.user_id;
        if (userId) await updateSupabasePlan(userId, 'free', 'active', obj.customer, '');
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  return res.status(200).json({ received: true });
};
