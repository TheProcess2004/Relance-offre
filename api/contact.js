module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, company, email, subject, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return res.status(500).json({ error: 'Configuration email manquante' });
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: 'FollowOffer Contact', email: 'noreply@followoffer.com' },
        to: [{ email: 'contact@followoffer.com', name: 'FollowOffer' }],
        replyTo: { email: email, name: name },
        subject: subject || `Message depuis followoffer.com — ${name}`,
        htmlContent: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#1555A8;">Nouveau message — followoffer.com</h2>
            <table style="border-collapse:collapse;width:100%;">
              <tr><td style="padding:8px;color:#666;width:120px;"><b>Nom</b></td><td style="padding:8px;">${name}</td></tr>
              ${company ? `<tr><td style="padding:8px;color:#666;"><b>Entreprise</b></td><td style="padding:8px;">${company}</td></tr>` : ''}
              <tr><td style="padding:8px;color:#666;"><b>Email</b></td><td style="padding:8px;"><a href="mailto:${email}">${email}</a></td></tr>
              ${subject ? `<tr><td style="padding:8px;color:#666;"><b>Sujet</b></td><td style="padding:8px;">${subject}</td></tr>` : ''}
            </table>
            <div style="margin-top:20px;padding:16px;background:#f8f9fb;border-radius:8px;border-left:3px solid #1555A8;">
              <b style="color:#666;">Message :</b>
              <p style="margin-top:8px;line-height:1.6;">${message.replace(/\n/g, '<br>')}</p>
            </div>
            <p style="margin-top:20px;font-size:12px;color:#999;">
              Envoyé depuis followoffer.com · Répondre directement à cet email pour contacter ${name}
            </p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Brevo error:', err);
      return res.status(500).json({ error: 'Erreur envoi email' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('contact.js error:', err);
    return res.status(500).json({ error: err.message });
  }
};
