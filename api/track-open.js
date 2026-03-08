// api/track-open.js — Pixel de tracking ouverture email
const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Pixel GIF 1x1 transparent
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

module.exports = async (req, res) => {
  // Toujours renvoyer le pixel immédiatement
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const { id } = req.query;

  if (id && SB_URL && SB_KEY) {
    try {
      const supabase = createClient(SB_URL, SB_KEY);

      // Insérer une ouverture
      await supabase.from('ouvertures').insert({
        offre_id: id,
        opened_at: new Date().toISOString(),
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
        user_agent: req.headers['user-agent'] || null
      });
    } catch (e) {
      // Silencieux — on renvoie le pixel quoi qu'il arrive
      console.error('Track-open error:', e.message);
    }
  }

  res.status(200).end(PIXEL);
};
