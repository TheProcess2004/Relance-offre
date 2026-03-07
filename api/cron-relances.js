// api/cron-relances.js — Vercel Cron Function
// Tourne chaque matin à 7h — envoie les relances dues automatiquement

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
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.method === 'PATCH' ? 'return=minimal' : 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  return options.method === 'PATCH' ? null : res.json();
}

async function generateEmailBody(offre, rNum) {
  const tones = [
    'Relance légère et amicale — vérifier si email bien reçu. 3-4 lignes max.',
    'Relance plus directe — proposer un échange ou appel rapide. 4-5 lignes.',
    'Dernière tentative — créer légère urgence, offre expire bientôt. 3-4 lignes percutantes.'
  ];
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
    if (!ANTHROPIC_KEY) throw new Error('No ANTHROPIC_KEY');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: `Rédige une relance commerciale (Relance ${rNum}) pour une offre non répondue.\nClient: ${offre.prenom} ${offre.nom}\nObjet: ${offre.objet}\nMontant: ${offre.montant} CHF\nRéf: ${offre.reference}\nStyle: ${tones[rNum-1]}\nCommence par "Bonjour ${offre.prenom}," — corps de l'email uniquement, pas de signature.` }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || '';
  } catch(e) {
    return `Bonjour ${offre.prenom},\n\nJe me permets de revenir vers vous concernant notre offre ${offre.reference} — ${offre.objet} (${offre.montant} CHF).\n\nN'hésitez pas à me contacter pour toute question.`;
  }
}

async function sendEmail({ to, toName, fromEmail, fromName, subject, body, pdfUrl, pdfName }) {
  const BREVO_KEY = process.env.BREVO_API_KEY;
  const payload = {
    sender: { name: fromName ? `${fromName} via FollowOffer` : 'FollowOffer', email: 'contact@followoffer.com' },
    to: [{ name: toName, email: to }],
    replyTo: { email: fromEmail, name: fromName || fromEmail },
    subject,
    htmlContent: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333;">${body.replace(/\n/g,'<br>')}</div>`,
    textContent: body
  };
  if (pdfUrl && pdfName) {
    try {
      const buf = await fetchBuffer(pdfUrl);
      if (buf.length > 0) payload.attachment = [{ name: pdfName, content: buf.toString('base64') }];
    } catch(e) { console.warn('PDF attach failed:', e.message); }
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
    body: JSON.stringify(payload)
  });
  return res.ok;
}

module.exports = async (req, res) => {
  // Sécurité — vérifier que c'est bien Vercel qui appelle
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results = { sent: 0, errors: 0, skipped: 0 };

  try {
    // Récupérer toutes les relances dues aujourd'hui ou avant
    const relances = await sbQuery(
      `relances?statut=eq.pending&date_prevue=lte.${today}&select=*,offres(*,clients(*),settings_user:settings(*))`
    );

    console.log(`Cron relances: ${relances.length} relances dues`);

    for (const relance of relances) {
      const offre = relance.offres;
      if (!offre) { results.skipped++; continue; }

      try {
        // Récupérer les settings du user (nom, email expéditeur)
        const settings = await sbQuery(`settings?user_id=eq.${offre.user_id}&select=key,value`);
        const cfg = {};
        settings.forEach(s => cfg[s.key] = s.value);

        if (!cfg.senderEmail) { results.skipped++; continue; }
        if (!offre.clients?.email) { results.skipped++; continue; }

        const rNum = relance.numero;
        const emailBody = await generateEmailBody({
          prenom: offre.clients.prenom,
          nom: offre.clients.nom,
          objet: offre.objet,
          montant: offre.montant,
          reference: offre.reference
        }, rNum);

        // Ajouter signature
        const signature = cfg.name ? `\n\n--\n${cfg.name}${cfg.role ? '\n'+cfg.role : ''}${cfg.company ? '\n'+cfg.company : ''}${cfg.phone ? '\n'+cfg.phone : ''}` : '';
        const bodyFinal = emailBody + signature;

        const sent = await sendEmail({
          to: offre.clients.email,
          toName: `${offre.clients.prenom} ${offre.clients.nom}`,
          fromEmail: cfg.senderEmail,
          fromName: cfg.name,
          subject: `Re: Offre ${offre.reference} — ${offre.objet}`,
          body: bodyFinal,
          pdfUrl: offre.pdf_url || '',
          pdfName: offre.fichier_nom || `${offre.reference}.pdf`
        });

        if (sent) {
          // Marquer comme envoyée
          await sbQuery(`relances?id=eq.${relance.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ statut: 'sent', sent_at: new Date().toISOString() })
          });
          // Mettre à jour le statut de l'offre
          const newStatut = `relance${rNum}`;
          await sbQuery(`offres?id=eq.${offre.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ statut: newStatut })
          });
          results.sent++;
          console.log(`✅ Relance ${rNum} envoyée: ${offre.reference} → ${offre.clients.email}`);
        } else {
          results.errors++;
        }
      } catch(e) {
        console.error(`❌ Erreur relance ${relance.id}:`, e.message);
        results.errors++;
      }
    }

    return res.status(200).json({ success: true, date: today, ...results });
  } catch(e) {
    console.error('Cron error:', e);
    return res.status(500).json({ error: e.message });
  }
};
