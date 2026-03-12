// api/cron-relances.js — Vercel Cron Function
// Tourne chaque matin à 8h Zurich (6h UTC) — envoie les relances dues automatiquement

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

async function sbQuery(path, options = {}) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.method === 'PATCH' || options.method === 'DELETE' ? 'return=minimal' : 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  return options.method === 'PATCH' || options.method === 'DELETE' ? null : res.json();
}

async function generateEmailBody(offre, rNum) {
  const ton = offre.ton || 'chaleureux';
  const relation = offre.relation || 'connu';
  const isTu = ton === 'chaleureux' && (relation === 'connu' || relation === 'fidele');

  const pronoun = isTu
    ? 'tutoiement exclusif (tu/toi/ton) — aucune exception'
    : 'vouvoiement exclusif (vous/votre) — aucune exception';

  const saluts = isTu
    ? [
        "Au plaisir d'en discuter avec toi,",
        "N'hésite pas si tu as des questions. Au plaisir,",
        "Je reste disponible si tu veux en reparler. Bonne continuation,"
      ]
    : [
        'Meilleures salutations,',
        "Pour tout complément d'information, n'hésitez pas à nous contacter. Meilleures salutations,",
        'Sincères salutations,'
      ];

  const styles = [
    'doux et bienveillant — simple rappel chaleureux',
    'direct et engagé — légère urgence, invite à répondre',
    'final — laisse la porte ouverte sans pression'
  ];

  const montantFmt = Number(offre.montant || 0).toLocaleString('fr-CH') + ' CHF';

  // Si un email_body est déjà stocké en DB, l'utiliser directement
  if (offre.email_body && offre.email_body.trim().length > 20) {
    console.log(`Using stored email_body for relance ${rNum}`);
    return offre.email_body;
  }

  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
    if (!ANTHROPIC_KEY) throw new Error('No ANTHROPIC_KEY');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Tu es un commercial expert. Rédige la relance ${rNum} pour une offre sans réponse.
Client: ${offre.prenom} ${offre.nom}
Objet: ${offre.objet}
Montant: ${montantFmt}
Réf: ${offre.reference}

RÈGLES ABSOLUES :
1. Utilise UNIQUEMENT le ${pronoun}
2. Commence EXACTEMENT par "Bonjour ${offre.prenom},"
3. Corps: 2-3 lignes, style ${styles[rNum - 1]}
4. Termine EXACTEMENT par "${saluts[rNum - 1]}"
5. Pas de signature — ajoutée automatiquement

Réponds UNIQUEMENT avec le texte de l'email.`
        }]
      })
    });

    const data = await res.json();
    return data.content?.[0]?.text || '';
  } catch (e) {
    console.error('AI generation error:', e.message);
    return isTu
      ? `Bonjour ${offre.prenom},\n\nJe reviens vers toi concernant notre offre ${offre.reference} — ${offre.objet} (${montantFmt}).\n\nN'hésite pas à me faire signe si tu as des questions.\n\n${saluts[rNum - 1]}`
      : `Bonjour ${offre.prenom},\n\nJe me permets de revenir vers vous concernant notre offre ${offre.reference} — ${offre.objet} (${montantFmt}).\n\nN'hésitez pas à me contacter pour toute question.\n\n${saluts[rNum - 1]}`;
  }
}

async function sendEmail({ to, toName, fromEmail, fromName, subject, body, pdfUrl, pdfName, offerId }) {
  const BREVO_KEY = process.env.BREVO_API_KEY;
  const APP_URL = process.env.APP_URL || 'https://followoffer.com';

  const pixel = offerId
    ? `<div style="max-height:0;overflow:hidden;mso-hide:all;"><img src="${APP_URL}/api/track-open?id=${offerId}" width="2" height="2" style="width:2px;height:2px;border:0;display:block;" alt="" /></div>`
    : '';

  const htmlContent = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333;">${body.replace(/\n/g, '<br>')}</div>${pixel}`;

  const payload = {
    sender: { name: fromName || 'FollowOffer', email: fromEmail },
    to: [{ name: toName, email: to }],
    subject,
    htmlContent,
    textContent: body
  };

  if (pdfUrl && pdfName) {
    try {
      const buf = await fetchBuffer(pdfUrl);
      if (buf.length > 0) payload.attachment = [{ name: pdfName, content: buf.toString('base64') }];
    } catch (e) {
      console.warn('PDF attach failed:', e.message);
    }
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('Brevo error:', err);
  }
  return res.ok;
}

