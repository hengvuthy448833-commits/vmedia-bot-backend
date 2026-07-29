import { BOT_TOKEN, CHANNEL_ID, WEBHOOK_SECRET, json, requireRedis } from '../lib/core.js';
import {
  integrityConfig, integrityConfigErrors,
} from '../lib/integrity.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const config = integrityConfig();
  const configErrors = integrityConfigErrors(config);
  try {
    const redis = requireRedis();
    const redisOk = await redis.ping() === 'PONG';
    const telegramConfigured = Boolean(BOT_TOKEN && CHANNEL_ID && WEBHOOK_SECRET);
    const integrityReady = redisOk && telegramConfigured && configErrors.length === 0;
    return json(res, integrityReady ? 200 : 503, {
      ok: integrityReady,
      service: 'DramaDrop License',
      redis: redisOk,
      telegram_configured: telegramConfigured,
      integrity_ready: integrityReady,
      accepted_releases: config.expectedReleaseIds.size,
    });
  } catch {
    return json(res, 503, {
      ok: false,
      service: 'DramaDrop License',
      redis: false,
      telegram_configured: Boolean(BOT_TOKEN && CHANNEL_ID && WEBHOOK_SECRET),
      integrity_ready: false,
      accepted_releases: config.expectedReleaseIds.size,
    });
  }
}
