import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { RegistryCredential } from '@dokkimi/config';

@Injectable()
export class DockerRegistryService {
  private readonly logger = new Logger(DockerRegistryService.name);
  private readonly docker: Docker;
  private readonly runAuthConfigs = new Map<string, Docker.AuthConfig[]>();

  constructor() {
    this.docker = new Docker();
  }

  storeCredentials(runId: string, credentials: RegistryCredential[]): void {
    if (credentials.length === 0) {
      return;
    }

    const authConfigs: Docker.AuthConfig[] = credentials.map((cred) => ({
      username: cred.username,
      password: cred.password,
      serveraddress: cred.registryUrl,
    }));

    this.runAuthConfigs.set(runId, authConfigs);
    this.logger.log(
      `Stored ${credentials.length} registry credential(s) for run ${runId}`,
    );
  }

  getAuthConfig(runId: string, image: string): Docker.AuthConfig | undefined {
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
    if (parts.length >= 2 && (parts[0].includes('.') || parts[0].includes(':'))) {
      return parts[0];
    }
    return 'https://index.docker.io/v1/';
  }
}
