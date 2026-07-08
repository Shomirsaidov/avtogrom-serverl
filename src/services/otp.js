const otpCache = new Map(); // phone -> { code, expiresAt, attempts }

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

/**
 * Generates a 6-digit OTP code and stores it in-memory.
 * 
 * @param {string} phone - Recipient phone number
 * @returns {string} The generated 6-digit OTP code
 */
export function generateOTP(phone) {
  // Normalize phone number to base digit sequence
  const normalizedPhone = phone.replace(/[^0-9]/g, '');
  
  // Generate 6-digit numeric code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;
  
  otpCache.set(normalizedPhone, {
    code,
    expiresAt,
    attempts: 0,
  });

  return code;
}

/**
 * Verifies the OTP code for a phone number.
 * 
 * @param {string} phone - Recipient phone number
 * @param {string} code - The input verification code
 * @returns {Object} Object indicating success or failure message
 */
export function verifyOTP(phone, code) {
  const normalizedPhone = phone.replace(/[^0-9]/g, '');
  const record = otpCache.get(normalizedPhone);
  
  if (!record) {
    return { valid: false, message: 'Код не отправлен или устарел' };
  }

  if (Date.now() > record.expiresAt) {
    otpCache.delete(normalizedPhone);
    return { valid: false, message: 'Срок действия кода истек' };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpCache.delete(normalizedPhone);
    return { valid: false, message: 'Превышено максимальное количество попыток' };
  }

  record.attempts += 1;

  if (record.code !== code) {
    return { valid: false, message: 'Неверный код подтверждения' };
  }

  // Verification successful, delete code from cache
  otpCache.delete(normalizedPhone);
  return { valid: true };
}
