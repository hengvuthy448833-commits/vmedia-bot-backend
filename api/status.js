import {
  BOT_USERNAME, CHANNEL_URL, DEVICE_RE, DEVICE_TTL, checkMembership,
  codeKey, deviceKey, json, rateLimit, requestIp, requireRedis, safeEqual,
} from '../lib/core.js';

function publicStatus(record, extra = {}) {
  return {
    active: false,
    activation_code: record.activationCode,
    bot_url: `https://telegram.me/${BOT_USERNAME}?start=${record.activationCode}`,
    bot_username: BOT_USERNAME,
    channel_url: CHANNEL_URL,
    reason: 'telegram_not_linked',
    ...extra,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  try {
    const redis = requireRedis();
    if (!await rateLimit('status', requestIp(req), 90, 60)) {
      return json(res, 429, { error: 'too many requests' });
    }
    const deviceId = String(req.query.device_id || '');
    if (!DEVICE_RE.test(deviceId)) return json(res, 400, { error: 'invalid device_id' });
    const raw = await redis.get(deviceKey(deviceId));
    const record = raw ? JSON.parse(raw) : null;
    const authorization = String(req.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!record || !safeEqual(record.deviceToken, bearer)) {
      return json(res, 401, { error: 'invalid device credentials' });
    }
    if (!record.telegramUserId) {
      await redis.expire(deviceKey(deviceId), DEVICE_TTL);
      await redis.expire(codeKey(record.activationCode), DEVICE_TTL);
      return json(res, 200, publicStatus(record));
    }
    const membership = await checkMembership(record.telegramUserId);
    const now = Math.floor(Date.now() / 1000);
    record.lastCheckedAt = now;
    record.telegramStatus = membership.status;
    if (membership.active && !record.activatedAt) record.activatedAt = now;
    await redis.set(deviceKey(deviceId), JSON.stringify(record), 'EX', DEVICE_TTL);
    await redis.expire(codeKey(record.activationCode), DEVICE_TTL);
    return json(res, 200, publicStatus(record, {
      active: membership.active,
      reason: membership.active ? 'active' : membership.status,
      telegram_status: membership.status,
      telegram_username: record.telegramUsername || '',
      checked_at: now,
    }));
  } catch (error) {
    console.error('DramaDrop status failed:', error?.message || 'unknown error');
    const status = String(error?.message || '').startsWith('telegram_') ? 502 : 500;
    return json(res, status, {
      error: status === 502 ? 'membership check failed' : 'server error',
    });
  }
}
