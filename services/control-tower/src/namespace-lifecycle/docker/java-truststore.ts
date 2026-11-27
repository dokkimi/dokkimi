import { createHash } from 'crypto';

/** The password JVMs use for their own truststore; it only guards integrity */
export const JAVA_TRUSTSTORE_PASSWORD = 'changeit';

/**
 * A JKS truststore holding these PEM certificates as trusted entries. JKS is
 * the format every JVM reads without extra options; written here so Control
 * Tower doesn't need keytool. Layout (big-endian): magic, version 2, count,
 * then per entry tag 2 (trusted certificate), alias, date, "X.509" and the
 * DER bytes; last, SHA-1 over the password, "Mighty Aphrodite" and the rest.
 */
export function buildJavaTruststore(
  certsPem: string[],
  password = JAVA_TRUSTSTORE_PASSWORD,
  date = Date.now(),
): Buffer {
  const parts: Buffer[] = [];
  const int = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    parts.push(b);
  };
  const utf = (s: string) => {
    const bytes = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(bytes.length);
    parts.push(len, bytes);
  };

  int(0xfeedfeed);
  int(2);
  int(certsPem.length);
  certsPem.forEach((pem, i) => {
    const der = Buffer.from(
      pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''),
      'base64',
    );
    int(2);
    utf(`cert-${i}`);
    const when = Buffer.alloc(8);
    when.writeBigUInt64BE(BigInt(date));
    parts.push(when);
    utf('X.509');
    int(der.length);
    parts.push(der);
  });

  const body = Buffer.concat(parts);
  const passwordBytes = Buffer.alloc(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    passwordBytes.writeUInt16BE(password.charCodeAt(i), i * 2);
  }
  const digest = createHash('sha1')
    .update(passwordBytes)
    .update('Mighty Aphrodite', 'utf-8')
    .update(body)
    .digest();
  return Buffer.concat([body, digest]);
}
