import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KubernetesClientService } from './kubernetes/kubernetes-client.service';
import { is404Error, is409Error } from './kubernetes/kubernetes-helpers';
import * as forge from 'node-forge';

const CA_SECRET_NAME = 'dokkimi-ca';
const CA_NAMESPACE = 'dokkimi-system';

@Injectable()
export class DokkimiCaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DokkimiCaService.name);

  constructor(private readonly k8sClient: KubernetesClientService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureCA();
    } catch (error) {
      this.logger.warn(
        'Failed to ensure Dokkimi CA on startup (may not have cluster access):',
        error instanceof Error ? error.message : error,
      );
    }
  }

  async ensureCA(): Promise<void> {
    try {
      await this.k8sClient.core.readNamespacedSecret({
        name: CA_SECRET_NAME,
        namespace: CA_NAMESPACE,
      });
      this.logger.log('Dokkimi CA already exists');
    } catch (error) {
      if (is404Error(error)) {
        this.logger.log('Generating Dokkimi CA...');
        // Ensure the dokkimi-system namespace exists
        await this.k8sClient.createNamespace(CA_NAMESPACE);
        const { certPem, keyPem } = this.generateCA();
        await this.k8sClient.core.createNamespacedSecret({
          namespace: CA_NAMESPACE,
          body: {
            metadata: {
              name: CA_SECRET_NAME,
              namespace: CA_NAMESPACE,
              labels: {
                'app.kubernetes.io/name': 'dokkimi',
                'app.kubernetes.io/component': 'ca',
              },
            },
            type: 'kubernetes.io/tls',
            data: {
              'tls.crt': Buffer.from(certPem).toString('base64'),
              'tls.key': Buffer.from(keyPem).toString('base64'),
              'ca.crt': Buffer.from(certPem).toString('base64'),
            },
          },
        });
        this.logger.log('Dokkimi CA created successfully');
        return;
      }
      throw error;
    }
  }

  async copyCAToNamespace(targetNamespace: string): Promise<void> {
    this.logger.log(`Copying CA secrets to namespace ${targetNamespace}...`);
    // Read the CA secret from dokkimi-system
    // Create it in the target namespace (with only ca.crt, not the private key)
    // This is for service pods to mount for trust
    try {
      const response = await this.k8sClient.core.readNamespacedSecret({
        name: CA_SECRET_NAME,
        namespace: CA_NAMESPACE,
      });
      const secret =
        (response as { body?: { data?: Record<string, string> } }).body ||
        (response as { data?: Record<string, string> });
      const caCrt = secret.data?.['ca.crt'];
      if (!caCrt) {
        this.logger.warn('CA secret exists but has no ca.crt data');
        return;
      }

      // Create a secret with just the public cert in the target namespace
      await this.createSecretIfNotExists(targetNamespace, {
        metadata: {
          name: 'dokkimi-ca-cert',
          namespace: targetNamespace,
          labels: {
            'app.kubernetes.io/name': 'dokkimi',
            'app.kubernetes.io/component': 'ca-cert',
          },
        },
        type: 'Opaque',
        data: { 'ca.crt': caCrt },
      });

      // Also copy the full secret (with private key) for interceptor pods.
      // Security note: the CA private key is accessible to any pod in this namespace
      // with the right RBAC. This is acceptable because test namespaces are ephemeral
      // and isolated, and the CA is only used for MITM in test environments.
      await this.createSecretIfNotExists(targetNamespace, {
        metadata: {
          name: CA_SECRET_NAME,
          namespace: targetNamespace,
          labels: {
            'app.kubernetes.io/name': 'dokkimi',
            'app.kubernetes.io/component': 'ca',
          },
        },
        type: 'kubernetes.io/tls',
        data: secret.data,
      });

      this.logger.log(`Copied CA secrets to namespace ${targetNamespace}`);
    } catch (error) {
      if (is404Error(error)) {
        this.logger.warn(
          'Dokkimi CA secret not found, skipping CA copy (HTTPS interception disabled)',
        );
        return;
      }
      this.logger.error(
        `Failed to copy CA to namespace ${targetNamespace}:`,
        error,
      );
      throw error;
    }
  }

  private async createSecretIfNotExists(
    namespace: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.k8sClient.core.createNamespacedSecret({ namespace, body });
    } catch (err) {
      if (is409Error(err)) {
        this.logger.log(
          `Secret ${(body.metadata as { name?: string })?.name} already exists in ${namespace}`,
        );
        return;
      }
      throw err;
    }
  }

  private generateCA(): { certPem: string; keyPem: string } {
    const keys = forge.pki.rsa.generateKeyPair(4096);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    const serialBytes = forge.random.getBytesSync(16);
    // Clear high bit to ensure positive serial number (Go x509 rejects negative)
    const positiveBytes =
      String.fromCharCode(serialBytes.charCodeAt(0) & 0x7f) +
      serialBytes.slice(1);
    cert.serialNumber = forge.util.bytesToHex(positiveBytes);
    cert.validity.notBefore = new Date();
    cert.validity.notBefore.setHours(cert.validity.notBefore.getHours() - 1); // 1h grace
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notAfter.getFullYear() + 10,
    ); // 10 years
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
