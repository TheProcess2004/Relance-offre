// api/index.js — FollowOffer · Router unique
// Reconstruit depuis les fichiers sources originaux — CommonJS Vercel

const https = require('https');
const http = require('http');

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── /api/send-email ───────────────────────────────────────────────────────────
async function handleSendEmail(req, res) {
  const { from, fromName, to, toName, subject, body, htmlBody, pdfUrl, pdfName } = req.body;
  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) return res.status(500).json({ error: 'BREVO_API_KEY manquante' });
  if (!to) return res.status(400).json({ error: 'Destinataire manquant' });

  const SENDER_EMAIL = 'contact@followoffer.com';
  const SENDER_NAME = fromName ? fromName + ' via FollowOffer' : 'FollowOffer';

  try {
    const payload = {
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ name: toName || to, email: to }],
      replyTo: { email: from || SENDER_EMAIL, name: fromName || 'FollowOffer' },
      subject: subject || 'Votre offre',
      textContent: body || '',
      htmlContent: htmlBody || '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333;">' + (body||'').replace(/\n/g,'<br>') + '</div>',
    };
    if (pdfUrl && pdfName) {
      try {
        const pdfBuffer = await fetchBuffer(pdfUrl);
        if (pdfBuffer && pdfBuffer.length > 0) payload.attachment = [{ name: pdfName, content: pdfBuffer.toString('base64') }];
      } catch(e) { console.warn('PDF download failed:', e.message); }
    }
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify(payload)
    });
    const data = await brevoRes.json();
    if (!brevoRes.ok) return res.status(brevoRes.status).json({ error: data.message || 'Erreur Brevo' });
    return res.status(200).json({ success: true, messageId: data.messageId });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}

// ── /api/reset-password ───────────────────────────────────────────────────────
async function handleResetPassword(req, res) {
  const { email } = req.body;
  if (!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Email invalide' });

  const BREVO_KEY = process.env.BREVO_API_KEY;
  const SB_URL = process.env.SUPABASE_URL || 'https://eripvzfinfevuebccyzu.supabase.co';
  const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const APP_URL = process.env.APP_URL || 'https://followoffer.com';

  if (!BREVO_KEY || !SB_SERVICE_KEY) return res.status(500).json({ error: 'Config manquante' });

  try {
    const linkRes = await fetch(SB_URL + '/auth/v1/admin/users/generate_link', {
      method: 'POST',
      headers: { 'apikey': SB_SERVICE_KEY, 'Authorization': 'Bearer ' + SB_SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'recovery', email, redirect_to: APP_URL })
    });
    if (!linkRes.ok) return res.status(200).json({ success: true });
    const { action_link } = await linkRes.json();
    if (!action_link) return res.status(200).json({ success: true });

    const html = '<div style="font-family:Arial,sans-serif;padding:32px;"><h2>Réinitialisation mot de passe FollowOffer</h2><p><a href="' + action_link + '" style="background:#1555A8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Réinitialiser mon mot de passe</a></p><p style="color:#999;font-size:12px;">Ce lien est valable 1 heure.</p></div>';

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'FollowOffer', email: 'contact@followoffer.com' },
        to: [{ email }],
        subject: 'Réinitialisation de votre mot de passe FollowOffer',
        htmlContent: html,
        textContent: 'Réinitialisez votre mot de passe: ' + action_link
      })
    });
    if (!brevoRes.ok) return res.status(500).json({ error: 'Erreur envoi email' });
    return res.status(200).json({ success: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}

// ── /api/generate ─────────────────────────────────────────────────────────────
async function handleGenerate(req, res) {
  const CLAUDE_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY manquant' });
  try {
    const body = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1024,
        messages: body.messages || [],
        ...(body.system ? { system: body.system } : {})
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Erreur Claude' });
    return res.status(200).json(data);
  } catch(e) { return res.status(500).json({ error: e.message }); }
}

// ── /api/create-checkout ──────────────────────────────────────────────────────
async function handleCreateCheckout(req, res) {
  try {
    const { plan, user_email, user_id, success_url, cancel_url } = req.body;
    if (!user_email || !user_id) return res.status(400).json({ error: 'Missing user info' });

    const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
    const PRICE_ID = process.env.STRIPE_PRICE_PRO;
    if (!STRIPE_SECRET || !PRICE_ID) return res.status(500).json({ error: 'Stripe non configuré' });

    const params = new URLSearchParams({
      mode: 'subscription',
      'payment_method_types[]': 'card',
      customer_email: user_email,
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user_id,
      'metadata[plan]': plan || 'pro',
      'subscription_data[metadata][user_id]': user_id,
      success_url: (success_url || 'https://followoffer.com') + '?payment=success',
      cancel_url: cancel_url || 'https://followoffer.com',
      locale: 'fr',
      allow_promotion_codes: 'true',
    });

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const session = await response.json();
    if (!response.ok || !session.url) return res.status(500).json({ error: session.error?.message || 'Erreur Stripe' });
    return res.status(200).json({ url: session.url });
  } catch(err) { return res.status(500).json({ error: err.message }); }
}

// ── /api/stripe-webhook ───────────────────────────────────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(tPart.substring(2) + '.' + payload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
  return computed === v1Part.substring(3);
}

