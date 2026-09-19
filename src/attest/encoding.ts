const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBufferSource(data)));
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function bytesToBase64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64ToBytes(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function base64urlToBytes(value: string): Uint8Array {
  return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/'));
}

/**
 * Decode Apple/iOS payloads that may arrive as either standard Base64 or Base64URL.
 */
export function decodeFlexibleBase64(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('empty base64 payload');
  }
  if (trimmed.includes('-') || trimmed.includes('_') || BASE64URL_RE.test(trimmed)) {
    try {
      return base64urlToBytes(trimmed);
    } catch {
      // Fall through to standard base64.
    }
  }
  if (BASE64_RE.test(trimmed) || trimmed.includes('+') || trimmed.includes('/')) {
    return base64ToBytes(trimmed);
  }
  return base64urlToBytes(trimmed);
}

export function normalizeKeyId(keyId: string): string {
  const bytes = decodeFlexibleBase64(keyId.trim());
  if (bytes.length !== 32) {
    throw new Error('keyId must decode to 32 bytes');
  }
  return bytesToBase64url(bytes);
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
