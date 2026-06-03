import { Injectable, Logger } from '@nestjs/common';
import { RegistryCredential } from '@dokkimi/config';

export interface DockerAuthConfig {
  username: string;
  password: string;
  serveraddress: string;
}

@Injectable()
export class DockerRegistryService {
  private readonly logger = new Logger(DockerRegistryService.name);
  private readonly runAuthConfigs = new Map<string, DockerAuthConfig[]>();

  storeCredentials(runId: string, credentials: RegistryCredential[]): void {
    if (credentials.length === 0) {
      return;
    }

    const authConfigs: DockerAuthConfig[] = credentials.map((cred) => ({
      username: cred.username,
      password: cred.password,
      serveraddress: cred.registryUrl,
    }));

    this.runAuthConfigs.set(runId, authConfigs);
    this.logger.log(
      `Stored ${credentials.length} registry credential(s) for run ${runId}`,
    );
  }

  getAuthConfig(runId: string, image: string): DockerAuthConfig | undefined {
    const configs = this.runAuthConfigs.get(runId);
    if (!configs) {
      return undefined;
    }

    const registry = this.extractRegistry(image);
    return configs.find((c) => c.serveraddress === registry);
  }

  clearCredentials(runId: string): void {
    this.runAuthConfigs.delete(runId);
  }

  private extractRegistry(image: string): string {
    // Images like "ghcr.io/org/name:tag" have registry "ghcr.io"
    // Images like "name:tag" or "library/name:tag" use Docker Hub
    const parts = image.split('/');
    if (
      parts.length >= 2 &&
      (parts[0].includes('.') || parts[0].includes(':'))
    ) {
      return parts[0];
    }
    return 'https://index.docker.io/v1/';
  }
}
