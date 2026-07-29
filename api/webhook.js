import {
  CHANNEL_URL, DEVICE_TTL, DRAMA_CODE_RE, WEBHOOK_SECRET,
  checkMembership, codeKey, deviceKey, rateLimit, requireRedis,
  safeEqual, sendMessage,
} from '../lib/core.js';

async function processDouyin(redis, chatId, userId, code) {
  const membership = await checkMembership(userId);
  const status = membership.active ? 'verified' : 'pending';
  await redis.set(code, JSON.stringify({ status, userId }), 'EX', 86400);
  if (membership.active) {
    await sendMessage(chatId,
      '🎉 <b>ជោគជ័យ!</b> អ្នកបាន Join Channel រួចរាល់។\n\n' +
      '👉 សូមត្រឡប់ទៅ Douyin Saver ហើយចុច Check Status។');
  } else {
    await sendMessage(chatId,
      '👋 ដើម្បីប្រើ Douyin Saver សូម <a href="' + CHANNEL_URL +
      '">Join VMedia Channel</a> ជាមុន ហើយត្រឡប់ទៅ app ដើម្បី Check Status។');
  }
}

async function processDramaDrop(redis, chatId, user, code) {
  const id = await redis.get(codeKey(code));
  if (!id) {
    await sendMessage(chatId, 'Activation code មិនត្រឹមត្រូវ ឬផុតកំណត់។');
    return;
  }
  const raw = await redis.get(deviceKey(id));
  const record = raw ? JSON.parse(raw) : null;
  if (!record || record.activationCode !== code) {
    await sendMessage(chatId, 'Activation code មិនត្រឹមត្រូវ ឬផុតកំណត់។');
    return;
  }
  if (record.telegramUserId && String(record.telegramUserId) !== String(user.id)) {
    await sendMessage(chatId, 'Activation code នេះបានភ្ជាប់ជាមួយ Telegram ផ្សេងរួចហើយ។');
    return;
  }

  const membership = await checkMembership(user.id);
  const now = Math.floor(Date.now() / 1000);
  record.telegramUserId = String(user.id);
  record.telegramUsername = String(user.username || '').slice(0, 64);
  record.linkedAt = record.linkedAt || now;
  record.telegramStatus = membership.status;
  if (membership.active && !record.activatedAt) record.activatedAt = now;
  await redis.set(deviceKey(id), JSON.stringify(record), 'EX', DEVICE_TTL);
  await redis.expire(codeKey(code), DEVICE_TTL);

  if (membership.active) {
    await sendMessage(chatId,
      '✅ <b>DramaDrop Activated</b>\nអ្នកបាន Join channel រួច។ ' +
      'សូមត្រឡប់ទៅ app ហើយចុច Check Again។');
  } else {
    await sendMessage(chatId,
      '🔒 មិនទាន់ Active ទេ។ សូម <a href="' + CHANNEL_URL +
      '">Join @vmediabythy</a> ហើយចុច Check Again ក្នុង app។');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  const supplied = req.headers['x-telegram-bot-api-secret-token'];
  if (!safeEqual(WEBHOOK_SECRET, supplied)) return res.status(403).send('Forbidden');
  try {
    const message = req.body?.message;
    if (!message?.chat?.id || !message?.from?.id) return res.status(200).send('OK');
    const match = String(message.text || '').match(/^\/start(?:@\w+)?(?:\s+([^\s]+))?/i);
    if (!match) return res.status(200).send('OK');
    const redis = requireRedis();
    const chatId = message.chat.id;
    const user = message.from;
    if (!await rateLimit('webhook-user', String(user.id), 20, 60)) {
      return res.status(200).send('OK');
    }
    const code = String(match[1] || '').trim().toUpperCase();
    if (!code) {
      await sendMessage(chatId,
        'សូមបើក bot តាមប៊ូតុង Activate ឬ Check Status ក្នុងកម្មវិធី។');
    } else if (/^\d{6}$/.test(code)) {
      await processDouyin(redis, chatId, user.id, code);
    } else if (DRAMA_CODE_RE.test(code)) {
      await processDramaDrop(redis, chatId, user, code);
    } else {
      await sendMessage(chatId, 'Activation code មិនត្រឹមត្រូវ។');
    }
  } catch (error) {
    console.error('Webhook processing failed:', error?.message || 'unknown error');
  }
  return res.status(200).send('OK');
}
