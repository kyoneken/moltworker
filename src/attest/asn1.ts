export interface DerNode {
  tag: number;
  headerLength: number;
  bytes: Uint8Array;
  value: Uint8Array;
}

export function readDer(data: Uint8Array, offset = 0): { node: DerNode; next: number } {
  if (offset >= data.length) {
    throw new Error('truncated DER');
  }
  const tag = data[offset];
  let cursor = offset + 1;
  const firstLength = data[cursor++];
  let length: number;
  let headerLength: number;
  if (firstLength & 0x80) {
    const count = firstLength & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) {
      length = (length << 8) | data[cursor++];
    }
    headerLength = cursor - offset;
  } else {
    length = firstLength;
    headerLength = 2;
  }
  const end = cursor + length;
  if (end > data.length) {
    throw new Error('truncated DER value');
  }
  return {
    node: {
      tag,
      headerLength,
      bytes: data.slice(offset, end),
      value: data.slice(cursor, end),
    },
    next: end,
  };
}

export function derChildren(node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < node.value.length) {
    const { node: child, next } = readDer(node.value, offset);
    children.push(child);
    offset = next;
  }
  return children;
}

export function encodeLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }
  if (length < 0x100) {
    return Uint8Array.of(0x81, length);
  }
  if (length < 0x10000) {
    return Uint8Array.of(0x82, (length >> 8) & 0xff, length & 0xff);
  }
  return Uint8Array.of(0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

export function encodeTlv(tag: number, value: Uint8Array): Uint8Array {
  const length = encodeLength(value.length);
  const out = new Uint8Array(1 + length.length + value.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(value, 1 + length.length);
  return out;
}

export function encodeSequence(...parts: Uint8Array[]): Uint8Array {
  return encodeTlv(0x30, concatParts(parts));
}

export function encodeSet(...parts: Uint8Array[]): Uint8Array {
  return encodeTlv(0x31, concatParts(parts));
}

export function encodeOctetString(value: Uint8Array): Uint8Array {
  return encodeTlv(0x04, value);
}

export function encodeBitString(value: Uint8Array, unusedBits = 0): Uint8Array {
  const body = new Uint8Array(value.length + 1);
  body[0] = unusedBits;
  body.set(value, 1);
  return encodeTlv(0x03, body);
}

export function encodeIntegerBytes(value: Uint8Array): Uint8Array {
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) {
    bytes = bytes.slice(1);
  }
  if (bytes[0] & 0x80) {
    const prefixed = new Uint8Array(bytes.length + 1);
    prefixed.set(bytes, 1);
    bytes = prefixed;
  }
  return encodeTlv(0x02, bytes);
}

export function encodeIntegerNumber(value: number): Uint8Array {
  if (value === 0) {
    return encodeTlv(0x02, Uint8Array.of(0x00));
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return encodeIntegerBytes(Uint8Array.from(bytes));
}

export function encodeUtf8String(value: string): Uint8Array {
  return encodeTlv(0x0c, new TextEncoder().encode(value));
}

export function encodeOid(oid: string): Uint8Array {
  const parts = oid.split('.').map((part) => Number(part));
  const body: number[] = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack: number[] = [];
    let remaining = part;
    stack.push(remaining & 0x7f);
    remaining >>= 7;
    while (remaining > 0) {
      stack.push((remaining & 0x7f) | 0x80);
      remaining >>= 7;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      body.push(stack[i]);
    }
  }
  return encodeTlv(0x06, Uint8Array.from(body));
}

export function decodeOid(value: Uint8Array): string {
  if (value.length === 0) {
    throw new Error('empty OID');
  }
  const first = value[0];
  const parts = [Math.floor(first / 40), first % 40];
  let current = 0;
  for (let i = 1; i < value.length; i++) {
    current = (current << 7) | (value[i] & 0x7f);
    if ((value[i] & 0x80) === 0) {
      parts.push(current);
      current = 0;
    }
  }
  return parts.join('.');
}

export function contextTag(number: number, constructed: boolean): number {
  return (constructed ? 0xa0 : 0x80) | number;
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Convert DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to IEEE P1363 r||s.
 */
export function derEcdsaToRaw(der: Uint8Array, componentSize = 32): Uint8Array {
  const { node } = readDer(der, 0);
  if (node.tag !== 0x30) {
    throw new Error('ECDSA signature is not a SEQUENCE');
  }
  const [rNode, sNode] = derChildren(node);
  if (!rNode || !sNode || rNode.tag !== 0x02 || sNode.tag !== 0x02) {
    throw new Error('ECDSA signature missing r/s integers');
  }
  return concatParts([
    normalizeComponent(rNode.value, componentSize),
    normalizeComponent(sNode.value, componentSize),
  ]);
}

export function rawEcdsaToDer(raw: Uint8Array, componentSize = 32): Uint8Array {
  if (raw.length !== componentSize * 2) {
    throw new Error('raw ECDSA signature has unexpected length');
  }
  const r = encodeIntegerBytes(raw.slice(0, componentSize));
  const s = encodeIntegerBytes(raw.slice(componentSize));
  return encodeSequence(r, s);
}

function normalizeComponent(bytes: Uint8Array, componentSize: number): Uint8Array {
  let value = bytes;
  while (value.length > componentSize && value[0] === 0x00) {
    value = value.slice(1);
  }
  if (value.length > componentSize) {
    throw new Error(`ECDSA component too large: ${value.length}`);
  }
  if (value.length === componentSize) {
    return value;
  }
  const out = new Uint8Array(componentSize);
  out.set(value, componentSize - value.length);
  return out;
}

export function toRawEcdsaSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) {
    return signature;
  }
  if (signature[0] === 0x30) {
    return derEcdsaToRaw(signature);
  }
  throw new Error('unsupported ECDSA signature encoding');
}

export function findFirstOctetStringOfLength(node: DerNode, length: number): Uint8Array | null {
  if (node.tag === 0x04 && node.value.length === length) {
    return node.value;
  }
  if ((node.tag & 0x20) === 0x20) {
    for (const child of derChildren(node)) {
      const found = findFirstOctetStringOfLength(child, length);
      if (found) {
        return found;
      }
    }
  }
  return null;
}
