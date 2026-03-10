// api/index.js — FollowOffer · Router unique (Vercel Hobby = max 12 functions)
// Toutes les routes dans un seul fichier serverless

const config = { api: { bodyParser: false } };
module.exports.config = config;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Route: /api/send-email ────────────────────────────────────────────────────
async function handleSendEmail(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const buf = await readBody(req);
  const { provider, from, fromName, to, toName, subject, body, pdfUrl, pdfName } = JSON.parse(buf.toString());

  if (provider !== 'brevo') return json(res, 400, { error: 'Provider non supporté' });

  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) return json(res, 500, { error: 'BREVO_API_KEY manquant' });
  if (!to || !from || !subject) return json(res, 400, { error: 'Paramètres manquants' });

  const payload = {
    sender: { name: fromName || from, email: from },
    to: [{ email: to, name: toName || to }],
    subject,
    textContent: body,
    htmlContent: body
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
  };

  if (pdfUrl && pdfName) {
    try {
      const pdfRes = await fetch(pdfUrl);
      if (pdfRes.ok) {
        const pdfBuf = await pdfRes.arrayBuffer();
        payload.attachment = [{ name: pdfName, content: Buffer.from(pdfBuf).toString('base64') }];
      }
    } catch (e) { console.warn('PDF attach failed:', e.message); }
  }

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return json(res, r.status, { error: data.message || 'Erreur Brevo' });
    return json(res, 200, { success: true, messageId: data.messageId });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ── Route: /api/reset-password ────────────────────────────────────────────────
