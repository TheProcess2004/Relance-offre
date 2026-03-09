// api/stripe-webhook.js — FollowOffer
// Reçoit les webhooks Stripe et met à jour Supabase (fetch natif, sans SDK)



async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, header, secret) {
  const parts = header.split(',');
  let timestamp = '';
  const sigs = [];
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1') sigs.push(v);
  }
  const signed = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return sigs.some(sig => crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')));
}

async function sbUpdate(userId, data) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Supabase env vars manquantes');
    return false;
  }

  // PATCH d'abord (si la ligne existe)
  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/settings?user_id=eq.${userId}&key=eq.stripe_plan`,
    {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(data)
    }
  );

  if (patchRes.status === 204) return true;

  // Sinon upsert multiple colonnes via RPC ou INSERT direct
  // On stocke chaque champ séparément dans la table settings
  const keys = [
    ['stripe_plan', data.plan || 'free'],
    ['stripe_status', data.status || 'none'],
    ['stripe_customer_id', data.customerId || ''],
    ['stripe_subscription_id', data.subscriptionId || ''],
    ['stripe_period_end', data.periodEnd || ''],
  ];

  for (const [key, value] of keys) {
    await fetch(`${supabaseUrl}/rest/v1/settings`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ user_id: userId, key, value })
    });
  }
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET manquant');
    return res.status(500).json({ error: 'Webhook secret manquant' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Impossible de lire le body' });
  }

  // Vérifier la signature
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

  console.log(`Webhook reçu: ${event.type}`);

  const obj = event.data?.object;
  const userId = obj?.metadata?.userId || obj?.client_reference_id;

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const customerId = obj.customer;
        const subscriptionId = obj.subscription;
        if (userId) {
          await sbUpdate(userId, {
            plan: 'pro',
            status: 'active',
            customerId,
            subscriptionId,
            periodEnd: ''
          });
          console.log(`✅ Pro activé pour user ${userId}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const active = ['active', 'trialing'].includes(obj.status);
        const priceId = obj.items?.data?.[0]?.price?.id;
        const isPro = priceId === process.env.STRIPE_PRICE_PRO;
        const custId = obj.customer;

        // Retrouver le userId via le customerId si pas dans metadata
        let uid = userId;
        if (!uid && custId) {
          // On met à jour par customerId dans settings
          const supabaseUrl = process.env.SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (supabaseUrl && serviceKey) {
            const findRes = await fetch(
              `${supabaseUrl}/rest/v1/settings?key=eq.stripe_customer_id&value=eq.${custId}&select=user_id`,
              { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
            );
            const rows = await findRes.json();
            uid = rows?.[0]?.user_id;
          }
        }

        if (uid) {
          await sbUpdate(uid, {
            plan: (isPro && active) ? 'pro' : 'free',
            status: obj.status,
            customerId: custId,
            subscriptionId: obj.id,
            periodEnd: obj.current_period_end
              ? new Date(obj.current_period_end * 1000).toISOString()
              : ''
          });
          console.log(`✅ Subscription updated pour user ${uid}: ${obj.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const custId = obj.customer;
        // Retrouver user
        let uid = userId;
        if (!uid && custId) {
          const supabaseUrl = process.env.SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (supabaseUrl && serviceKey) {
            const findRes = await fetch(
              `${supabaseUrl}/rest/v1/settings?key=eq.stripe_customer_id&value=eq.${custId}&select=user_id`,
              { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
            );
            const rows = await findRes.json();
            uid = rows?.[0]?.user_id;
          }
        }
        if (uid) {
          await sbUpdate(uid, { plan: 'free', status: 'canceled', customerId: custId, subscriptionId: obj.id, periodEnd: '' });
          console.log(`✅ Subscription annulée pour user ${uid}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        console.log(`⚠️ Paiement échoué pour customer ${obj.customer}`);
        break;
      }

      default:
        console.log(`Événement ignoré: ${event.type}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  return res.status(200).json({ received: true });
}

module.exports.config = { api: { bodyParser: false } };
