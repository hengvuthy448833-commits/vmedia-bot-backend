import { kv } from '@vercel/kv';
import axios from 'axios';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const update = req.body;
    if (!update.message) {
      return res.status(200).send('OK');
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text || '';

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const sessionCode = parts.length > 1 ? parts[1].trim() : '';

      if (sessionCode === '') {
        await sendMessage(chatId, "សូមបើកកម្មវិធីទូរស័ព្ទរបស់អ្នក រួចចុចប៊ូតុងផ្ទៀងផ្ទាត់ ដើម្បីចូលទៅកាន់ Bot នេះ។");
        return res.status(200).send('OK');
      }

      // Check channel membership
      const isMember = await checkChannelMembership(userId);
      if (isMember) {
        // Save verification state in KV (lasts for 10 minutes)
        await kv.set(sessionCode, 'verified', { ex: 600 });
        await sendMessage(chatId, "🎉 <b>ជោគជ័យ!</b> ប្អូនបានចូលរួមក្នុង Channel រួចរាល់ហើយ។\n\n👉 សូមត្រឡប់ទៅកាន់កម្មវិធីទូរស័ព្ទវិញ វានឹងបើកដំណើរការដោយស្វ័យប្រវត្តិ។");
      } else {
        await kv.set(sessionCode, 'pending', { ex: 600 });
        await sendMessage(chatId, "⚠️ <b>ផ្ទៀងផ្ទាត់បរាជ័យ!</b> ប្អូនមិនទាន់បានចូលរួមក្នុង Channel របស់យើងនៅឡើយទេ។\n\nសូមចុចចូលរួមតាម Link ខាងក្រោម រួចត្រឡប់មកទីនេះចុច /start ម្តងទៀត៖\n👉 <a href=\"https://t.me/vmediabythy\">Join VMedia Channel</a>");
      }
    }
  } catch (error) {
    console.error('Error in webhook:', error);
  }

  return res.status(200).send('OK');
}

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

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chatId.toString(),
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error('Error sending message:', err.message);
  }
}
