// api/cron-relances.js
export default async function handler(req, res) {

  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BREVO_KEY    = process.env.BREVO_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const today = new Date().toISOString().slice(0, 10);

  // Helper — ne jamais appeler .json() sur une réponse vide (204)
  const sb = async (path, opts = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (r.status === 204 || r.status === 201) return null; // No Content / Created sans body
    const text = await r.text();
    if (!text || text.trim() === '') return null;
    return JSON.parse(text);
  };

  try {
    // 1. Relances dues aujourd'hui — requêtes séparées pour éviter problèmes de jointure
    const relances = await sb(
      `relances?statut=eq.pending&date_prevue=lte.${today}&select=id,offre_id,numero`
    );

    if (!relances || relances.length === 0) {
      console.log(`[CRON] ${today} — Aucune relance à envoyer.`);
      return res.status(200).json({ sent: 0, message: 'Aucune relance due' });
    }

    console.log(`[CRON] ${today} — ${relances.length} relance(s) à traiter`);
    let sent = 0, errors = 0, skipped = 0;
    const results = [];

    for (const relance of relances) {
      try {
        // 2. Récupérer l'offre
        const offres = await sb(`offres?id=eq.${relance.offre_id}&select=*`);
        const offre = offres?.[0];
        if (!offre) { skipped++; continue; }

        // 3. Récupérer le client
        const clients = await sb(`clients?id=eq.${offre.client_id}&select=*`);
        const client = clients?.[0];
        if (!client || !client.email) { skipped++; continue; }

        // 4. Récupérer settings user
        const settings = await sb(
          `settings?user_id=eq.${offre.user_id}&key=in.(senderEmail,name,company,role,phone,website)&select=key,value`
        );
        const cfg = {};
        (settings || []).forEach(s => { cfg[s.key] = s.value; });

        const senderName = cfg.name || cfg.company || 'FollowOffer';
        const userEmail  = cfg.senderEmail || '';
        const SENDER     = 'contact@followoffer.com';
        const DISPLAY    = senderName ? `${senderName} via FollowOffer` : 'FollowOffer';

        const rNum = relance.numero;
        const tones = [
          'Ton léger et amical. 3-4 phrases. Vérifier si email bien reçu.',
          'Ton direct et engagé. 4-5 phrases. Proposer un appel rapide.',
          'Dernier contact. 3-4 phrases percutantes. Légère urgence.'
        ];

        // 5. Générer le corps via IA
        let emailBody = '';
        try {
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              messages: [{
                role: 'user',
                content: `Rédige en français une relance commerciale courte (Relance ${rNum}/3).
Client: ${client.prenom || ''} ${client.nom || ''}${client.entreprise ? ' — ' + client.entreprise : ''}
Objet offre: ${offre.objet || ''}
Montant: ${Number(offre.montant || 0).toLocaleString('fr-CH')} CHF
Réf: ${offre.reference || ''}
Style: ${tones[rNum - 1]}
Commence par "Bonjour ${client.prenom || ''}," — uniquement le corps, sans objet ni signature.`
              }]
            })
          });
          const aiData = await aiRes.json();
          emailBody = aiData?.content?.[0]?.text || '';
        } catch (aiErr) {
          console.error('[CRON] AI error:', aiErr.message);
        }

        // Fallback si IA échoue
        if (!emailBody.trim()) {
          emailBody = `Bonjour ${client.prenom || ''},\n\nJe me permets de revenir vers vous concernant notre offre ${offre.reference} — ${offre.objet} pour un montant de ${Number(offre.montant || 0).toLocaleString('fr-CH')} CHF.\n\nN'hésitez pas à me contacter pour toute question.`;
        }

        // Signature
        const sig = [
          '\n\n--',
          senderName,
          cfg.role || '',
          cfg.company || '',
          cfg.phone || '',
          cfg.website || '',
          userEmail || ''
        ].filter(Boolean).join('\n');
        const fullBody = emailBody + sig;

        const subject = rNum === 3
          ? `Dernier contact — Offre ${offre.reference}`
          : `Re: Offre ${offre.reference} — ${offre.objet}`;

        // 6. Envoyer via Brevo
        const brevoPayload = {
          sender: { name: DISPLAY, email: SENDER },
          to: [{ email: client.email, name: `${client.prenom || ''} ${client.nom || ''}`.trim() }],
          subject,
          textContent: fullBody,
          htmlContent: fullBody.replace(/\n/g, '<br>')
        };
        if (userEmail) brevoPayload.replyTo = { email: userEmail, name: senderName };

        const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
          body: JSON.stringify(brevoPayload)
        });

        if (brevoRes.ok || brevoRes.status === 201) {
          // 7. Marquer sent — sans .json() (204 No Content)
          await sb(`relances?id=eq.${relance.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ statut: 'sent', sent_at: new Date().toISOString() })
          });

          const nextStatut = ['relance1', 'relance2', 'relance3'][rNum - 1];
          await sb(`offres?id=eq.${offre.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ statut: nextStatut })
          });

          console.log(`[CRON] ✅ R${rNum} → ${client.email}`);
          results.push({ status: 'sent', to: client.email, rNum });
          sent++;
        } else {
          const errText = await brevoRes.text();
          console.error(`[CRON] ❌ Brevo: ${errText}`);
          results.push({ status: 'error', reason: errText });
          errors++;
        }

      } catch (relanceErr) {
        console.error('[CRON] Erreur relance:', relanceErr.message);
        results.push({ status: 'error', reason: relanceErr.message });
        errors++;
      }
    }

    return res.status(200).json({ date: today, total: relances.length, sent, errors, skipped, results });

  } catch (err) {
    console.error('[CRON] Erreur critique:', err);
    return res.status(500).json({ error: err.message });
  }
}
