// ══════════════════════════════════════════════════════════════
// FEATURE 2 — TRACKING PIXEL D'OUVERTURE EMAIL
// ══════════════════════════════════════════════════════════════

// ── FICHIER 1 : api/track-open.js (Vercel Serverless Function) ──
// Créer ce fichier dans votre repo GitHub à l'emplacement api/track-open.js

/*
// api/track-open.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Service role key (pas anon key !)
);

module.exports = async (req, res) => {
  const { id } = req.query; // offre ID

  if (id) {
    try {
      // 1. Incrémenter le compteur d'ouvertures
      const { data: offre } = await supabase
        .from('offres')
        .select('opens, user_id')
        .eq('id', id)
        .single();

      if (offre) {
        await supabase
          .from('offres')
          .update({
            opens: (offre.opens || 0) + 1,
            last_open: new Date().toISOString()
          })
          .eq('id', id);

        // 2. Enregistrer dans la table ouvertures
        await supabase.from('ouvertures').insert({
          offre_id: id,
          user_id: offre.user_id,
          opened_at: new Date().toISOString(),
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
          user_agent: req.headers['user-agent'] || ''
        });
      }
    } catch (e) {
      console.error('Track open error:', e);
    }
  }

  // Retourner un pixel GIF transparent 1x1
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.end(pixel);
};
*/

// ── FICHIER 2 : Modification de sendBrevoEmail() dans index.html ──
// Ajouter le pixel de tracking dans le corps de l'email

function buildTrackingPixel(offerId) {
  // URL de votre app en production
  const baseUrl = window.location.origin;
  return `<img src="${baseUrl}/api/track-open?id=${offerId}" width="1" height="1" style="display:none;" alt="" />`;
}

// ── VERSION MODIFIÉE de sendBrevoEmail() ──
// Remplacer l'ancienne fonction par celle-ci dans index.html :

async function sendBrevoEmailWithTracking({ to, toName, subject, body, pdfUrl, pdfName, offerId }) {
  const fromEmail = CFG.senderEmail || CURRENT_USER?.email;
  const fromName = CFG.name || fromEmail;
  if (!fromEmail) {
    toast('⚠️', 'Configurez votre email dans Configuration');
    return false;
  }

  // Convertir le corps texte en HTML avec pixel de tracking
  const htmlBody = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333;">
      ${body.replace(/\n/g, '<br>')}
      ${buildSignature()}
    </div>
    ${offerId ? buildTrackingPixel(offerId) : ''}
  `;

  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'brevo',
        from: fromEmail,
        fromName,
        to,
        toName,
        subject,
        htmlBody, // ← HTML avec pixel intégré
        body,     // ← texte brut fallback
        pdfUrl,
        pdfName
      })
    });

    if (res.ok && offerId) {
      // Marquer comme "envoyé" dans Supabase
      await sbFetch('offres?id=eq.' + offerId, {
        method: 'PATCH',
        body: JSON.stringify({ sent_at: new Date().toISOString() }),
        headers: { 'Prefer': 'return=minimal' }
      });
    }

    return res.ok;
  } catch (e) {
    console.warn('Brevo error:', e);
    return false;
  }
}

// ── MIGRATION SQL Supabase ──
// Exécuter dans l'éditeur SQL de Supabase :

/*
-- Ajouter les colonnes manquantes à la table offres
ALTER TABLE offres
  ADD COLUMN IF NOT EXISTS opens INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_open TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Table ouvertures (si pas déjà créée)
CREATE TABLE IF NOT EXISTS ouvertures (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  offre_id UUID REFERENCES offres(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT
);

-- RLS
ALTER TABLE ouvertures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own ouvertures" ON ouvertures
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service can insert ouvertures" ON ouvertures
  FOR INSERT WITH CHECK (true);
*/

// ── VARIABLES ENV à ajouter dans Vercel ──
/*
SUPABASE_URL = https://eripvzfinfevuebccyzu.supabase.co
SUPABASE_SERVICE_KEY = [votre service_role key depuis Supabase → Settings → API]
*/

// ── NOTIFICATION TEMPS RÉEL dans index.html ──
// Ajouter dans loadApp() ou après init() pour écouter les ouvertures en live :

function initRealtimeTracking() {
  if (!CURRENT_USER) return;

  // Polling toutes les 30s pour détecter nouvelles ouvertures
  setInterval(async () => {
    try {
      const fresh = await sbFetch(
        `offres?user_id=eq.${CURRENT_USER.id}&opens=gt.0&order=last_open.desc&limit=1`
      );
      if (fresh?.length) {
        const o = fresh[0];
        const existing = OFFERS.find(x => x.id === o.id);
        if (existing && o.opens > existing.opens) {
          // Nouvelle ouverture détectée !
          existing.opens = o.opens;
          existing.lastOpen = new Date(o.last_open).toLocaleDateString('fr-CH');
          showOpenNotification(existing);
          renderDetection();
        }
      }
    } catch (e) { /* silent */ }
  }, 30000);
}

function showOpenNotification(offer) {
  // Badge de notification dans la sidebar
  const nc = document.getElementById('nc-detection');
  if (nc) {
    nc.style.display = 'inline-block';
    nc.textContent = '🔥 OUVERT';
  }

  // Toast spécial
  toast('👁', `${offer.prenom} ${offer.nom} a ouvert votre email — ${offer.montant?.toLocaleString('fr-CH')} CHF`);
}

// ── HOOK dans loadApp() ──
// Ajouter à la fin de loadApp() :
// initRealtimeTracking(); // ← AJOUTER
