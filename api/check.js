import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action, code } = req.query;

  if (action === 'check' && code) {
    try {
      const status = await kv.get(code);
      return res.status(200).json({ status: status || 'pending' });
    } catch (err) {
      return res.status(500).json({ error: 'Database error: ' + err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid parameters' });
}
