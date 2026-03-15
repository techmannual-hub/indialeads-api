/**
 * Normalizes phone numbers to E.164 format (+91XXXXXXXXXX for India).
 * Handles messy input: spaces, dashes, country code variations.
 */
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;

  // Strip everything except digits and leading +
  let cleaned = String(raw).replace(/[^\d+]/g, '').trim();

  // Remove leading zeros
  cleaned = cleaned.replace(/^0+/, '');

  // Already has country code with +
  if (cleaned.startsWith('+')) {
    // Validate length (international numbers: 7-15 digits after +)
    const digits = cleaned.slice(1);
    if (digits.length >= 7 && digits.length <= 15) {
      return cleaned;
    }
    return null;
  }

  // Indian number without country code: 10 digits starting with 6-9
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }

  // Already has 91 prefix (12 digits)
  if (/^91[6-9]\d{9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }

  return null;
}

/**
 * Strips the + and returns just digits.
 * Used for WhatsApp API calls which need plain number.
 */
export function phoneToWaFormat(phone: string): string {
  return phone.replace(/^\+/, '');
}

export function isValidPhone(phone: string): boolean {
  return normalizePhone(phone) !== null;
}
