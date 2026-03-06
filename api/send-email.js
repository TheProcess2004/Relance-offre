module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { from, fromName, to, toName, subject, body, htmlBody, pdfUrl, pdfName } = req.body;

  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) return res.status(500).json({ error: 'BREVO_API_KEY manquante' });
  if (!to) return res.status(400).json({ error: 'Destinataire manquant' });

  // TOUJOURS envoyer depuis contact@followoffer.com
  // L'adresse du commercial va en Reply-To
  const SENDER_EMAIL = 'contact@followoffer.com';
  const SENDER_NAME = fromName ? `${fromName} via FollowOffer` : 'FollowOffer';

  try {
    const payload = {
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ name: toName || to, email: to }],
      replyTo: { email: from || SENDER_EMAIL, name: fromName || 'FollowOffer' },
      subject,
      textContent: body,
      htmlContent: htmlBody || `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333;">${(body||'').replace(/\n/g,'<br>')}</div>`,
    };

    if (pdfUrl && pdfName) {
      try {
        const pdfResp = await fetch(pdfUrl);
        if (pdfResp.ok) {
          const buf = await pdfResp.arrayBuffer();
          payload.attachment = [{ name: pdfName, content: Buffer.from(buf).toString('base64') }];
        }
      } catch(e) { console.warn('PDF attach failed:', e.message); }
    }

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify(payload)
    });

    const data = await brevoRes.json();
    if (!brevoRes.ok) return res.status(brevoRes.status).json({ error: data.message || 'Erreur Brevo' });
    return res.status(200).json({ success: true, messageId: data.messageId });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
