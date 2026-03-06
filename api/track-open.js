const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
  const { id } = req.query;
  if (id) {
    try {
      const { data: offre } = await supabase.from('offres').select('opens').eq('id', id).single();
      if (offre) {
        await supabase.from('offres').update({ opens: (offre.opens||0)+1, last_open: new Date().toISOString() }).eq('id', id);
        await supabase.from('ouvertures').insert({ offre_id: id, opened_at: new Date().toISOString(), ip: req.headers['x-forwarded-for'], user_agent: req.headers['user-agent'] });
      }
    } catch(e) {}
  }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  res.setHeader('Content-Type','image/gif');
  res.setHeader('Cache-Control','no-store,no-cache');
  res.end(pixel);
};
