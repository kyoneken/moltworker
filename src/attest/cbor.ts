export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | { [key: string]: CborValue };

function readLength(
  data: Uint8Array,
  offset: number,
  additional: number,
): { length: number; next: number } {
  if (additional < 24) {
    return { length: additional, next: offset };
  }
  if (additional === 24) {
    return { length: data[offset], next: offset + 1 };
  }
  if (additional === 25) {
    return { length: (data[offset] << 8) | data[offset + 1], next: offset + 2 };
  }
  if (additional === 26) {
    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    return { length: view.getUint32(0, false), next: offset + 4 };
  }
  throw new Error('unsupported CBOR length');
}

function decodeAt(data: Uint8Array, offset: number): { value: CborValue; next: number } {
  if (offset >= data.length) {
    throw new Error('truncated CBOR');
  }
  const initial = data[offset];
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let next = offset + 1;

  if (major === 0) {
    const length = readLength(data, next, additional);
    return { value: length.length, next: length.next };
  }
  if (major === 1) {
    const length = readLength(data, next, additional);
    return { value: -1 - length.length, next: length.next };
  }
  if (major === 2) {
    const length = readLength(data, next, additional);
    const end = length.next + length.length;
    return { value: data.slice(length.next, end), next: end };
  }
  if (major === 3) {
    const length = readLength(data, next, additional);
    const end = length.next + length.length;
    return { value: new TextDecoder().decode(data.slice(length.next, end)), next: end };
  }
  if (major === 4) {
    const length = readLength(data, next, additional);
    const items: CborValue[] = [];
    next = length.next;
    for (let i = 0; i < length.length; i++) {
      const item = decodeAt(data, next);
      items.push(item.value);
      next = item.next;
    }
    return { value: items, next };
  }
  if (major === 5) {
    const length = readLength(data, next, additional);
    const map: { [key: string]: CborValue } = {};
    next = length.next;
    for (let i = 0; i < length.length; i++) {
      const key = decodeAt(data, next);
      const value = decodeAt(data, key.next);
      if (typeof key.value !== 'string' && typeof key.value !== 'number') {
        throw new Error('unsupported CBOR map key');
      }
      map[String(key.value)] = value.value;
      next = value.next;
    }
    return { value: map, next };
  }
  if (major === 6) {
    const tag = readLength(data, next, additional);
    const inner = decodeAt(data, tag.next);
    return inner;
  }
  if (major === 7) {
    if (additional === 20) return { value: false, next };
    if (additional === 21) return { value: true, next };
    if (additional === 22) return { value: null, next };
    throw new Error('unsupported CBOR simple/float value');
  }
  throw new Error('unsupported CBOR major type');
}

export function decodeCbor(data: Uint8Array): CborValue {
  const decoded = decodeAt(data, 0);
  return decoded.value;
}

function encodeHead(major: number, length: number): Uint8Array {
  if (length < 24) {
    return Uint8Array.of((major << 5) | length);
  }
  if (length < 256) {
    return Uint8Array.of((major << 5) | 24, length);
  }
  if (length < 65536) {
    return Uint8Array.of((major << 5) | 25, (length >> 8) & 0xff, length & 0xff);
  }
  const bytes = new Uint8Array(5);
  bytes[0] = (major << 5) | 26;
  new DataView(bytes.buffer).setUint32(1, length, false);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeCbor(value: CborValue): Uint8Array {
  if (value === null) {
    return Uint8Array.of(0xf6);
  }
  if (typeof value === 'boolean') {
    return Uint8Array.of(value ? 0xf5 : 0xf4);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error('CBOR encoder only supports integers');
    }
    if (value >= 0) {
      return encodeHead(0, value);
    }
    return encodeHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concat([encodeHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concat([encodeHead(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => encodeCbor(item));
    return concat([encodeHead(4, value.length), ...items]);
  }
  if (typeof value === 'bigint') {
    throw new Error('CBOR encoder does not support bigint');
  }
  const map = value;
  const keys = Object.keys(map);
  const items: Uint8Array[] = [];
  for (const key of keys) {
    items.push(encodeCbor(key), encodeCbor(map[key]));
  }
  return concat([encodeHead(5, keys.length), ...items]);
}
