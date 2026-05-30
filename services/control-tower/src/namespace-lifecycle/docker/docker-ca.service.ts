import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as forge from 'node-forge';

const CA_DIR = path.join(os.homedir(), '.dokkimi', 'ca');
const CA_CERT_PATH = path.join(CA_DIR, 'ca.crt');
const CA_KEY_PATH = path.join(CA_DIR, 'ca.key');

export interface CaPaths {
  certPath: string;
  keyPath: string;
}

export interface CaBundlePaths {
  caCertPath: string;
  caKeyPath: string;
  caBundlePath: string;
}

@Injectable()
export class DockerCaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DockerCaService.name);

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.ensureCA();
    } catch (error) {
      this.logger.warn(
        'Failed to ensure Dokkimi CA on startup:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  getCaPaths(): CaPaths {
    return {
      certPath: CA_CERT_PATH,
      keyPath: CA_KEY_PATH,
    };
  }

  prepareCaBundleForInstance(instanceId: string): CaBundlePaths {
    const configDir = path.join(os.tmpdir(), `dokkimi-${instanceId}`);
    fs.mkdirSync(configDir, { recursive: true });

    const caBundlePath = path.join(configDir, 'ca-bundle.crt');

    // Build combined CA bundle: system CAs + Dokkimi CA
    let systemCaCerts = '';
    const systemCaPaths = [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/usr/local/etc/openssl@3/cert.pem',
      '/usr/local/etc/openssl/cert.pem',
    ];

    for (const sysPath of systemCaPaths) {
      try {
        systemCaCerts = fs.readFileSync(sysPath, 'utf-8');
        break;
      } catch {
        // Try next path
      }
    }

    const dokkimiCaCert = fs.readFileSync(CA_CERT_PATH, 'utf-8');
    const combinedBundle = systemCaCerts
      ? `${systemCaCerts}\n${dokkimiCaCert}`
      : dokkimiCaCert;

    fs.writeFileSync(caBundlePath, combinedBundle);

    this.logger.log(`Prepared CA bundle for instance ${instanceId}`);

    return {
      caCertPath: CA_CERT_PATH,
      caKeyPath: CA_KEY_PATH,
      caBundlePath,
    };
  }

  getInterceptorCaBinds(): string[] {
    return [
      `${CA_CERT_PATH}:/etc/dokkimi/ca/tls.crt:ro`,
      `${CA_KEY_PATH}:/etc/dokkimi/ca/tls.key:ro`,
    ];
  }

  getServiceCaBinds(caBundlePaths: CaBundlePaths): string[] {
    return [
      `${caBundlePaths.caCertPath}:/etc/ssl/certs/dokkimi-ca.crt:ro`,
      `${caBundlePaths.caBundlePath}:/ca-bundle/ca-bundle.crt:ro`,
    ];
  }

  getServiceCaEnvVars(): Record<string, string> {
    return {
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/dokkimi-ca.crt',
      SSL_CERT_FILE: '/ca-bundle/ca-bundle.crt',
      REQUESTS_CA_BUNDLE: '/ca-bundle/ca-bundle.crt',
      CURL_CA_BUNDLE: '/ca-bundle/ca-bundle.crt',
    };
  }

  getInterceptorCaEnvVars(): Record<string, string> {
    return {
      DOKKIMI_CA_CERT_PATH: '/etc/dokkimi/ca/tls.crt',
      DOKKIMI_CA_KEY_PATH: '/etc/dokkimi/ca/tls.key',
    };
  }

  // ============================================
  // PRIVATE
  // ============================================

  private ensureCA(): void {
    if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
      this.logger.log('Dokkimi CA already exists');
      return;
    }

    this.logger.log('Generating Dokkimi CA...');
    fs.mkdirSync(CA_DIR, { recursive: true });

    const { certPem, keyPem } = this.generateCA();
    fs.writeFileSync(CA_CERT_PATH, certPem);
    fs.writeFileSync(CA_KEY_PATH, keyPem, { mode: 0o600 });
    this.logger.log(`Dokkimi CA created at ${CA_DIR}`);
  }

  private generateCA(): { certPem: string; keyPem: string } {
    const keys = forge.pki.rsa.generateKeyPair(4096);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    const serialBytes = forge.random.getBytesSync(16);
    const positiveBytes =
      String.fromCharCode(serialBytes.charCodeAt(0) & 0x7f) +
      serialBytes.slice(1);
    cert.serialNumber = forge.util.bytesToHex(positiveBytes);
    cert.validity.notBefore = new Date();
    cert.validity.notBefore.setHours(cert.validity.notBefore.getHours() - 1);
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notAfter.getFullYear() + 10,
    );
    const attrs = [
      { name: 'commonName', value: 'Dokkimi Interceptor CA' },
      { name: 'organizationName', value: 'Dokkimi' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, pathLenConstraint: 1 },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    return {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }
}
