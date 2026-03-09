// api/stripe-webhook.js — FollowOffer
const crypto = require('crypto');

module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  const signed = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return sigs.some(sig => {
    try { return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); }
    catch { return false; }
  });
}

// Met à jour plan + plan_status sur TOUTES les lignes de l'user dans settings
// (table clé/valeur avec plusieurs lignes par user_id)
async function setPlanInSupabase(userId, plan, planStatus, extraData = {}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) { console.error('Supabase env vars manquantes'); return false; }

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates'
  };

  // 1. Mettre à jour plan + plan_status sur toutes les lignes existantes de cet user
  const updateRes = await fetch(
    `${supabaseUrl}/rest/v1/settings?user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ plan, plan_status: planStatus, ...extraData })
    }
  );
  if (!updateRes.ok) {
    console.error('Supabase PATCH error:', await updateRes.text());
    return false;
  }

  // 2. Si aucune ligne n'existe encore (nouveau user), en créer une
  const checkRes = await fetch(
    `${supabaseUrl}/rest/v1/settings?user_id=eq.${userId}&limit=1`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  );
  const rows = await checkRes.json();
  if (!rows || rows.length === 0) {
    await fetch(`${supabaseUrl}/rest/v1/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: userId, key: 'plan', value: plan, plan, plan_status: planStatus })
    });
  }

  console.log(`✅ Supabase updated: user ${userId} → plan=${plan}, status=${planStatus}`);
  return true;
}

async function getUserIdByEmail(email) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  try {
    const res = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}&per_page=1`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    if (!res.ok) { console.error('getUserIdByEmail error:', await res.text()); return null; }
    const data = await res.json();
    return data.users?.[0]?.id || null;
  } catch(e) { console.error('getUserIdByEmail exception:', e.message); return null; }
}

async function getCustomerEmail(customerId) {
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}`,
    { headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  );
  if (!res.ok) return null;
  const cust = await res.json();
  return cust.email || null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET manquant' });

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch(e) { return res.status(400).json({ error: 'Impossible de lire le body' }); }

  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody.toString(), sig, webhookSecret)) {
    console.error('Signature invalide');
    return res.status(400).json({ error: 'Signature invalide' });
  }

  let event;
  try { event = JSON.parse(rawBody.toString()); }
  catch(e) { return res.status(400).json({ error: 'JSON invalide' }); }

  console.log('Webhook:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_email || session.customer_details?.email;
        if (!email) { console.error('Pas d\'email dans session'); break; }
        const userId = await getUserIdByEmail(email);
        if (!userId) { console.error('User non trouvé:', email); break; }
        await setPlanInSupabase(userId, 'pro', 'active', {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          stripe_price_id: process.env.STRIPE_PRICE_PRO
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const active = sub.status === 'active' || sub.status === 'trialing';
        const isPro = sub.items?.data?.[0]?.price?.id === process.env.STRIPE_PRICE_PRO;
        const email = await getCustomerEmail(sub.customer);
        if (!email) break;
        const userId = await getUserIdByEmail(email);
        if (!userId) break;
        await setPlanInSupabase(userId, (isPro && active) ? 'pro' : 'free', sub.status);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const email = await getCustomerEmail(sub.customer);
        if (!email) break;
        const userId = await getUserIdByEmail(email);
        if (!userId) break;
        await setPlanInSupabase(userId, 'free', 'cancelled');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const email = await getCustomerEmail(invoice.customer);
        if (!email) break;
        const userId = await getUserIdByEmail(email);
        if (!userId) break;
        await setPlanInSupabase(userId, 'pro', 'payment_failed');
        break;
      }

      default:
        console.log('Événement ignoré:', event.type);
    }
  } catch(err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ received: true });
};
