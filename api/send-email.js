// api/send-email.js — Vercel Serverless Function
// Gère l'envoi d'emails via Brevo (Sendinblue)

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { provider, from, fromName, to, toName, subject, body, htmlBody, pdfUrl, pdfName } = req.body;

  // ── Brevo ──
  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) {
    return res.status(500).json({ error: 'BREVO_API_KEY manquante dans les variables Vercel' });
  }

  try {
    // Construire le payload Brevo
    const payload = {
      sender: { name: fromName || from, email: from },
      to: [{ name: toName || to, email: to }],
      subject,
      textContent: body,
      htmlContent: htmlBody || `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#333;">${(body||'').replace(/\n/g,'<br>')}</div>`,
    };

    // Ajouter la pièce jointe PDF si disponible
    if (pdfUrl && pdfName) {
      try {
        const pdfResp = await fetch(pdfUrl);
        if (pdfResp.ok) {
          const pdfBuffer = await pdfResp.arrayBuffer();
          const base64 = Buffer.from(pdfBuffer).toString('base64');
          payload.attachment = [{ name: pdfName, content: base64 }];
        }
      } catch (e) {
        console.warn('PDF attachment failed:', e.message);
        // Continue without attachment
      }
    }

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_KEY,
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const brevoData = await brevoRes.json();

    if (!brevoRes.ok) {
      console.error('Brevo error:', brevoData);
      return res.status(brevoRes.status).json({ 
        error: brevoData.message || 'Erreur Brevo',
        details: brevoData
      });
    }

    return res.status(200).json({ 
      success: true, 
      messageId: brevoData.messageId,
      provider: 'brevo'
    });

  } catch (e) {
    console.error('send-email error:', e);
    return res.status(500).json({ error: e.message });
  }
};
