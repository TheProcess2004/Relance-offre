// api/stripe-webhook.js — FollowOffer
// Webhook Stripe → met à jour Supabase quand un paiement est confirmé

const crypto = require('crypto');

// Nécessaire pour lire le raw body (vérification signature Stripe)
module.exports.config = { api: { bodyParser: false } };

// Lire le body brut
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Vérifier la signature Stripe (HMAC SHA256)
function verifyStripeSignature(payload, header, secret) {
  if (!header) return false;
  const parts = header.split(',');
  let timestamp = '';
  const sigs = [];
  for (const part of parts) {
    const [k, v] = part.trim().split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1') sigs.push(v);
  }
  if (!timestamp || sigs.length === 0) return false;
  // Tolérance 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    console.warn('Webhook timestamp trop ancien');
    return false;
  }
  const signed = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return sigs.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch { return false; }
  });
}

// Mettre à jour Supabase
async function updateSupabase(userId, data) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Supabase env vars manquantes');
    return false;
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/settings`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ user_id: userId, ...data })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase update error:', err);
    return false;
  }
  return true;
}

// Récupérer user_id depuis l'email dans Supabase Auth
async function getUserIdByEmail(email) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0]?.id || null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET manquant');
    return res.status(500).json({ error: 'Webhook secret non configuré' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Impossible de lire le body' });
  }

  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody.toString(), sig, webhookSecret)) {
    console.error('Signature Stripe invalide');
    return res.status(400).json({ error: 'Signature invalide' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  console.log('Webhook reçu:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_email || session.customer_details?.email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (!email) {
          console.error('Pas d\'email dans la session checkout');
          break;
        }

        const userId = await getUserIdByEmail(email);
        if (!userId) {
          console.error('User non trouvé pour email:', email);
          break;
        }

        await updateSupabase(userId, {
          plan: 'pro',
          plan_status: 'active',
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_price_id: process.env.STRIPE_PRICE_PRO,
          updated_at: new Date().toISOString()
        });
        console.log('✅ Plan Pro activé pour', email);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const active = sub.status === 'active' || sub.status === 'trialing';
        const priceId = sub.items?.data?.[0]?.price?.id;
        const isPro = priceId === process.env.STRIPE_PRICE_PRO;

        // Trouver l'email via Stripe
        const custRes = await fetch(
          `https://api.stripe.com/v1/customers/${customerId}`,
          { headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
        );
        if (!custRes.ok) break;
        const cust = await custRes.json();
        const email = cust.email;
        const userId = await getUserIdByEmail(email);
        if (!userId) break;

        await updateSupabase(userId, {
          plan: (isPro && active) ? 'pro' : 'free',
          plan_status: sub.status,
          stripe_subscription_id: sub.id,
          updated_at: new Date().toISOString()
        });
        console.log('✅ Subscription updated pour', email, '→', sub.status);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        const custRes = await fetch(
          `https://api.stripe.com/v1/customers/${customerId}`,
          { headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
        );
        if (!custRes.ok) break;
        const cust = await custRes.json();
        const userId = await getUserIdByEmail(cust.email);
        if (!userId) break;

        await updateSupabase(userId, {
          plan: 'free',
          plan_status: 'cancelled',
          updated_at: new Date().toISOString()
        });
        console.log('✅ Plan annulé pour', cust.email);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const custRes = await fetch(
          `https://api.stripe.com/v1/customers/${customerId}`,
          { headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
        );
        if (!custRes.ok) break;
        const cust = await custRes.json();
        const userId = await getUserIdByEmail(cust.email);
        if (!userId) break;

        await updateSupabase(userId, {
          plan_status: 'payment_failed',
          updated_at: new Date().toISOString()
        });
        console.log('⚠️ Paiement échoué pour', cust.email);
        break;
      }

      default:
        console.log('Événement ignoré:', event.type);
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
};
