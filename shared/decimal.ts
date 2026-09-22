export const WEIGHT_SCALE = 1_000_000n;

export function parseFixedDecimal(value: string, scale = 6): bigint {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`Expected a nonnegative decimal, received "${value}"`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > scale) {
    throw new Error(`Decimal has more than ${scale} places`);
  }
  const padded = fraction.padEnd(scale, '0');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(padded || '0');
}

export function formatFixedDecimal(value: bigint, scale = 6): string {
  const factor = 10n ** BigInt(scale);
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseMinorUnits(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error('Budget must be a nonnegative integer in minor units');
  return BigInt(text);
}

export function formatMinorUnits(value: bigint, precision: number): string {
  return formatFixedDecimal(value, precision);
}

function commaThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Format exact minor units for people: commas group thousands and a period marks decimals. */
export function formatDisplayMinorUnits(value: bigint, precision = 6): string {
  const formatted = formatFixedDecimal(value, precision);
  const [whole = '0', fraction] = formatted.split('.');
  return fraction ? `${commaThousands(whole)}.${fraction}` : commaThousands(whole);
}

/** Normalize a number while it is being typed, keeping one decimal point and live thousands separators. */
export function formatAmountInput(value: string, precision = 6): string {
  const sanitized = value.replace(/[^\d.,]/g, '');
  const decimalIndex = sanitized.indexOf('.');
  const hasDecimalPoint = decimalIndex >= 0;
  const integerSource = (hasDecimalPoint ? sanitized.slice(0, decimalIndex) : sanitized).replace(/,/g, '');
  const fractionSource = hasDecimalPoint ? sanitized.slice(decimalIndex + 1).replace(/\./g, '') : '';
  const integer = integerSource.replace(/^0+(?=\d)/, '') || (hasDecimalPoint ? '0' : '');
  if (!integer && !hasDecimalPoint) return '';
  const groupedInteger = commaThousands(integer || '0');
  const fraction = fractionSource.slice(0, precision);
  return `${groupedInteger}${hasDecimalPoint ? `.${fraction}` : ''}`;
}

/** Parse a human amount such as `10,000.50` into exact integer minor units. */
export function parseDisplayMinorUnits(value: string, precision = 6): bigint {
  const trimmed = value.trim();
  const grouping = new RegExp(`^\\d{1,3}(?:,\\d{3})+(?:\\.\\d{0,${precision}})?$`);
  const plain = new RegExp(`^\\d+(?:\\.\\d{0,${precision}})?$`);
  if (!plain.test(trimmed) && !grouping.test(trimmed)) {
    throw new Error(`Enter an amount like 10,000.50 with no more than ${precision} decimal places`);
  }
  const normalized = trimmed.replace(/,/g, '');
  const [whole = '0', fraction = ''] = normalized.split('.');
  const factor = 10n ** BigInt(precision);
  return BigInt(whole) * factor + BigInt(fraction.padEnd(precision, '0') || '0');
}