async function updateSupabasePlan(userId, plan, status, customerId, subscriptionId) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  for (const [key, value] of [['plan',plan],['plan_status',status],['stripe_customer_id',customerId||''],['stripe_subscription_id',subscriptionId||'']]) {
    await fetch(SB_URL + '/rest/v1/settings', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: userId, key, value })
    });
  }
}

async function handleStripeWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const buf = await readBody(req);
  const bodyStr = buf.toString('utf8');
  if (webhookSecret && sig) {
    const valid = await verifyStripeSignature(bodyStr, sig, webhookSecret);
    if (!valid) return res.status(400).json({ error: 'Invalid signature' });
  }
  let event;
  try { event = JSON.parse(bodyStr); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  const obj = event.data?.object;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  async function getSub(id) {
    const r = await fetch('https://api.stripe.com/v1/subscriptions/' + id, { headers: { 'Authorization': 'Basic ' + Buffer.from(stripeKey + ':').toString('base64') } });
    return r.json();
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const uid = obj.metadata?.user_id;
      if (uid) await updateSupabasePlan(uid, 'pro', 'active', obj.customer, obj.subscription);
    } else if (event.type === 'invoice.payment_succeeded' && obj.subscription) {
      const sub = await getSub(obj.subscription);
      if (sub.metadata?.user_id) await updateSupabasePlan(sub.metadata.user_id, 'pro', 'active', obj.customer, obj.subscription);
    } else if (event.type === 'invoice.payment_failed' && obj.subscription) {
      const sub = await getSub(obj.subscription);
      if (sub.metadata?.user_id) await updateSupabasePlan(sub.metadata.user_id, 'pro', 'past_due', obj.customer, obj.subscription);
    } else if (event.type === 'customer.subscription.deleted') {
      const uid = obj.metadata?.user_id;
      if (uid) await updateSupabasePlan(uid, 'free', 'active', obj.customer, '');
    }
  } catch(e) { console.error('Webhook error:', e); }
  return res.status(200).json({ received: true });
}

// ── /api/track-open ───────────────────────────────────────────────────────────
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function handleTrackOpen(req, res) {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id || id === 'test-123') return res.status(200).end(PIXEL);
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) return res.status(200).end(PIXEL);
  try {
    await fetch(SB_URL + '/rest/v1/ouvertures', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ offre_id: id, opened_at: new Date().toISOString(), ip: (req.headers['x-forwarded-for']||'').split(',')[0].trim()||null, user_agent: (req.headers['user-agent']||'').slice(0,500)||null })
    });
  } catch(e) { console.error('[track-open]', e.message); }
  return res.status(200).end(PIXEL);
}

// ── Router ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = (req.url || '').split('?')[0].replace(/\/$/, '');

  // Stripe webhook: raw body (pas de JSON parse)
  if (path === '/api/stripe-webhook') return handleStripeWebhook(req, res);

  // Tracking pixel: GET avec query params
  if (path === '/api/track-open') return handleTrackOpen(req, res);

  // Toutes les autres routes POST: parser le body
  if (req.method === 'POST' && !req.body) {
    try {
      const buf = await readBody(req);
      req.body = buf.length ? JSON.parse(buf.toString()) : {};
    } catch(e) { req.body = {}; }
  }

  if (path === '/api/send-email')      return handleSendEmail(req, res);
  if (path === '/api/reset-password')  return handleResetPassword(req, res);
  if (path === '/api/generate')        return handleGenerate(req, res);
  if (path === '/api/create-checkout') return handleCreateCheckout(req, res);

  return res.status(404).json({ error: 'Route not found', path });
};
