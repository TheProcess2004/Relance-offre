// api/send-email.js — Vercel Serverless Function
// Envoie via Brevo avec Reply-To pour les adresses non vérifiées

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { from, fromName, to, toName, subject, body, htmlBody, pdfUrl, pdfName } = req.body;

  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) return res.status(500).json({ error: 'BREVO_API_KEY manquante dans Vercel' });
  if (!to) return res.status(400).json({ error: 'Destinataire manquant' });

  // Adresse expéditrice technique Brevo vérifiée
  // Si l'utilisateur a son propre domaine vérifié dans Brevo, on l'utilise
  // Sinon on utilise noreply@followoffer.com avec Reply-To vers l'adresse de l'utilisateur
  const VERIFIED_SENDER = process.env.BREVO_SENDER_EMAIL || 'noreply@followoffer.com';
  const VERIFIED_NAME = process.env.BREVO_SENDER_NAME || 'FollowOffer';

  // Si l'adresse from est un domaine personnalisé vérifié (pas gmail/hotmail/icloud etc.)
  const isPersonalDomain = from && !/(gmail|hotmail|yahoo|icloud|outlook|live|msn|me\.com)\./i.test(from);

  const senderEmail = isPersonalDomain ? from : VERIFIED_SENDER;
  const senderName = isPersonalDomain ? (fromName || from) : `${fromName || 'FollowOffer'} via FollowOffer`;

  try {
    const payload = {
      sender: { name: senderName, email: senderEmail },
      to: [{ name: toName || to, email: to }],
      replyTo: { email: from, name: fromName || from }, // Réponses → vraie adresse utilisateur
      subject,
      textContent: body,
      htmlContent: htmlBody || `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333;">${(body||'').replace(/\n/g,'<br>')}</div>`,
    };

    // Ajouter la pièce jointe PDF
    if (pdfUrl && pdfName) {
      try {
        const pdfResp = await fetch(pdfUrl);
        if (pdfResp.ok) {
          const pdfBuffer = await pdfResp.arrayBuffer();
          payload.attachment = [{ name: pdfName, content: Buffer.from(pdfBuffer).toString('base64') }];
        }
      } catch (e) { console.warn('PDF attach failed:', e.message); }
    }

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY, 'accept': 'application/json' },
      body: JSON.stringify(payload)
    });

    const brevoData = await brevoRes.json();
    if (!brevoRes.ok) {
      console.error('Brevo error:', brevoData);
      return res.status(brevoRes.status).json({ error: brevoData.message || 'Erreur Brevo', details: brevoData });
    }

    return res.status(200).json({ success: true, messageId: brevoData.messageId, sender: senderEmail });
  } catch (e) {
    console.error('send-email error:', e);
    return res.status(500).json({ error: e.message });
  }
};
