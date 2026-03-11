module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email invalide' });
  }

  const BREVO_KEY    = process.env.BREVO_API_KEY;
  const SB_URL       = process.env.SUPABASE_URL;
  const SB_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const APP_URL      = 'https://followoffer.com';

  if (!BREVO_KEY) return res.status(500).json({ error: 'BREVO_API_KEY manquant' });
  if (!SB_KEY)    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquant' });

  try {
    // 1. Générer le lien de reset via Supabase Admin API
    const linkRes = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: 'recovery',
        email: email.toLowerCase().trim(),
        redirect_to: APP_URL + '/'
      })
    });

    const linkData = await linkRes.json();
    console.log('Supabase generate_link status:', linkRes.status);
    console.log('Supabase response keys:', Object.keys(linkData));

    // Supabase peut retourner action_link ou properties.action_link selon la version
    const actionLink = linkData.action_link 
      || linkData.properties?.action_link
      || null;

    if (!linkRes.ok || !actionLink) {
      console.error('generate_link failed:', JSON.stringify(linkData));
      // Retourner succès pour ne pas révéler si l email existe
      return res.status(200).json({ success: true });
    }

    console.log('Reset link generated for:', email);

    // 2. Envoyer via Brevo
    const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"></head>
<body style="font-family:Helvetica Neue,Arial,sans-serif;background:#f4f5f7;margin:0;padding:0;">
  <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
    <div style="background:#07080C;padding:28px 32px;text-align:center;">
      <div style="font-family:Georgia,serif;font-size:22px;color:#E9B84A;font-weight:bold;">Follow<span style="color:#4D90DC;">Offer</span></div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-top:4px;">Suite commerciale · Suisse</div>
    </div>
    <div style="padding:36px 32px;">
      <h1 style="font-size:20px;font-weight:700;color:#0F1728;margin:0 0 12px;">Réinitialisation du mot de passe</h1>
      <p style="font-size:14px;color:#4B5563;line-height:1.6;margin:0 0 24px;">
        Vous avez demandé à réinitialiser votre mot de passe FollowOffer.<br>
        Cliquez sur le bouton ci-dessous — ce lien expire dans <strong>1 heure</strong>.
      </p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${actionLink}" style="display:inline-block;background:#1555A8;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:700;">
          Réinitialiser mon mot de passe →
        </a>
      </div>
      <p style="font-size:12px;color:#9CA3AF;text-align:center;margin:16px 0 0;">
        Ce lien est valable 1 heure. Si vous n avez pas demandé cette réinitialisation, ignorez cet email.
      </p>
    </div>
    <div style="background:#F8F9FB;padding:16px 32px;text-align:center;border-top:1px solid #E5E7EB;">
      <p style="font-size:11px;color:#9CA3AF;margin:0;">
        FollowOffer · Neuchâtel, Suisse · 
        <a href="mailto:contact@followoffer.com" style="color:#1555A8;text-decoration:none;">contact@followoffer.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'FollowOffer', email: 'contact@followoffer.com' },
        to: [{ email: email.toLowerCase().trim() }],
        subject: 'Réinitialisation de votre mot de passe FollowOffer',
        htmlContent,
        textContent: `Réinitialisez votre mot de passe FollowOffer\n\n${actionLink}\n\nCe lien expire dans 1 heure.`
      })
    });

    if (!brevoRes.ok) {
      const err = await brevoRes.json().catch(() => ({}));
      console.error('Brevo error:', JSON.stringify(err));
      return res.status(500).json({ error: 'Erreur envoi email - ' + (err.message || brevoRes.status) });
    }

    console.log('Reset email sent to:', email);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('reset-password fatal error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