module.exports = async (req, res) => {
  // Sécurité — vérifier CRON_SECRET
  const authHeader = req.headers['authorization'];
  const querySecret = (req.url || '').includes('?')
    ? new URLSearchParams(req.url.split('?')[1]).get('secret')
    : null;
  const validSecret = process.env.CRON_SECRET;
  if (validSecret && authHeader !== `Bearer ${validSecret}` && querySecret !== validSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results = { sent: 0, errors: 0, skipped: 0, details: [] };

  try {
    // ── ÉTAPE 1 : Relances pending dues ──
    const relancesRaw = await sbQuery(
      `relances?statut=eq.pending&date_prevue=lte.${today}&select=*`
    );
    console.log(`Cron ${today}: ${relancesRaw.length} relances pending`);

    if (!relancesRaw.length) {
      return res.status(200).json({ success: true, date: today, ...results, info: 'Aucune relance due' });
    }

    // ── ÉTAPE 2 : Charger offres + clients en 2 requêtes séparées (évite les FK Supabase) ──
    const offreIds = [...new Set(relancesRaw.map(r => r.offre_id).filter(Boolean))];
    const offresRaw = await sbQuery(`offres?id=in.(${offreIds.join(',')})&select=*`);

    const clientIds = [...new Set(offresRaw.map(o => o.client_id).filter(Boolean))];
    const clientsRaw = clientIds.length
      ? await sbQuery(`clients?id=in.(${clientIds.join(',')})&select=*`)
      : [];

    // Index O(1)
    const offresMap  = Object.fromEntries(offresRaw.map(o => [o.id, o]));
    const clientsMap = Object.fromEntries(clientsRaw.map(c => [c.id, c]));

    console.log(`Offres chargées: ${offresRaw.length}, clients: ${clientsRaw.length}`);

    // ── ÉTAPE 3 : Traiter chaque relance ──
    for (const relance of relancesRaw) {
      const offre   = offresMap[relance.offre_id] || null;
      const client  = offre ? (clientsMap[offre.client_id] || null) : null;

      if (!offre || !client) {
        results.skipped++;
        results.details.push({ id: relance.id, reason: 'offre ou client introuvable en DB' });
        continue;
      }

      // Annuler si offre terminée
      if (['won', 'lost'].includes(offre.statut)) {
        await sbQuery(`relances?id=eq.${relance.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ statut: 'cancelled' })
        });
        results.skipped++;
        results.details.push({ id: relance.id, offre: offre.reference, reason: `offre ${offre.statut} — relance annulée` });
        continue;
      }

      try {
        // Settings de l'utilisateur
        const userId = offre.user_id || relance.user_id;
        const settingsRows = await sbQuery(`settings?user_id=eq.${userId}&select=key,value`);
        const cfg = {};
        (settingsRows || []).forEach(s => { cfg[s.key] = s.value; });

        const fromEmail = cfg.senderEmail || cfg.sender_email || process.env.BREVO_SENDER_EMAIL;
        const fromName  = cfg.name || cfg.sender_name || '';

        if (!fromEmail) {
          results.skipped++;
          results.details.push({ id: relance.id, offre: offre.reference, reason: 'email expéditeur non configuré dans Paramètres > Email' });
          continue;
        }
        if (!client.email) {
          results.skipped++;
          results.details.push({ id: relance.id, offre: offre.reference, reason: 'email destinataire manquant sur la fiche client' });
          continue;
        }

        const rNum = relance.numero;

        // Générer le corps (utilise email_body stocké si disponible)
        const emailBody = await generateEmailBody({
          prenom: client.prenom,
          nom: client.nom,
          objet: offre.objet,
          montant: offre.montant,
          reference: offre.reference,
          ton: offre.ton,
          relation: offre.relation,
          email_body: relance.email_body   // corps pré-rédigé depuis l'app
        }, rNum);

        // Signature
        const sigParts = [];
        if (fromName)                      sigParts.push(fromName);
        if (cfg.role || cfg.sender_role)   sigParts.push(cfg.role || cfg.sender_role);
        if (cfg.company || cfg.sender_company) sigParts.push(cfg.company || cfg.sender_company);
        if (cfg.phone || cfg.sender_phone) sigParts.push(cfg.phone || cfg.sender_phone);
        const signature  = sigParts.length ? '\n\n--\n' + sigParts.join('\n') : '';
        const bodyFinal  = emailBody + signature;

        const sent = await sendEmail({
          to: client.email,
          toName: `${client.prenom} ${client.nom}`,
          fromEmail,
          fromName,
          subject: `Re: Offre ${offre.reference} — ${offre.objet}`,
          body: bodyFinal,
          pdfUrl:  offre.pdf_url || '',
          pdfName: offre.fichier_nom || `${offre.reference}.pdf`,
          offerId: offre.id
        });

        if (sent) {
          await sbQuery(`relances?id=eq.${relance.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ statut: 'sent', date_envoyee: new Date().toISOString() })
          });
          await sbQuery(`offres?id=eq.${offre.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ statut: `relance${rNum}` })
          });
          results.sent++;
          results.details.push({ offre: offre.reference, client: client.email, relance: `R${rNum}`, status: 'sent' });
          console.log(`✅ R${rNum} → ${offre.reference} → ${client.email}`);
        } else {
          results.errors++;
          results.details.push({ offre: offre.reference, relance: `R${rNum}`, status: 'brevo_error' });
        }

      } catch (e) {
        console.error(`❌ Relance ${relance.id}:`, e.message);
        results.errors++;
        results.details.push({ id: relance.id, status: 'error', reason: e.message });
      }
    }

    console.log(`Cron terminé: ${results.sent} envoyées, ${results.errors} erreurs, ${results.skipped} ignorées`);
    return res.status(200).json({ success: true, date: today, ...results });

  } catch (e) {
    console.error('Cron fatal:', e);
    return res.status(500).json({ error: e.message });
  }
};
