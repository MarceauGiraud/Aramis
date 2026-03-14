/**
 * Strip HTML tags from a string, trim whitespace, and enforce max length.
 */
export function sanitizeString(input: string, maxLength: number = 10000): string {
  if (typeof input !== 'string') return '';
  // Remove HTML tags
  let sanitized = input.replace(/<[^>]*>/g, '');
  // Trim whitespace
  sanitized = sanitized.trim();
  // Enforce max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  return sanitized;
}

/**
 * Sanitization rules for an object's properties.
 */
export interface SanitizationRule {
  maxLength?: number;
  stripHtml?: boolean;
  trim?: boolean;
}

/**
 * Apply sanitization rules to an object's string properties.
 * Only processes keys present in the rules map.
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  rules: Record<string, SanitizationRule>
): T {
  const result = { ...obj };
  for (const [key, rule] of Object.entries(rules)) {
    if (key in result && typeof result[key] === 'string') {
      let value = result[key] as string;
      if (rule.stripHtml !== false) {
        value = value.replace(/<[^>]*>/g, '');
      }
      if (rule.trim !== false) {
        value = value.trim();
      }
      if (rule.maxLength && value.length > rule.maxLength) {
        value = value.substring(0, rule.maxLength);
      }
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
