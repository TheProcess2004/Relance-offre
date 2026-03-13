// api/cron-relances.js
// Appelé chaque matin par Vercel Cron — envoie les relances dues via Brevo

export default async function handler(req, res) {

  // Sécurité : seul Vercel (ou toi) peut appeler ce endpoint
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role = bypass RLS
  const BREVO_KEY    = process.env.BREVO_API_KEY;

  const sb = (path, opts = {}) =>
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(opts.headers || {})
      }
    }).then(r => r.json());

  const today = new Date().toISOString().slice(0, 10); // "2026-03-13"

  try {
    // 1. Récupérer toutes les relances dues (date_prevue <= aujourd'hui, statut pending)
    const relances = await sb(
      `relances?statut=eq.pending&date_prevue=lte.${today}&select=*,offres(*,clients(*))`
    );

    if (!relances || relances.length === 0) {
      console.log(`[CRON] ${today} — Aucune relance à envoyer.`);
      return res.status(200).json({ sent: 0, message: 'Aucune relance due' });
    }

    console.log(`[CRON] ${today} — ${relances.length} relance(s) à traiter`);

    let sent = 0;
    let errors = 0;
    const results = [];

    for (const relance of relances) {
      const offre  = relance.offres;
      const client = offre?.clients;

      if (!offre || !client) {
        console.warn('[CRON] Relance sans offre/client:', relance.id);
        continue;
      }

      // 2. Récupérer les settings de l'utilisateur (senderEmail + brevoKey)
      const settings = await sb(
        `settings?user_id=eq.${offre.user_id}&key=in.(senderEmail,brevoKey,name,company)`
      );
      const cfg = {};
      (settings || []).forEach(s => { cfg[s.key] = s.value; });

      const userEmail  = cfg.senderEmail || ''; // adresse du client → replyTo uniquement
      const senderName = cfg.name || cfg.company || '';

      // Expéditeur fixe toujours validé dans Brevo — zéro action requise du client
      const SENDER_EMAIL = 'contact@followoffer.com';
      const SENDER_NAME  = senderName ? `${senderName} via FollowOffer` : 'FollowOffer';

      // 3. Générer le corps de l'email via Claude AI
      const tones = [
        'Relance légère et amicale — vérifier si email bien reçu. 3-4 lignes max. Ton professionnel.',
        'Relance plus directe — proposer un échange ou appel rapide. 4-5 lignes. Créer de l\'intérêt.',
        'Dernière tentative — créer légère urgence, offre expire bientôt. 3-4 lignes percutantes.'
      ];
      const rNum = relance.numero; // 1, 2 ou 3

      let emailBody = '';
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', // rapide + économique pour le cron
            max_tokens: 350,
            messages: [{
              role: 'user',
              content: `Rédige une relance commerciale automatique (Relance ${rNum}/3) pour une offre sans réponse.
Client: ${client.prenom} ${client.nom}${client.entreprise ? ' — ' + client.entreprise : ''}
Objet de l'offre: ${offre.objet}
Montant: ${Number(offre.montant).toLocaleString('fr-CH')} CHF
Référence: ${offre.reference}
Style: ${tones[rNum - 1]}
Expéditeur: ${senderName}

Commence par "Bonjour ${client.prenom}," — rédige UNIQUEMENT le corps de l'email, sans objet ni signature.`
            }]
          })
        });
        const aiData = await aiRes.json();
        emailBody = aiData.content?.[0]?.text || '';
      } catch (aiErr) {
        // Fallback texte générique si AI échoue
        emailBody = `Bonjour ${client.prenom},\n\nJe me permets de revenir vers vous concernant notre offre ${offre.reference} — ${offre.objet} (${Number(offre.montant).toLocaleString('fr-CH')} CHF).\n\nN'hésitez pas à me contacter pour toute question.\n\nCordialement,\n${senderName}`;
      }

      // Ajouter signature simple
      const signature = `\n\n---\n${SENDER_NAME.replace(' via FollowOffer','')}${userEmail ? '\n' + userEmail : ''}`;
      const fullBody = emailBody + signature;

      // 4. Envoyer via Brevo
      const subject = rNum === 3
        ? `Dernier contact — Offre ${offre.reference}`
        : `Re: Offre ${offre.reference} — ${offre.objet}`;

      try {
        const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': BREVO_KEY
          },
          body: JSON.stringify({
            sender: { name: SENDER_NAME, email: SENDER_EMAIL },
            replyTo: userEmail ? { email: userEmail, name: senderName || userEmail } : undefined,
            to: [{ email: client.email, name: `${client.prenom} ${client.nom}` }],
            subject,
            textContent: fullBody,
            htmlContent: fullBody.replace(/\n/g, '<br>')
          })
        });

        if (brevoRes.ok || brevoRes.status === 201) {
          // 5. Marquer la relance comme envoyée
          await sb(`relances?id=eq.${relance.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ statut: 'sent', sent_at: new Date().toISOString() })
          });

          // Mettre à jour le statut de l'offre
          const nextStatut = ['relance1', 'relance2', 'relance3'][rNum - 1];
          await sb(`offres?id=eq.${offre.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ statut: nextStatut })
          });

          console.log(`[CRON] ✅ Relance ${rNum} → ${client.email} (${offre.reference})`);
          results.push({ id: relance.id, status: 'sent', to: client.email, relanceNum: rNum });
          sent++;

        } else {
          const errText = await brevoRes.text();
          console.error(`[CRON] ❌ Brevo error pour ${client.email}:`, errText);
          results.push({ id: relance.id, status: 'error', reason: errText });
          errors++;
        }

      } catch (sendErr) {
        console.error('[CRON] Erreur envoi:', sendErr.message);
        results.push({ id: relance.id, status: 'error', reason: sendErr.message });
        errors++;
      }
    }

    return res.status(200).json({
      date: today,
      total: relances.length,
      sent,
      errors,
      results
    });

  } catch (err) {
    console.error('[CRON] Erreur critique:', err);
    return res.status(500).json({ error: err.message });
  }
}
