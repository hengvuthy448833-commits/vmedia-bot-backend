import {
  checkMembership, json, rateLimit, requestIp, requireRedis, setCors,
} from '../lib/core.js';

export default async function handler(req, res) {
  setCors(res, 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
  try {
    const redis = requireRedis();
    if (!await rateLimit('douyin-check', requestIp(req), 120, 60)) {
      return json(res, 429, { error: 'Too many requests' });
    }
    const { action, code, userId } = req.query;
    if (action === 'check_membership' && /^\d+$/.test(String(userId || ''))) {
      const membership = await checkMembership(userId);
      return json(res, 200, { isMember: membership.active });
    }
    if (action !== 'check' || !/^\d{6}$/.test(String(code || ''))) {
      return json(res, 400, { error: 'Invalid parameters' });
    }
    const dataStr = await redis.get(code);
    if (!dataStr) return json(res, 200, { status: 'pending' });
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return json(res, 200, {
        status: dataStr === 'verified' ? 'verified' : 'pending',
      });
    }
    if (typeof data === 'string') {
      return json(res, 200, {
        status: data === 'verified' ? 'verified' : 'pending',
      });
    }
    if (!data.userId) {
      return json(res, 200, { status: data.status === 'verified' ? 'verified' : 'pending' });
    }
    const membership = await checkMembership(data.userId);
    const status = membership.active ? 'verified' : 'pending';
    await redis.set(code, JSON.stringify({ status, userId: data.userId }), 'EX', 86400);
    return json(res, 200, { status });
  } catch (error) {
    console.error('Douyin check failed:', error?.message || 'unknown error');
    const telegramError = String(error?.message || '').startsWith('telegram_');
    return json(res, telegramError ? 502 : 500, {
      error: telegramError ? 'Telegram membership check failed' : 'Database error',
    });
  }
}
