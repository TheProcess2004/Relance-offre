// api/send-email.js — OfferFlow V4
// Envoie un email depuis Gmail ou Outlook avec PDF en pièce jointe

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { provider, accessToken, from, fromName, to, toName, subject, body, pdfUrl, pdfName, signature } = req.body;

  if (!provider || !accessToken || !to || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Fetch PDF from Supabase Storage (if URL provided)
    let pdfBase64 = null;
    let pdfContentType = 'application/pdf';
    if (pdfUrl) {
      try {
        const pdfResp = await fetch(pdfUrl);
        if (pdfResp.ok) {
          const buffer = await pdfResp.arrayBuffer();
          pdfBase64 = Buffer.from(buffer).toString('base64');
        }
      } catch (e) {
        console.warn('PDF fetch failed:', e.message);
      }
    }

    const fullBody = body + (signature || '');

    if (provider === 'gmail') {
      await sendViaGmail({ accessToken, from, fromName, to, toName, subject, body: fullBody, pdfBase64, pdfName });
    } else if (provider === 'outlook') {
      await sendViaOutlook({ accessToken, from, fromName, to, toName, subject, body: fullBody, pdfBase64, pdfName });
    } else {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Send email error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── GMAIL ──────────────────────────────────────────────────────────────────
async function sendViaGmail({ accessToken, from, fromName, to, toName, subject, body, pdfBase64, pdfName }) {
  const boundary = 'OfferFlow_' + Date.now();
  const senderDisplay = fromName ? `"${fromName}" <${from}>` : from;
  const recipientDisplay = toName ? `"${toName}" <${to}>` : to;

  let raw;
  if (pdfBase64) {
    // Multipart with PDF attachment
    raw = [
      `From: ${senderDisplay}`,
      `To: ${recipientDisplay}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      body,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${pdfName || 'offre.pdf'}"`,
      ``,
      pdfBase64,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    raw = [
      `From: ${senderDisplay}`,
      `To: ${recipientDisplay}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      body,
    ].join('\r\n');
  }

  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail API error: ${err}`);
  }
}

// ── OUTLOOK ────────────────────────────────────────────────────────────────
async function sendViaOutlook({ accessToken, from, fromName, to, toName, subject, body, pdfBase64, pdfName }) {
  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to, name: toName || to } }],
    from: { emailAddress: { address: from, name: fromName || from } },
  };

  if (pdfBase64) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: pdfName || 'offre.pdf',
      contentType: 'application/pdf',
      contentBytes: pdfBase64,
    }];
  }

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Microsoft Graph API error: ${err}`);
  }
}
