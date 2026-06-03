import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { prompt } from '../lib/cli-utils';
import { shutdownServices } from '@dokkimi/service-manager';
import { trackEvent, shutdownTelemetry } from '@dokkimi/telemetry';
import { execSilent } from '@dokkimi/platform';

const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');

const DOKKIMI_IMAGES = [
  'ghcr.io/dokkimi/interceptor',
  'ghcr.io/dokkimi/test-agent',
  'ghcr.io/dokkimi/db-proxy-postgres',
  'ghcr.io/dokkimi/db-proxy-mysql',
  'ghcr.io/dokkimi/db-proxy-mongo',
  'ghcr.io/dokkimi/db-proxy-redis',
];

export async function uninstall(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi uninstall');
    console.log('');
    console.log('Remove Dokkimi from your system:');
    console.log('  - Stop Dokkimi');
    console.log('  - Clean up Docker containers and networks');
    console.log('  - Remove Dokkimi Docker images');
    console.log('  - Remove ~/.dokkimi/ data directory');
    console.log('');
    console.log(
      'Does NOT remove the CLI itself — uninstall via your package manager',
    );
    console.log('(e.g. npm uninstall -g dokkimi, brew uninstall dokkimi).');
    process.exit(0);
  }

  console.log('');
  console.log(
    'This will remove all Dokkimi data and resources from your system:',
  );
  console.log('');
  console.log('  1. Stop Dokkimi');
  console.log('  2. Clean up Docker containers and networks');
  console.log('  3. Remove Dokkimi Docker images');
  console.log(`  4. Remove ${DOKKIMI_DIR}/`);
  console.log('  5. Remove AI config pointers');
  console.log('');

  const answer = await prompt('Continue? (y/n): ');
  if (answer !== 'y' && answer !== 'yes') {
    trackEvent('cli_uninstall', { confirmed: false });
    console.log('Aborted.');
    return;
  }

  // Track and flush before cleanup (which deletes ~/.dokkimi/ including telemetry state)
  trackEvent('cli_uninstall', {
    confirmed: true,
  });
  await shutdownTelemetry();

  console.log('');

  // 1. Stop Dokkimi
  console.log('[1/5] Stopping Dokkimi...');
  try {
    await shutdownServices();
    console.log('       Stopped.');
  } catch {
    console.log('       Dokkimi was not running.');
  }

  // 2. Clean Docker containers and networks
  console.log('[2/5] Cleaning Docker containers and networks...');
  const containers = findDokkimiContainers();
  const networks = findDokkimiNetworks();
  if (containers.length > 0) {
    for (const name of containers) {
      try {
        execSilent(`docker rm -f ${name}`, { timeout: 10000 });
        console.log(`       Removed container ${name}`);
      } catch {
        console.log(
          `       Failed to remove ${name} (may need manual cleanup)`,
        );
      }
    }
  }
  if (networks.length > 0) {
    for (const name of networks) {
      try {
        execSilent(`docker network rm ${name}`, { timeout: 10000 });
        console.log(`       Removed network ${name}`);
      } catch {
        console.log(
          `       Failed to remove ${name} (may need manual cleanup)`,
        );
      }
    }
  }
  if (containers.length === 0 && networks.length === 0) {
    console.log('       No Docker resources found.');
  }

  // 3. Remove Docker images
  console.log('[3/5] Removing Docker images...');
  let imagesRemoved = 0;
  for (const image of DOKKIMI_IMAGES) {
    const imageIds = findImageIds(image);
    for (const id of imageIds) {
      try {
        execSilent(`docker rmi ${id}`, { timeout: 10000 });
        imagesRemoved++;
      } catch {
        // Image may be in use or already removed
      }
    }
  }
  console.log(
    `       Removed ${imagesRemoved} image${imagesRemoved === 1 ? '' : 's'}.`,
  );

  // 4. Remove data directory
  console.log(`[4/5] Removing ${DOKKIMI_DIR}/...`);
  if (fs.existsSync(DOKKIMI_DIR)) {
    fs.rmSync(DOKKIMI_DIR, { recursive: true, force: true });
    console.log('       Removed.');
  } else {
    console.log('       Directory not found.');
  }

  // 5. Remove AI config pointers
  console.log('[5/5] Removing AI config pointers...');
  removeLlmConfigPointers();
  console.log('       Done.');

  console.log('');
  console.log('Dokkimi has been removed from your system.');
  console.log('');
  console.log('To remove the CLI itself:');
  console.log('  Global install:  npm uninstall -g dokkimi');
  console.log('  Dev dependency:  npm uninstall dokkimi');
  console.log('');
}

const DOKKIMI_MARKER = '<!-- dokkimi -->';

function removeLlmConfigPointers(): void {
  // Remove dokkimi section from marker-based files
  const markerFiles = [
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(os.homedir(), '.github', 'copilot-instructions.md'),
  ];
  for (const filePath of markerFiles) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes(DOKKIMI_MARKER)) {
        continue;
      }
      const regex = new RegExp(
        `\\n?${DOKKIMI_MARKER}[\\s\\S]*?${DOKKIMI_MARKER}\\n?`,
        'g',
      );
      const updated = content
        .replace(regex, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (updated) {
        fs.writeFileSync(filePath, updated + '\n', 'utf-8');
      } else {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort
    }
  }

  // Remove Cursor rules file
  try {
    const cursorPath = path.join(
      os.homedir(),
      '.cursor',
      'rules',
      'dokkimi.md',
    );
    if (fs.existsSync(cursorPath)) {
      fs.unlinkSync(cursorPath);
    }
  } catch {
    // Best-effort
  }

  // Remove MCP server entries
  for (const configPath of [
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.cursor', 'mcp.json'),
  ]) {
    try {
      if (!fs.existsSync(configPath)) {
        continue;
      }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.mcpServers?.dokkimi) {
        delete config.mcpServers.dokkimi;
        fs.writeFileSync(
          configPath,
          JSON.stringify(config, null, 2) + '\n',
          'utf-8',
        );
      }
    } catch {
      // Best-effort
    }
  }
}

function findDokkimiContainers(): string[] {
  try {
    const output = execSilent(
      'docker ps -a --filter "label=dokkimi" --format "{{.Names}}"',
      { timeout: 10000 },
    );
    if (!output) {
      return [];
    }
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function findDokkimiNetworks(): string[] {
  try {
    const output = execSilent(
      'docker network ls --filter "label=dokkimi" --format "{{.Name}}"',
      { timeout: 10000 },
    );
    if (!output) {
      return [];
    }
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function findImageIds(imagePrefix: string): string[] {
  try {
    const output = execSilent(
      `docker images "${imagePrefix}" --format "{{.ID}}"`,
      { timeout: 5000 },
    );
    if (!output) {
      return [];
    }
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
