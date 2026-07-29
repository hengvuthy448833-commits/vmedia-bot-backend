import crypto from 'node:crypto';
import {
  BOT_USERNAME, CHANNEL_URL, DEVICE_RE, DEVICE_TTL, DRAMA_CODE_RE,
  codeKey, deviceKey, json, parseBody, rateLimit, requestIp, requireRedis,
} from '../lib/core.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 8 }, () =>
  alphabet[crypto.randomInt(alphabet.length)]).join('');

function responseFor(record) {
  return {
    device_token: record.deviceToken,
    activation_code: record.activationCode,
    bot_url: `https://telegram.me/${BOT_USERNAME}?start=${record.activationCode}`,
    channel_url: CHANNEL_URL,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const redis = requireRedis();
    if (!await rateLimit('register', requestIp(req), 10, 60)) {
      return json(res, 429, { error: 'too many requests' });
    }
    const body = parseBody(req);
    const deviceId = String(body.device_id || '');
    if (!DEVICE_RE.test(deviceId)) return json(res, 400, { error: 'invalid device_id' });

    const existingRaw = await redis.get(deviceKey(deviceId));
    if (existingRaw) {
      const existing = JSON.parse(existingRaw);
      await redis.expire(deviceKey(deviceId), DEVICE_TTL);
      await redis.expire(codeKey(existing.activationCode), DEVICE_TTL);
      return json(res, 200, responseFor(existing));
    }

    let record;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = makeCode();
      if (!DRAMA_CODE_RE.test(code)) continue;
      const reserved = await redis.set(codeKey(code), deviceId, 'EX', DEVICE_TTL, 'NX');
      if (reserved !== 'OK') continue;
      record = {
        deviceId,
        deviceToken: crypto.randomBytes(32).toString('base64url'),
        activationCode: code,
        appVersion: String(body.app_version || '').slice(0, 32),
        createdAt: Math.floor(Date.now() / 1000),
      };
      const created = await redis.set(
        deviceKey(deviceId), JSON.stringify(record), 'EX', DEVICE_TTL, 'NX');
      if (created === 'OK') break;
      await redis.del(codeKey(code));
      record = JSON.parse(await redis.get(deviceKey(deviceId)) || 'null');
      break;
    }
    if (!record) return json(res, 503, { error: 'could not allocate activation code' });
    return json(res, 200, responseFor(record));
  } catch (error) {
    console.error('DramaDrop register failed:', error?.message || 'unknown error');
    return json(res, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof SyntaxError ? 'invalid JSON' : 'server error',
    });
  }
}
