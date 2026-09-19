import {
  contextTag,
  derChildren,
  decodeOid,
  encodeBitString,
  encodeIntegerNumber,
  encodeOid,
  encodeOctetString,
  encodeSequence,
  encodeSet,
  encodeTlv,
  encodeUtf8String,
  findFirstOctetStringOfLength,
  rawEcdsaToDer,
  readDer,
  toRawEcdsaSignature,
} from './asn1';
import { asBufferSource, bytesEqual } from './encoding';
import { APPLE_NONCE_OID } from './config';

const ECDSA_WITH_SHA256_OID = '1.2.840.10045.4.3.2';
const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
const COMMON_NAME_OID = '2.5.4.3';
const EXTENSIONS_OID_CONTAINER = 3;

export interface ParsedCertificate {
  der: Uint8Array;
  tbs: Uint8Array;
  spki: Uint8Array;
  signature: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  extensions: Map<string, Uint8Array>;
}

export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const { node: cert } = readDer(der, 0);
  if (cert.tag !== 0x30) {
    throw new Error('certificate is not a SEQUENCE');
  }
  const [tbsNode, , signatureNode] = derChildren(cert);
  if (!tbsNode || !signatureNode) {
    throw new Error('certificate missing TBS or signature');
  }
  const tbsChildren = derChildren(tbsNode);
  const spki = findSpki(tbsChildren);
  const validity = findValidity(tbsChildren);
  const extensions = findExtensions(tbsChildren);
  const signature = decodeBitString(signatureNode.value);
  return {
    der,
    tbs: tbsNode.bytes,
    spki,
    signature,
    notBefore: validity.notBefore,
    notAfter: validity.notAfter,
    extensions,
  };
}

function findSpki(tbsChildren: ReturnType<typeof derChildren>): Uint8Array {
  for (const child of tbsChildren) {
    if (child.tag !== 0x30) {
      continue;
    }
    const inner = derChildren(child);
    if (inner.length >= 2 && inner[0].tag === 0x30 && inner[1].tag === 0x03) {
      const alg = derChildren(inner[0]);
      if (alg.length > 0 && alg[0].tag === 0x06 && decodeOid(alg[0].value) === EC_PUBLIC_KEY_OID) {
        return child.bytes;
      }
    }
  }
  throw new Error('certificate missing EC subjectPublicKeyInfo');
}

function findValidity(tbsChildren: ReturnType<typeof derChildren>): {
  notBefore: Date;
  notAfter: Date;
} {
  for (const child of tbsChildren) {
    if (child.tag !== 0x30) {
      continue;
    }
    const inner = derChildren(child);
    if (inner.length === 2 && isTimeTag(inner[0].tag) && isTimeTag(inner[1].tag)) {
      return {
        notBefore: parseTime(inner[0].tag, inner[0].value),
        notAfter: parseTime(inner[1].tag, inner[1].value),
      };
    }
  }
  throw new Error('certificate missing validity');
}

function findExtensions(tbsChildren: ReturnType<typeof derChildren>): Map<string, Uint8Array> {
  const extensions = new Map<string, Uint8Array>();
  for (const child of tbsChildren) {
    if (child.tag !== contextTag(EXTENSIONS_OID_CONTAINER, true)) {
      continue;
    }
    const wrapped = derChildren(child)[0];
    if (!wrapped) {
      continue;
    }
    for (const extension of derChildren(wrapped)) {
      const parts = derChildren(extension);
      if (parts.length < 2 || parts[0].tag !== 0x06) {
        continue;
      }
      const oid = decodeOid(parts[0].value);
      const valueNode = parts[parts.length - 1];
      extensions.set(oid, valueNode.tag === 0x04 ? valueNode.value : valueNode.bytes);
    }
  }
  return extensions;
}

function isTimeTag(tag: number): boolean {
  return tag === 0x17 || tag === 0x18;
}

