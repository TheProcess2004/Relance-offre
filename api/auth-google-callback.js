// api/auth-google-callback.js — OfferFlow V4
// Reçoit le code OAuth Google, échange contre un access_token, renvoie au parent

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`<script>window.opener?.postMessage({type:'GMAIL_ERROR',error:'${error||"cancelled"}'},'*');window.close();</script>`);
  }

  try {
    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/auth-google-callback`,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenResp.json();
    if (!tokens.access_token) throw new Error('No access token received');

    // Get user email
    const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const profile = await profileResp.json();

    // Return to opener window
    res.status(200).send(`
      <html><body>
      <script>
        window.opener?.postMessage({
          type: 'GMAIL_CONNECTED',
          email: '${profile.email}',
          token: '${tokens.access_token}',
          refreshToken: '${tokens.refresh_token || ''}'
        }, '*');
        document.body.innerHTML = '<p style="font-family:sans-serif;text-align:center;padding:40px;color:#22C55E;">✅ Gmail connecté — vous pouvez fermer cette fenêtre</p>';
        setTimeout(() => window.close(), 1500);
      </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<script>window.opener?.postMessage({type:'GMAIL_ERROR',error:'${err.message}'},'*');window.close();</script>`);
  }
}
