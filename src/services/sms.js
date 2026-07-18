import { Buffer } from 'buffer';
import { normalizePhoneNumber } from '../utils/phone.js';

/**
 * Sends an SMS message to a phone number using SMS Aero API.
 * Formats the phone number to E.164 international format without the "+" prefix.
 * 
 * @param {string} phone - Recipient phone number
 * @param {string} text - Message content
 * @returns {Promise<Object>} SMS Aero API response or mock indicator
 */
export async function sendSMS(phone, text) {
  const email = process.env.SMS_AERO_EMAIL;
  const apiKey = process.env.SMS_AERO_API_KEY;
  const sign = process.env.SMS_AERO_SIGN || 'SMS Aero';
  const baseUrl = process.env.SMS_AERO_BASE_URL || 'https://gate.smsaero.ru/v2';

  if (!email || !apiKey) {
    console.warn('[SMS] SMS Aero email or API key is not configured in environment variables.');
    console.log(`[SMS MOCK] To: ${phone}, Text: "${text}"`);
    return { success: true, mock: true };
  }

  // Format phone using normalization utility
  const formattedPhone = normalizePhoneNumber(phone);

  const auth = Buffer.from(`${email}:${apiKey}`).toString('base64');
  
  try {
    const response = await fetch(`${baseUrl}/sms/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: formattedPhone,
        text,
        sign,
      }),
    });

    const result = await response.json();
    if (!response.ok || !result.success) {
      console.error('[SMS Error]', result);
      throw new Error(result.message || `SMS Aero API returned status ${response.status}`);
    }

    return result;
  } catch (error) {
    console.error('[SMS Exception]', error);
    throw error;
  }
}
