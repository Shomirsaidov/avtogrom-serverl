/**
 * Normalizes phone numbers to E.164 international format without the "+" prefix.
 * Handles Russian (7/8 prefix) and Tajik (992 prefix) formatting rules.
 * 
 * @param {string} phone - The raw phone number input
 * @returns {string} Normalized phone number containing only digits
 */
export function normalizePhoneNumber(phone) {
  if (!phone) return '';
  
  // Remove all non-digit characters
  let digits = phone.replace(/[^0-9]/g, '');
  
  // Russian/Kazakh numbers: if 11 digits starting with 8, replace 8 with 7
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.substring(1);
  }
  
  // Russian numbers: if 10 digits (e.g., 9261234567), prefix with 7
  if (digits.length === 10 && (digits.startsWith('9') || digits.startsWith('3') || digits.startsWith('4') || digits.startsWith('8'))) {
    digits = '7' + digits;
  }
  
  // Tajikistan numbers: if 9 digits (e.g., 929996999), prefix with 992
  if (digits.length === 9) {
    digits = '992' + digits;
  }
  
  return digits;
}
