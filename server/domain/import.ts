import { createHash } from 'node:crypto';
import { parseFixedDecimal, WEIGHT_SCALE } from '../../shared/decimal.ts';
import type { Chain, DuplicateGroup, ImportPreview, Recipient } from '../../shared/types.ts';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/i;
const DEFAULT_MAX_ROWS = 25_000;
const DEFAULT_MAX_BYTES = 10_000_000;

function configuredLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getImportLimits(): { maxRows: number; maxBytes: number } {
  return {
    maxRows: configuredLimit('MAX_CAMPAIGN_WALLETS', DEFAULT_MAX_ROWS),
    maxBytes: configuredLimit('MAX_UPLOAD_BYTES', DEFAULT_MAX_BYTES),
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Unclosed quoted CSV field');
  fields.push(field.trim());
  return fields;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function rowObject(headers: string[], fields: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));
}

/** Validate a Base CSV and retain enough row information to make duplicates explicit. */
export function validateImport(csv: string): ImportPreview {
  const limits = getImportLimits();
  if (Buffer.byteLength(csv, 'utf8') > limits.maxBytes)
    throw new Error(`CSV exceeds the ${Math.round(limits.maxBytes / 1_000_000)} MB upload limit`);
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length < 2) throw new Error('CSV must contain a header and at least one data row');
  const headers = parseCsvLine(lines[0] ?? '').map((header) => header.toLowerCase());
  if (!headers.includes('chain') || !headers.includes('address')) {
    throw new Error('CSV headers must include chain,address and may include weight');
  }
  if (lines.length - 1 > limits.maxRows) throw new Error(`CSV cannot contain more than ${limits.maxRows} recipients`);

  const issues: ImportPreview['issues'] = [];
  const rows: Array<Record<string, string>> = [];
  const recipients: Recipient[] = [];
  const addressRows = new Map<string, number[]>();
  for (let index = 1; index < lines.length; index += 1) {
    const sourceRow = index + 1;
    let fields: string[];
    try {
      fields = parseCsvLine(lines[index] ?? '');
    } catch (error) {
      issues.push({
        row: sourceRow,
        code: 'malformed_csv',
        message: error instanceof Error ? error.message : 'Malformed CSV',
      });
      continue;
    }
    const row = rowObject(headers, fields);
    rows.push(row);
    const chain = (row.chain ?? '').toLowerCase();
    const address = row.address ?? '';
    const normalizedAddress = normalizeAddress(address);
    if (chain !== 'base') {
      issues.push({ row: sourceRow, code: 'unsupported_chain', message: 'Only chain base is supported' });
    }
    if (!ADDRESS_PATTERN.test(address.trim())) {
      issues.push({ row: sourceRow, code: 'invalid_address', message: 'Expected a 20-byte EVM address' });
      continue;
    }
    if (chain !== 'base') continue;
    const weightText = row.weight?.trim() ? row.weight.trim() : '1';
    let weightUnits: bigint;
    try {
      weightUnits = parseFixedDecimal(weightText, 6);
    } catch (error) {
      issues.push({
        row: sourceRow,
        code: 'invalid_weight',
        message: error instanceof Error ? error.message : 'Invalid weight',
      });
      continue;
    }
    const recipient: Recipient = {
      id: `recipient-${sourceRow}`,
      sourceRow,
      chain: 'base' as Chain,
      address: address.trim(),
      normalizedAddress,
      weightUnits,
      weightText,
    };
    recipients.push(recipient);
    const duplicateRows = addressRows.get(normalizedAddress) ?? [];
    duplicateRows.push(sourceRow);
    addressRows.set(normalizedAddress, duplicateRows);
  }
  const duplicates: DuplicateGroup[] = [...addressRows.entries()]
    .filter(([, duplicateRows]) => duplicateRows.length > 1)
    .map(([normalizedAddress, duplicateRows]) => ({ normalizedAddress, rows: duplicateRows }));
  const totalWeightUnits = recipients.reduce((sum, recipient) => sum + recipient.weightUnits, 0n);
  if (recipients.length > 0 && totalWeightUnits === 0n) {
    issues.push({
      row: 0,
      code: 'all_zero_weights',
      message: 'At least one valid recipient must have positive weight',
    });
  }
  const inputHash = createHash('sha256').update(csv).digest('hex');
  return { headers, rows, recipients, issues, duplicates, totalWeightUnits, inputHash };
}

export function resolveDuplicates(preview: ImportPreview, policy: 'keep-first' | 'sum-weights'): Recipient[] {
  if (preview.issues.length > 0) throw new Error('Cannot confirm an import with validation issues');
  const chosen: Recipient[] = [];
  const seen = new Set<string>();
  for (const recipient of preview.recipients) {
    if (!seen.has(recipient.normalizedAddress)) {
      seen.add(recipient.normalizedAddress);
      chosen.push({ ...recipient });
      continue;
    }
    if (policy === 'sum-weights') {
      const first = chosen.find((candidate) => candidate.normalizedAddress === recipient.normalizedAddress);
      if (first) first.weightUnits += recipient.weightUnits;
    }
  }
  if (chosen.every((recipient) => recipient.weightUnits === 0n)) throw new Error('All resolved weights are zero');
  return chosen;
}

export const importLimits = {
  get MAX_ROWS() {
    return getImportLimits().maxRows;
  },
  get MAX_BYTES() {
    return getImportLimits().maxBytes;
  },
  WEIGHT_SCALE,
};
