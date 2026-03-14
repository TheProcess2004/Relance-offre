// api/cron-relances.js
export default async function handler(req, res) {

  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BREVO_KEY     = process.env.BREVO_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const today = new Date().toISOString().slice(0, 10);

  // Helper Supabase — gère les 204 No Content proprement
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
    if (r.status === 204 || r.status === 201) return null;
    const text = await r.text();
    if (!text || !text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  };

  // Génération IA avec timeout 8 secondes
  const generateWithAI = async (client, offre, rNum, senderName) => {
    const tones = [
      `Ton amical et léger. 3-4 phrases. Demander si l'email a bien été reçu et si des questions se posent.`,
      `Ton direct et engagé. 4-5 phrases. Souligner la valeur de l'offre, proposer un appel ou échange rapide.`,
      `Ton percutant, dernier contact. 3-4 phrases. Créer une légère urgence sans pression excessive. Indiquer que tu clos le dossier sauf signe de leur part.`
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 250,
          messages: [{
            role: 'user',
            content: `Rédige en français une relance commerciale (Relance ${rNum}/3) pour une offre sans réponse.
Client: ${client.prenom || ''} ${client.nom || ''}${client.entreprise ? ' — ' + client.entreprise : ''}
Objet: ${offre.objet || ''}
Montant: ${Number(offre.montant || 0).toLocaleString('fr-CH')} CHF
Réf: ${offre.reference || ''}
Expéditeur: ${senderName}
Style: ${tones[rNum - 1]}

IMPORTANT: Commence OBLIGATOIREMENT par "Bonjour ${client.prenom || ''}," puis le corps du mail uniquement. Pas d'objet, pas de signature, pas de "Cordialement" — uniquement les 3-4 phrases du corps.`
          }]
        })
      });
      clearTimeout(timeout);
      const data = await aiRes.json();
      return data?.content?.[0]?.text?.trim() || '';
    } catch (e) {
      clearTimeout(timeout);
      return ''; // Timeout ou erreur → fallback
    }
  };

  // Fallbacks de qualité par numéro de relance
  const getFallback = (client, offre, rNum) => {
    const prenom = client.prenom || 'Madame, Monsieur';
    const ref = offre.reference || '';
    const objet = offre.objet || 'notre offre';
    const montant = Number(offre.montant || 0).toLocaleString('fr-CH');

    const fallbacks = [
      // R1 — léger
      `Bonjour ${prenom},\n\nJe me permets de revenir vers vous concernant notre offre ${ref} — ${objet} (${montant} CHF) que je vous ai transmise il y a quelques jours.\n\nAvez-vous eu l'occasion d'en prendre connaissance ? Je reste disponible pour répondre à toutes vos questions.`,
      // R2 — engagé
      `Bonjour ${prenom},\n\nSuite à mon précédent message concernant l'offre ${ref} — ${objet} pour ${montant} CHF, je souhaitais m'assurer qu'elle correspond bien à vos attentes.\n\nSeriez-vous disponible pour un échange rapide cette semaine ? Cela me permettrait de m'assurer que cette offre répond parfaitement à votre projet.`,
      // R3 — dernier contact
      `Bonjour ${prenom},\n\nC'est mon dernier message concernant l'offre ${ref} — ${objet} (${montant} CHF).\n\nSi le projet n'est plus d'actualité, pas de souci — je clos le dossier de mon côté. Et si vous souhaitez qu'on en reparle, je reste bien entendu disponible sur simple réponse à cet email.`
    ];
    return fallbacks[rNum - 1];
  };

  try {
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
        const offres = await sb(`offres?id=eq.${relance.offre_id}&select=*`);
        const offre = offres?.[0];
        if (!offre) { skipped++; continue; }

        const clients = await sb(`clients?id=eq.${offre.client_id}&select=*`);
        const client = clients?.[0];
        if (!client?.email) { skipped++; continue; }

        const settings = await sb(
          `settings?user_id=eq.${offre.user_id}&key=in.(senderEmail,name,company,role,phone,website)&select=key,value`
        );
        const cfg = {};
        (settings || []).forEach(s => { cfg[s.key] = s.value; });

        const senderName = cfg.name || cfg.company || 'FollowOffer';
        const userEmail  = cfg.senderEmail || '';
        const DISPLAY    = senderName ? `${senderName} via FollowOffer` : 'FollowOffer';
        const SENDER     = 'contact@followoffer.com';
        const rNum       = relance.numero;

        // IA avec fallback de qualité
        let body = await generateWithAI(client, offre, rNum, senderName);
        const usedAI = !!body;
        if (!body) body = getFallback(client, offre, rNum);

        // Signature complète
        const sigParts = ['--', senderName];
        if (cfg.role)    sigParts.push(cfg.role);
        if (cfg.company && cfg.company !== senderName) sigParts.push(cfg.company);
        if (cfg.phone)   sigParts.push(cfg.phone);
        if (cfg.website) sigParts.push(cfg.website);
        if (userEmail)   sigParts.push(userEmail);
        const signature = '\n\n' + sigParts.join('\n');

        // Phrase de référence à l'offre originale
        const refLine = `\n\nRéf. offre : ${offre.reference} — ${offre.objet} — ${Number(offre.montant || 0).toLocaleString('fr-CH')} CHF`;
        const fullBody = body + refLine + signature;

        const subject = rNum === 3
          ? `Dernier contact — Offre ${offre.reference}`
          : `Re: Offre ${offre.reference} — ${offre.objet}`;

        // HTML propre
        const htmlBody = fullBody
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/\n/g,'<br>');

        const brevoPayload = {
          sender: { name: DISPLAY, email: SENDER },
          to: [{ email: client.email, name: `${client.prenom||''} ${client.nom||''}`.trim() }],
          subject,
          textContent: fullBody,
          htmlContent: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333;max-width:600px;">${htmlBody}</div>`
        };
        if (userEmail) brevoPayload.replyTo = { email: userEmail, name: senderName };

        const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
          body: JSON.stringify(brevoPayload)
        });

        if (brevoRes.ok || brevoRes.status === 201) {
          await sb(`relances?id=eq.${relance.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ statut: 'sent', sent_at: new Date().toISOString() })
          });
          const nextStatut = ['relance1','relance2','relance3'][rNum - 1];
          await sb(`offres?id=eq.${offre.id}`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ statut: nextStatut })
          });
          console.log(`[CRON] ✅ R${rNum} → ${client.email} (${usedAI ? 'IA' : 'fallback'})`);
          results.push({ status: 'sent', to: client.email, rNum, usedAI });
          sent++;
        } else {
          const errText = await brevoRes.text();
          console.error(`[CRON] ❌ Brevo: ${errText}`);
          results.push({ status: 'error', reason: errText });
          errors++;
        }

      } catch (e) {
        console.error('[CRON] Erreur:', e.message);
        results.push({ status: 'error', reason: e.message });
        errors++;
      }
    }

    return res.status(200).json({ date: today, total: relances.length, sent, errors, skipped, results });

  } catch (err) {
    console.error('[CRON] Erreur critique:', err);
    return res.status(500).json({ error: err.message });
  }
}
