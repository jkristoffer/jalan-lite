module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  if (!publicKey) return res.status(503).json({ error: 'Push notifications are not configured yet.' });

  return res.status(200).json({ publicKey });
};
