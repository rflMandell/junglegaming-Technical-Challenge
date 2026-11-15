import { createHash } from 'crypto';

export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const pairs = sortedKeys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(record[k])}`);

  return '{' + pairs.join(',') + '}';
}

export function computePayloadHash(businessFields: Record<string, unknown>): string {
  const canonicalJson = canonicalJsonStringify(businessFields);
  return createHash('sha256').update(canonicalJson).digest('hex');
}
