import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // clé service_role (pas anon!)
);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function upsertSubscription(userId, data) {
  const { error } = await supabase
    .from('settings')
    .upsert({
      user_id: userId,
      stripe_customer_id: data.customerId,
      stripe_subscription_id: data.subscriptionId,
      stripe_price_id: data.priceId,
      plan: data.plan,
      plan_status: data.status,
      plan_period_end: data.periodEnd,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

  if (error) console.error('Supabase upsert error:', error);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log('Stripe event:', event.type);

  const getSubData = async (subscription) => ({
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    priceId: subscription.items.data[0]?.price?.id,
    plan: subscription.items.data[0]?.price?.id === process.env.STRIPE_PRICE_PRO ? 'pro' : 'free',
    status: subscription.status, // active, canceled, past_due, trialing...
    periodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    userId: subscription.metadata?.supabase_user_id
  });

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const userId = session.metadata?.supabase_user_id || sub.metadata?.supabase_user_id;
        if (userId) await upsertSubscription(userId, { ...(await getSubData(sub)), userId });
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object;
        const userId = sub.metadata?.supabase_user_id;
        if (userId) await upsertSubscription(userId, { ...(await getSubData(sub)), userId });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = sub.metadata?.supabase_user_id;
        if (userId) {
          await upsertSubscription(userId, {
            ...(await getSubData(sub)),
            plan: 'free',
            status: 'canceled',
            userId
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata?.supabase_user_id;
        if (userId) await upsertSubscription(userId, { ...(await getSubData(sub)), status: 'past_due', userId });
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: err.message });
  }

  res.json({ received: true });
}
