// api/auth-outlook-callback.js — OfferFlow V4
// Reçoit le code OAuth Microsoft, échange contre un access_token

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`<script>window.opener?.postMessage({type:'OUTLOOK_ERROR',error:'${error||"cancelled"}'},'*');window.close();</script>`);
  }

  try {
    const tokenResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        redirect_uri: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/auth-outlook-callback`,
        grant_type: 'authorization_code',
        scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access',
      }),
    });

    const tokens = await tokenResp.json();
    if (!tokens.access_token) throw new Error('No access token: ' + JSON.stringify(tokens));

    // Get user email via Microsoft Graph
    const profileResp = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const profile = await profileResp.json();
    const email = profile.mail || profile.userPrincipalName;

    res.status(200).send(`
      <html><body>
      <script>
        window.opener?.postMessage({
          type: 'OUTLOOK_CONNECTED',
          email: '${email}',
          token: '${tokens.access_token}',
          refreshToken: '${tokens.refresh_token || ''}'
        }, '*');
        document.body.innerHTML = '<p style="font-family:sans-serif;text-align:center;padding:40px;color:#38BDF8;">✅ Outlook connecté — vous pouvez fermer cette fenêtre</p>';
        setTimeout(() => window.close(), 1500);
      </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<script>window.opener?.postMessage({type:'OUTLOOK_ERROR',error:'${err.message}'},'*');window.close();</script>`);
  }
}
