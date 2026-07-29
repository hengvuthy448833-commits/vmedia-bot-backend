import crypto from 'node:crypto';
import Redis from 'ioredis';

const redisUrl = (process.env.REDIS_URL || '').trim();
export const redis = redisUrl
  ? new Redis(redisUrl, {
      connectTimeout: 5000,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
    })
  : null;

// ioredis emits connection failures as events in addition to rejecting commands.
// Commands still surface their errors to callers; this prevents unhandled-event noise.
redis?.on('error', () => {});

export const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
export const BOT_USERNAME = (process.env.BOT_USERNAME || 'vmediabythy_bot')
  .trim().replace(/^@/, '');
const channel = (process.env.CHANNEL_USERNAME || '@vmediabythy').trim();
export const CHANNEL_ID = channel.startsWith('@') || channel.startsWith('-')
  ? channel
  : `@${channel}`;
export const CHANNEL_URL = process.env.CHANNEL_URL ||
  `https://telegram.me/${CHANNEL_ID.replace(/^@/, '')}`;
export const WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
export const DEVICE_TTL = 365 * 24 * 60 * 60;
export const DEVICE_RE = /^[a-fA-F0-9-]{24,128}$/;
export const DRAMA_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

export const deviceKey = (id) => `dramadrop:device:${id}`;
export const codeKey = (code) => `dramadrop:code:${code}`;

export function requireRedis() {
  if (!redis) throw new Error('server_not_configured');
  return redis;
}

export function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

export function setCors(res, methods = 'GET,POST,OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers',
    'Accept, Content-Type, Authorization, X-Requested-With');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

export async function rateLimit(scope, identifier, limit, seconds) {
  const r = requireRedis();
  const digest = crypto.createHash('sha256')
    .update(String(identifier || 'unknown')).digest('hex').slice(0, 24);
  const key = `vmedia:rate:${scope}:${digest}`;
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, seconds);
  return count <= limit;
}

export function parseBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body && typeof req.body === 'object' ? req.body : {};
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function telegramCall(method, payload) {
  if (!BOT_TOKEN) throw new Error('telegram_not_configured');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('telegram_unavailable');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('telegram_invalid_response');
  }
  if (!response.ok || !result.ok) throw new Error('telegram_request_failed');
  return result.result;
}

export async function checkMembership(userId) {
  const member = await telegramCall('getChatMember', {
    chat_id: CHANNEL_ID,
    user_id: String(userId),
  });
  const status = String(member?.status || 'left');
  const active = ['creator', 'administrator', 'member'].includes(status) ||
    (status === 'restricted' && member?.is_member === true);
  return { active, status };
}

export async function sendMessage(chatId, text) {
  return telegramCall('sendMessage', {
    chat_id: String(chatId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}
