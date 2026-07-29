import {
  BOT_TOKEN, DEVICE_RE, deviceKey, escapeHtml, json, parseBody, rateLimit,
  requestIp, requireRedis, safeEqual, sendMessage, setCors,
} from '../lib/core.js';
import {
  EVENT_RETENTION_SECONDS, alertEligible, classifyIntegrity, cleanIntegrityPayload,
  ingestKey, integrityConfig, integrityConfigErrors, integrityEventKey,
  releaseAlert, reserveAlert, sourceFingerprint,
} from '../lib/integrity.js';

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function cleanLocationPart(value, maxLength) {
  const first = Array.isArray(value) ? value[0] : value;
  let text = String(first || '').trim();
  if (!text) return '';
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the original value if an upstream header is not URI encoded correctly.
  }
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function requestLocation(req) {
  const country = cleanLocationPart(req.headers['x-vercel-ip-country'], 2).toUpperCase();
  const region = cleanLocationPart(req.headers['x-vercel-ip-country-region'], 64);
  const city = cleanLocationPart(req.headers['x-vercel-ip-city'], 96);
  return {
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
  };
}

function alertText(record, payload, reasons, location) {
  const user = record.telegramUsername || record.telegramUserId;
  const locationText = [location.city, location.region, location.country]
    .filter(Boolean).join(', ') || 'Unknown';
  return [
    '🚨 <b>DramaDrop integrity anomaly</b>',
    'Warning signal only — not proof of cracking.',
    `Device: <code>${escapeHtml(record.deviceId.slice(0, 10))}…</code>`,
    `Telegram: <code>${escapeHtml(user)}</code>`,
    `Approx. location: <code>${escapeHtml(locationText)}</code>`,
    `Version: <code>${escapeHtml(payload.appVersion || '?')}</code>`,
    `Release: <code>${escapeHtml((payload.releaseId || 'missing').slice(0, 16))}…</code>`,
    `Reason: <code>${escapeHtml([...new Set(reasons)].sort().join(', '))}</code>`,
  ].join('\n');
}

export default async function handler(req, res) {
  setCors(res, 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  const config = integrityConfig();
  if (integrityConfigErrors(config).length || !BOT_TOKEN) {
    return json(res, 503, { error: 'integrity service not configured' });
  }

  try {
    const redis = requireRedis();
    if (!await rateLimit('integrity', requestIp(req), 120, 60)) {
      return json(res, 429, { error: 'too many requests' });
    }
    const body = parseBody(req);
    const deviceId = String(body.device_id || '');
    if (!DEVICE_RE.test(deviceId)) return json(res, 400, { error: 'invalid device_id' });

    const raw = await redis.get(deviceKey(deviceId));
    const record = raw ? JSON.parse(raw) : null;
    if (!record || !safeEqual(record.deviceToken, bearerToken(req))) {
      return json(res, 401, { error: 'invalid device credentials' });
    }

    const payload = cleanIntegrityPayload(body);
    const throttleKey = ingestKey(deviceId, payload.event);
    const accepted = await redis.set(throttleKey, '1', 'EX', 60, 'NX');
    if (accepted !== 'OK') {
      return json(res, 200, { ok: true, next_check_seconds: 300 });
    }

    const { severity, reasons } = classifyIntegrity(payload, config);
    const location = requestLocation(req);
    const now = Date.now();
    const event = {
      deviceId,
      eventType: payload.event,
      severity,
      appVersion: payload.appVersion,
      buildHash: payload.buildHash,
      details: {
        releaseId: payload.releaseId,
        runtimeHash: payload.runtimeHash,
        frozen: payload.frozen,
        pyarmor: payload.pyarmor,
        engineVersion: payload.engineVersion,
        platform: payload.platform,
        ...(reasons.length ? {
          reasons: [...new Set(reasons)].sort(),
          ...(Object.keys(location).length ? { location } : {}),
        } : {}),
      },
      sourceFingerprint: sourceFingerprint(requestIp(req), config.hmacKey),
      createdAt: Math.floor(now / 1000),
    };
    try {
      await redis.set(
        integrityEventKey(deviceId, now),
        JSON.stringify(event),
        'EX',
        EVENT_RETENTION_SECONDS,
      );
    } catch (error) {
      await redis.del(throttleKey).catch(() => {});
      throw error;
    }

    const mayAlert = alertEligible(record, reasons);
    if (mayAlert && await reserveAlert(redis, deviceId, reasons, config, now)) {
      try {
        await sendMessage(config.adminChatId, alertText(record, payload, reasons, location));
      } catch (error) {
        await releaseAlert(redis, deviceId, reasons, now).catch(() => {});
        console.error('Integrity alert delivery failed:', error?.message || 'unknown error');
      }
    }

    return json(res, 200, { ok: true, next_check_seconds: 300 });
  } catch (error) {
    console.error('Integrity ingest failed:', error?.message || 'unknown error');
    return json(res, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof SyntaxError ? 'invalid JSON' : 'server error',
    });
  }
}
