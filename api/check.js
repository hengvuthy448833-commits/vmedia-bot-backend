import Redis from 'ioredis';
import axios from 'axios';

const redis = new Redis(process.env.REDIS_URL);
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME;

async function checkChannelMembership(userId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${CHANNEL_USERNAME}&user_id=${userId}`;
  try {
    const response = await axios.get(url);
    if (response.data.ok) {
      const status = response.data.result.status;
      return status === 'member' || status === 'administrator' || status === 'creator';
    }
  } catch (err) {
    console.error('Error checking membership:', err.message);
  }
  return false;
}

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

  if (action === 'debug') {
    return res.status(200).json({
      botTokenSet: !!process.env.BOT_TOKEN,
      botTokenPrefix: process.env.BOT_TOKEN ? process.env.BOT_TOKEN.substring(0, 8) : null,
      channelUsername: process.env.CHANNEL_USERNAME,
      redisUrlSet: !!process.env.REDIS_URL,
      redisUrlPrefix: process.env.REDIS_URL ? process.env.REDIS_URL.substring(0, 15) : null
    });
  }

  if (action === 'check' && code) {
    try {
      const dataStr = await redis.get(code);
      
      if (!dataStr) {
        return res.status(200).json({ status: 'pending' });
      }

      let data;
      try {
        data = JSON.parse(dataStr);
      } catch (e) {
        // Handle old legacy string status
        if (dataStr === 'verified') {
          return res.status(200).json({ status: 'verified' });
        }
        return res.status(200).json({ status: 'pending' });
      }

      if (typeof data === 'string') {
        if (data === 'verified') {
          return res.status(200).json({ status: 'verified' });
        }
        return res.status(200).json({ status: 'pending' });
      }

      // Handle new object status
      if (data.status === 'verified') {
        return res.status(200).json({ status: 'verified' });
      }

      if (data.status === 'pending' && data.userId) {
        const isMember = await checkChannelMembership(data.userId);
        if (isMember) {
          // Update KV to verified
          await redis.set(code, JSON.stringify({ status: 'verified', userId: data.userId }), 'EX', 600);
          return res.status(200).json({ status: 'verified' });
        }
      }

      return res.status(200).json({ status: 'pending' });
    } catch (err) {
      return res.status(500).json({ error: 'Database error: ' + err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid parameters' });
}