function parseTime(tag: number, value: Uint8Array): Date {
  const text = new TextDecoder().decode(value);
  if (tag === 0x17) {
    const yearPrefix = Number(text.slice(0, 2)) >= 50 ? '19' : '20';
    return new Date(
      `${yearPrefix}${text.slice(0, 2)}-${text.slice(2, 4)}-${text.slice(4, 6)}T${text.slice(6, 8)}:${text.slice(8, 10)}:${text.slice(10, 12)}Z`,
    );
  }
  return new Date(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`,
  );
}

function decodeBitString(value: Uint8Array): Uint8Array {
  return value.slice(1);
}

export async function importP256VerifyKey(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    asBufferSource(spki),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

export async function rawEcPointFromSpki(spki: Uint8Array): Promise<Uint8Array> {
  const key = await importP256VerifyKey(spki);
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function verifyEcdsaSha256(
  publicKey: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    publicKey,
    asBufferSource(toRawEcdsaSignature(signature)),
    asBufferSource(data),
  );
}

export async function verifyCertificateChain(
  x5c: Uint8Array[],
  trustAnchorDer: Uint8Array,
  now: Date = new Date(),
): Promise<ParsedCertificate> {
  if (x5c.length === 0) {
    throw new Error('x5c chain is empty');
  }
  const certs = [...x5c, trustAnchorDer].map((der) => parseCertificate(der));
  const leaf = certs[0];
  const root = certs[certs.length - 1];
  if (!bytesEqual(root.der, parseCertificate(trustAnchorDer).der)) {
    throw new Error('trust anchor mismatch');
  }

  for (const cert of certs) {
    if (now < cert.notBefore || now > cert.notAfter) {
      throw new Error('certificate is expired or not yet valid');
    }
  }

  for (let i = 0; i < certs.length - 1; i++) {
    const subject = certs[i];
    const issuer = certs[i + 1];
    /* Sequential: each cert must be verified by the next issuer before continuing. */
    /* eslint-disable no-await-in-loop */
    const issuerKey = await importP256VerifyKey(issuer.spki);
    const valid = await verifyEcdsaSha256(issuerKey, subject.signature, subject.tbs);
    /* eslint-enable no-await-in-loop */
    if (!valid) {
      throw new Error(`certificate chain signature failed at index ${i}`);
    }
  }

  return leaf;
}

export function extractAppleNonce(cert: ParsedCertificate): Uint8Array {
  const extension = cert.extensions.get(APPLE_NONCE_OID);
  if (!extension) {
    throw new Error('leaf certificate missing App Attest nonce extension');
  }
  const { node } = readDer(extension, 0);
  const nonce = findFirstOctetStringOfLength(node, 32);
  if (!nonce) {
    throw new Error('App Attest nonce extension did not contain a 32-byte nonce');
  }
  return nonce;
}

export async function buildP256Certificate(options: {
  subjectKey: CryptoKey;
  issuerKey: CryptoKey;
  subjectCn: string;
  issuerCn: string;
  serial: number;
  notBefore: Date;
  notAfter: Date;
  isCa?: boolean;
  nonce?: Uint8Array;
}): Promise<Uint8Array> {
  const subjectSpki = new Uint8Array(await crypto.subtle.exportKey('spki', options.subjectKey));
  const validity = encodeSequence(
    encodeUtcTime(options.notBefore),
    encodeUtcTime(options.notAfter),
  );
  const extensions: Uint8Array[] = [];
  if (options.isCa) {
    extensions.push(
      encodeSequence(
        encodeOid('2.5.29.19'),
        encodeTlv(0x01, Uint8Array.of(0xff)),
        encodeOctetString(encodeSequence(encodeTlv(0x01, Uint8Array.of(0xff)))),
      ),
    );
  }
  if (options.nonce) {
    const nonceValue = encodeSequence(
      encodeTlv(contextTag(1, true), encodeOctetString(options.nonce)),
    );
    extensions.push(encodeSequence(encodeOid(APPLE_NONCE_OID), encodeOctetString(nonceValue)));
  }
  const tbsParts = [
    encodeTlv(contextTag(0, true), encodeIntegerNumber(2)),
    encodeIntegerNumber(options.serial),
    encodeSequence(encodeOid(ECDSA_WITH_SHA256_OID)),
    encodeName(options.issuerCn),
    validity,
    encodeName(options.subjectCn),
    subjectSpki,
  ];
  if (extensions.length > 0) {
    tbsParts.push(encodeTlv(contextTag(3, true), encodeSequence(...extensions)));
  }
  const tbs = encodeSequence(...tbsParts);
  const signatureRaw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      options.issuerKey,
      asBufferSource(tbs),
    ),
  );
  const signatureDer = rawEcdsaToDer(signatureRaw);
  return encodeSequence(
    tbs,
    encodeSequence(encodeOid(ECDSA_WITH_SHA256_OID)),
    encodeBitString(signatureDer),
  );
}

function encodeName(commonName: string): Uint8Array {
  return encodeSequence(
    encodeSet(encodeSequence(encodeOid(COMMON_NAME_OID), encodeUtf8String(commonName))),
  );
}

function encodeUtcTime(date: Date): Uint8Array {
  const yy = String(date.getUTCFullYear()).slice(2);
  const parts = [
    yy,
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
    'Z',
  ];
  return encodeTlv(0x17, new TextEncoder().encode(parts.join('')));
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}
