import { kv } from '@vercel/kv';
import axios from 'axios';

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

  if (req.query.debug === 'env') {
    const keys = Object.keys(process.env).filter(key => 
      key.startsWith('KV') || key.startsWith('REDIS') || key.startsWith('UPSTASH')
    );
    return res.status(200).json({ env_keys: keys });
  }

  const { action, code } = req.query;

  if (action === 'check' && code) {
    try {
      const data = await kv.get(code);
      
      if (!data) {
        return res.status(200).json({ status: 'pending' });
      }

      // Handle old legacy string status
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
          await kv.set(code, { status: 'verified', userId: data.userId }, { ex: 600 });
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