async function handleResetPassword(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const buf = await readBody(req);
  const { email } = JSON.parse(buf.toString());

  if (!email || !/\S+@\S+\.\S+/.test(email)) return json(res, 400, { error: 'Email invalide' });

  const BREVO_KEY = process.env.BREVO_API_KEY;
  const SB_URL = process.env.SUPABASE_URL || 'https://eripvzfinfevuebccyzu.supabase.co';
  const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const APP_URL = process.env.APP_URL || 'https://followoffer.com';

  if (!BREVO_KEY) return json(res, 500, { error: 'BREVO_API_KEY manquant' });
  if (!SB_SERVICE_KEY) return json(res, 500, { error: 'SUPABASE_SERVICE_KEY manquant' });

  try {
    const linkRes = await fetch(`${SB_URL}/auth/v1/admin/users/generate_link`, {
      method: 'POST',
      headers: {
        'apikey': SB_SERVICE_KEY,
        'Authorization': `Bearer ${SB_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: 'recovery', email, redirect_to: APP_URL })
    });

    if (!linkRes.ok) return json(res, 200, { success: true }); // sécurité : ne pas révéler

    const { action_link } = await linkRes.json();
    if (!action_link) return json(res, 200, { success: true });

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f5f7;margin:0;padding:0;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
    <div style="background:#07080C;padding:28px 32px;text-align:center;">
      <div style="font-family:Georgia,serif;font-size:22px;color:#fff;font-weight:bold;">Follow<span style="color:#7AAEE8;">Offer</span></div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.35);margin-top:4px;">Suite commerciale · Suisse</div>
    </div>
    <div style="padding:36px 32px;">
      <h1 style="font-size:20px;font-weight:700;color:#0F1728;margin:0 0 12px;">Réinitialisation du mot de passe</h1>
      <p style="font-size:14px;color:#4B5563;line-height:1.6;margin:0 0 24px;">Vous avez demandé à réinitialiser votre mot de passe FollowOffer.<br>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${action_link}" style="display:inline-block;background:#1555A8;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:700;">Réinitialiser mon mot de passe →</a>
      </div>
      <p style="font-size:12px;color:#9CA3AF;text-align:center;margin:0;">Ce lien est valable 1 heure. Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
    </div>
    <div style="background:#F8F9FB;padding:16px 32px;text-align:center;border-top:1px solid #E5E7EB;">
      <p style="font-size:11px;color:#9CA3AF;margin:0;">FollowOffer · <a href="mailto:contact@followoffer.com" style="color:#1555A8;text-decoration:none;">contact@followoffer.com</a></p>
    </div>
  </div>
</body></html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'FollowOffer', email: 'contact@followoffer.com' },
        to: [{ email }],
        subject: 'Réinitialisation de votre mot de passe FollowOffer',
        htmlContent: html,
        textContent: `Réinitialisez votre mot de passe FollowOffer :\n${action_link}\n\nCe lien est valable 1 heure.`
      })
    });

    if (!brevoRes.ok) {
      const err = await brevoRes.json().catch(() => ({}));
      console.error('Brevo reset error:', err);
      return json(res, 500, { error: 'Erreur envoi email' });
    }

    return json(res, 200, { success: true });
  } catch (e) {
    console.error('reset-password error:', e.message);
    return json(res, 500, { error: e.message });
  }
}

// ── Route: /api/generate ──────────────────────────────────────────────────────
async function handleGenerate(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const buf = await readBody(req);
  const body = JSON.parse(buf.toString());

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) return json(res, 500, { error: 'CLAUDE_API_KEY manquant' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1024,
        messages: body.messages || [],
        system: body.system
      })
    });
    const data = await r.json();
    if (!r.ok) return json(res, r.status, { error: data.error?.message || 'Erreur Claude' });
    return json(res, 200, data);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ── Route: /api/stripe-checkout ───────────────────────────────────────────────
async function handleStripeCheckout(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(res, 500, { error: 'Stripe non configuré' });

  const buf = await readBody(req);
  const { userId, email, priceId, successUrl, cancelUrl } = JSON.parse(buf.toString());

  if (!email || !priceId || !successUrl || !cancelUrl)
    return json(res, 400, { error: 'Paramètres manquants' });

  try {
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    params.append('customer_email', email);
    params.append('allow_promotion_codes', 'true');
    params.append('billing_address_collection', 'required');
    params.append('locale', 'fr');
    if (userId) params.append('metadata[userId]', userId);

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!r.ok) {
      const err = await r.json();
      return json(res, 400, { error: err.error?.message || 'Erreur Stripe' });
    }

    const session = await r.json();
    return json(res, 200, { url: session.url, sessionId: session.id });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ── Route: /api/stripe-portal ─────────────────────────────────────────────────
async function handleStripePortal(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(res, 500, { error: 'Stripe non configuré' });

  const buf = await readBody(req);
  const { email, returnUrl } = JSON.parse(buf.toString());
  if (!email) return json(res, 400, { error: 'Email requis' });

  try {
    const cRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const customers = await cRes.json();
    if (!customers.data?.length)
      return json(res, 404, { error: 'Aucun abonnement trouvé' });

    const customerId = customers.data[0].id;
    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', returnUrl || 'https://followoffer.com');

    const pRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!pRes.ok) {
      const err = await pRes.json();
      return json(res, 400, { error: err.error?.message || 'Erreur portail Stripe' });
    }

    const session = await pRes.json();
    return json(res, 200, { url: session.url });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

// ── Route: /api/stripe-status ─────────────────────────────────────────────────
async function handleStripeStatus(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const email = req.query?.email || new URL(req.url, 'http://x').searchParams.get('email');
  if (!email) return json(res, 400, { error: 'Email requis' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(res, 200, { plan: 'free', status: 'none', active: false });

  try {
    const cRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const customers = await cRes.json();
    if (!customers.data?.length) return json(res, 200, { plan: 'free', status: 'none', active: false });

    const customerId = customers.data[0].id;
    const sRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=all&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    );
    const subs = await sRes.json();
    if (!subs.data?.length) return json(res, 200, { plan: 'free', status: 'none', active: false });

    const sub = subs.data[0];
    const priceId = sub.items?.data[0]?.price?.id;
    const expectedPrice = process.env.STRIPE_PRICE_PRO;
    const isPro = priceId === expectedPrice;
    const active = sub.status === 'active' || sub.status === 'trialing';

    return json(res, 200, {
      plan: (isPro && active) ? 'pro' : 'free',
      status: sub.status,
      active,
      periodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      customerId,
      subscriptionId: sub.id,
      priceId
    });
  } catch (e) {
    return json(res, 200, { plan: 'free', status: 'none', active: false, _error: e.message });
  }
}

// ── Route: /api/stripe-webhook ────────────────────────────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) return false;
  const timestamp = tPart.substring(2);
  const expectedSig = v1Part.substring(3);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const computedSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
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

async function handleStripeWebhook(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const buf = await readBody(req);
  const bodyStr = buf.toString('utf8');

  if (webhookSecret && sig) {
    const valid = await verifyStripeSignature(bodyStr, sig, webhookSecret);
    if (!valid) return json(res, 400, { error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(bodyStr); }
  catch (e) { return json(res, 400, { error: 'Invalid JSON' }); }

  const obj = event.data?.object;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  async function getSub(subId) {
    const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(stripeKey + ':').toString('base64') }
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
        const sub = await getSub(obj.subscription);
        const userId = sub.metadata?.user_id;
        if (userId) await updateSupabasePlan(userId, 'pro', 'active', obj.customer, obj.subscription);
        break;
      }
      case 'invoice.payment_failed': {
        if (!obj.subscription) break;
        const sub = await getSub(obj.subscription);
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
  } catch (e) {
    console.error('Webhook handler error:', e);
  }

  return json(res, 200, { received: true });
}


// ── Route: /api/track-open ────────────────────────────────────────────────────
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function handleTrackOpen(req, res) {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');

  console.log(`[track-open] id=${id} ua=${(req.headers['user-agent']||'').slice(0,80)}`);

  if (!id || id === 'test-123') return res.status(200).end(PIXEL);

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SB_URL || !SB_KEY) {
    console.error('[track-open] ❌ SUPABASE_URL ou SUPABASE_SERVICE_KEY manquant');
    return res.status(200).end(PIXEL);
  }

  try {
    const body = {
      offre_id: id,
      opened_at: new Date().toISOString(),
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
      user_agent: (req.headers['user-agent'] || '').slice(0, 500) || null
    };
    const r = await fetch(`${SB_URL}/rest/v1/ouvertures`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    });
    if (r.ok || r.status === 201 || r.status === 204) {
      console.log(`[track-open] ✅ OK — offre ${id}`);
    } else {
      const txt = await r.text();
      console.error(`[track-open] ❌ Supabase ${r.status}: ${txt}`);
    }
  } catch (e) {
    console.error('[track-open] ❌ Exception:', e.message);
  }

  return res.status(200).end(PIXEL);
}

// ── Router principal ──────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Extraire la route depuis l'URL
  const url = req.url || '';
  const path = url.split('?')[0].replace(/\/$/, '');

  if (path === '/api/send-email')       return handleSendEmail(req, res);
  if (path === '/api/reset-password')   return handleResetPassword(req, res);
  if (path === '/api/generate')         return handleGenerate(req, res);
  if (path === '/api/stripe-checkout')  return handleStripeCheckout(req, res);
  if (path === '/api/stripe-portal')    return handleStripePortal(req, res);
  if (path === '/api/stripe-status')    return handleStripeStatus(req, res);
  if (path === '/api/stripe-webhook')   return handleStripeWebhook(req, res);
  if (path === '/api/track-open')        return handleTrackOpen(req, res);

  return json(res, 404, { error: 'Route not found', path });
}
