import { describe, expect, it } from 'vitest';
import { appleAppAttestRootDer } from './apple-root';
import { derEcdsaToRaw, inferEcdsaComponentSize } from './asn1';
import {
  buildEcCertificate,
  buildP256Certificate,
  hashFromSignatureAlgorithm,
  importEcVerifyKey,
  importP256VerifyKey,
  namedCurveFromSpki,
  parseCertificate,
  verifyCertificateChain,
} from './x509';

async function generatePair(namedCurve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify']);
}

describe('Apple App Attest root CA (P-384)', () => {
  it('parses the pinned root as P-384 with ecdsa-with-SHA384', () => {
    const parsed = parseCertificate(appleAppAttestRootDer());
    expect(namedCurveFromSpki(parsed.spki)).toBe('P-384');
    expect(parsed.namedCurve).toBe('P-384');
    expect(parsed.signatureHash).toBe('SHA-384');
    expect(hashFromSignatureAlgorithm(parsed.signatureAlgorithm)).toBe('SHA-384');
  });

  it('imports the root SPKI as P-384 and rejects a hardcoded P-256 import', async () => {
    const parsed = parseCertificate(appleAppAttestRootDer());
    await expect(importEcVerifyKey(parsed.spki)).resolves.toMatchObject({ type: 'public' });
    await expect(importP256VerifyKey(parsed.spki)).rejects.toThrow(/P-256/);
  });

  it('verifies the real Apple root as a self-signed trust anchor', async () => {
    const root = appleAppAttestRootDer();
    const leaf = await verifyCertificateChain([root], root);
    expect(leaf.namedCurve).toBe('P-384');
    expect(leaf.signatureHash).toBe('SHA-384');
  });
});

describe('mixed P-384 issuer / P-256 leaf chains', () => {
  it('verifies a P-256 leaf signed by a P-384 root', async () => {
    const now = new Date();
    const notBefore = new Date(now.getTime() - 60_000);
    const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const root = await generatePair('P-384');
    const device = await generatePair('P-256');
    const rootDer = await buildEcCertificate({
      subjectKey: root.publicKey,
      issuerKey: root.privateKey,
      issuerCurve: 'P-384',
      subjectCn: 'P-384 Test Root',
      issuerCn: 'P-384 Test Root',
      serial: 1,
      notBefore,
      notAfter,
      isCa: true,
    });
    const leafDer = await buildEcCertificate({
      subjectKey: device.publicKey,
      issuerKey: root.privateKey,
      issuerCurve: 'P-384',
      subjectCn: 'P-256 Test Leaf',
      issuerCn: 'P-384 Test Root',
      serial: 2,
      notBefore,
      notAfter,
    });

    const parsedRoot = parseCertificate(rootDer);
    const parsedLeaf = parseCertificate(leafDer);
    expect(parsedRoot.namedCurve).toBe('P-384');
    expect(parsedRoot.signatureHash).toBe('SHA-384');
    expect(parsedLeaf.namedCurve).toBe('P-256');
    expect(parsedLeaf.signatureHash).toBe('SHA-384');

    const verified = await verifyCertificateChain([leafDer], rootDer);
    expect(verified.namedCurve).toBe('P-256');
  });

  it('still verifies an all-P-256 chain', async () => {
    const now = new Date();
    const notBefore = new Date(now.getTime() - 60_000);
    const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const root = await generatePair('P-256');
    const device = await generatePair('P-256');
    const rootDer = await buildP256Certificate({
      subjectKey: root.publicKey,
      issuerKey: root.privateKey,
      subjectCn: 'P-256 Root',
      issuerCn: 'P-256 Root',
      serial: 1,
      notBefore,
      notAfter,
      isCa: true,
    });
    const leafDer = await buildP256Certificate({
      subjectKey: device.publicKey,
      issuerKey: root.privateKey,
      subjectCn: 'P-256 Leaf',
      issuerCn: 'P-256 Root',
      serial: 2,
      notBefore,
      notAfter,
    });
    const verified = await verifyCertificateChain([leafDer], rootDer);
    expect(verified.namedCurve).toBe('P-256');
    expect(verified.signatureHash).toBe('SHA-256');
  });

  it('fails closed on signature mismatch without a namedCurve import error', async () => {
    const now = new Date();
    const notBefore = new Date(now.getTime() - 60_000);
    const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const unrelated = await generatePair('P-256');
    const leafDer = await buildP256Certificate({
      subjectKey: unrelated.publicKey,
      issuerKey: unrelated.privateKey,
      subjectCn: 'Unrelated Leaf',
      issuerCn: 'Unrelated Leaf',
      serial: 1,
      notBefore,
      notAfter,
    });
    await expect(verifyCertificateChain([leafDer], appleAppAttestRootDer())).rejects.toThrow(
      /signature failed/,
    );
  });
});

describe('P-384 ECDSA signature encoding', () => {
  it('infers 48-byte components from a P-384 DER signature', async () => {
    const pair = await generatePair('P-384');
    const data = new TextEncoder().encode('p384-signature');
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-384' } }, pair.privateKey, data),
    );
    expect(raw.length).toBe(96);
    const { rawEcdsaToDer } = await import('./asn1');
    const der = rawEcdsaToDer(raw, 48);
    expect(inferEcdsaComponentSize(der)).toBe(48);
    expect(derEcdsaToRaw(der, 48)).toEqual(raw);
  });
});
