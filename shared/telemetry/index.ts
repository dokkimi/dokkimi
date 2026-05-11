import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { PostHog } from 'posthog-node';
import {
  getTelemetryPrefs,
  setTelemetryPrefs,
  TelemetryPrefs,
} from '@dokkimi/config';
import { execSilent } from '@dokkimi/platform';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POSTHOG_API_KEY = 'phc_qRHhgna4UJzsZ47Vr3yf4aRQ4mSD9ykqyN5kDtoigSJp';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const SHUTDOWN_TIMEOUT_MS = 2000;

function loadDokkimiVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(path.resolve(__dirname, '..', 'package.json'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const DOKKIMI_VERSION = loadDokkimiVersion();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let client: PostHog | null = null;
let distinctId: string | null = null;
let enabled = false;
let baseProperties: Record<string, unknown> = {};
let detachedMode = false;
let pendingEvents: Array<{
  event: string;
  properties: Record<string, unknown>;
}> = [];

// ---------------------------------------------------------------------------
// State helpers (backed by @dokkimi/config user-prefs)
// ---------------------------------------------------------------------------

function readState(): TelemetryPrefs | null {
  return getTelemetryPrefs() ?? null;
}

function writeState(state: TelemetryPrefs): void {
  setTelemetryPrefs(state);
}

// ---------------------------------------------------------------------------
// K8s provider detection (lazy, cached)
// ---------------------------------------------------------------------------

let cachedK8sProvider: string | null = null;

export function detectK8sProvider(): string {
  if (cachedK8sProvider !== null) {
    return cachedK8sProvider;
  }
  try {
    const context = execSilent('kubectl config current-context', {
      timeout: 3000,
    });

    if (context.includes('docker-desktop')) {
      cachedK8sProvider = 'docker-desktop';
    } else if (context.includes('minikube')) {
      cachedK8sProvider = 'minikube';
    } else if (context.startsWith('kind-')) {
      cachedK8sProvider = 'kind';
    } else if (context.includes('colima')) {
      cachedK8sProvider = 'colima';
    } else if (context.includes('rancher-desktop')) {
      cachedK8sProvider = 'rancher-desktop';
    } else {
      cachedK8sProvider = 'other';
    }
  } catch {
    cachedK8sProvider = 'unknown';
  }
  return cachedK8sProvider;
}

// ---------------------------------------------------------------------------
// CI identity
// ---------------------------------------------------------------------------

function detectCiProvider(): string {
  if (process.env.GITHUB_ACTIONS) {
    return 'github';
  }
  if (process.env.GITLAB_CI) {
    return 'gitlab';
  }
  if (process.env.CIRCLECI) {
    return 'circleci';
  }
  if (process.env.JENKINS_URL) {
    return 'jenkins';
  }
  if (process.env.BUILD_BUILDID) {
    return 'azure';
  }
  if (process.env.BITBUCKET_BUILD_NUMBER) {
    return 'bitbucket';
  }
  if (process.env.TRAVIS) {
    return 'travis';
  }
  return 'unknown';
}

function getCiDistinctId(): string | null {
  if (!process.env.CI) {
    return null;
  }

  const repoSlug =
    process.env.GITHUB_REPOSITORY ||
    process.env.CI_PROJECT_PATH ||
    (process.env.CIRCLE_PROJECT_USERNAME && process.env.CIRCLE_PROJECT_REPONAME
      ? `${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}`
      : null) ||
    process.env.GIT_URL ||
    process.env.BUILD_REPOSITORY_URI ||
    process.env.BITBUCKET_REPO_FULL_NAME ||
    process.env.TRAVIS_REPO_SLUG ||
    'dokkimi-ci-unknown';

  const hash = crypto
    .createHash('sha256')
    .update(repoSlug.toLowerCase().trim())
    .digest('hex');
  return `ci-${hash.substring(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TelemetryOptions {
  /** Print first-run notice to stderr. Set false for backend services. */
  showFirstRunNotice?: boolean;
  /** Service name for backend services. */
  serviceName?: string;
  /**
   * Buffer events and flush via a detached child process on shutdown.
   * Use for short-lived CLI processes so they can exit immediately without
   * waiting on the PostHog HTTP request.
   */
  detachedFlush?: boolean;
}

/**
 * Initialize telemetry. Call once at process startup.
 * Reads/creates ~/.dokkimi/telemetry.json, optionally prints first-run notice,
 * and initializes the PostHog client if enabled.
 */
export function initTelemetry(options: TelemetryOptions = {}): void {
  try {
    const ciId = getCiDistinctId();
    let state = readState();
    let isFirstRun = false;

    if (ciId) {
      distinctId = ciId;
      enabled = state?.enabled ?? true;
    } else if (!state) {
      state = {
        distinctId: crypto.randomUUID(),
        enabled: true,
        firstRunNoticeSeen: false,
      };
      writeState(state);
      distinctId = state.distinctId;
      enabled = state.enabled;
      isFirstRun = true;
    } else {
      distinctId = state.distinctId;
      enabled = state.enabled;
      isFirstRun = !state.firstRunNoticeSeen;
    }

    // First-run notice (CLI only, not in CI)
    if (!ciId && options.showFirstRunNotice !== false && isFirstRun) {
      process.stderr.write(
        '\n\x1b[90mDokkimi collects anonymous usage data to improve the CLI.\n' +
          'No definition content, service names, or test data is collected.\n' +
          'You can opt out at any time: dokkimi config\x1b[0m\n\n',
      );
      if (state) {
        state.firstRunNoticeSeen = true;
        writeState(state);
      }
    }

    // Build base properties
    baseProperties = {
      os: process.platform,
      os_arch: process.arch,
      node_version: process.version,
      is_ci: Boolean(process.env.CI),
    };
    if (options.serviceName) {
      baseProperties.service_name = options.serviceName;
    }
    baseProperties.dokkimi_version = DOKKIMI_VERSION;
    if (ciId) {
      baseProperties.ci_provider = detectCiProvider();
      baseProperties.ci_run_id =
        process.env.GITHUB_RUN_ID ||
        process.env.CI_PIPELINE_ID ||
        process.env.CIRCLE_BUILD_NUM ||
        process.env.BUILD_BUILDID ||
        process.env.BITBUCKET_BUILD_NUMBER ||
        undefined;
    }

    if (!enabled) {
      return;
    }

    detachedMode = options.detachedFlush === true;

    if (!detachedMode) {
      client = new PostHog(POSTHOG_API_KEY, {
        host: POSTHOG_HOST,
        flushAt: 10,
        flushInterval: 5000,
        requestTimeout: 3000,
        disableGeoip: true,
      });
    } else {
      // Catch process.exit() paths that bypass shutdownTelemetry().
      // spawn() is synchronous, so the exit handler can fire it before teardown.
      process.once('exit', flushDetached);
    }

    // Track first-ever invocation (after client is initialized)
    if (isFirstRun) {
      trackEvent('cli_first_run', {});
    }
  } catch {
    // Telemetry init must never break the app
  }
}

/**
 * Track an event. Synchronous, fire-and-forget.
 * No-ops if telemetry is disabled or not initialized.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    if (!enabled || !distinctId) {
      return;
    }
    const mergedProperties = { ...baseProperties, ...properties };
    if (detachedMode) {
      pendingEvents.push({ event, properties: mergedProperties });
      return;
    }
    if (!client) {
      return;
    }
    client.capture({
      distinctId,
      event,
      properties: mergedProperties,
    });
  } catch {
    // Never throw from telemetry
  }
}

/**
 * Flush buffered events and shut down.
 *
 * In detached mode, spawns a short-lived unref'd child process that owns the
 * PostHog HTTP request and returns immediately so the caller can exit.
 * Otherwise awaits an inline flush capped at SHUTDOWN_TIMEOUT_MS.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (detachedMode) {
    flushDetached();
    return;
  }
  if (!client) {
    return;
  }
  try {
    await Promise.race([
      client.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch {
    // Silent
  }
  client = null;
}

function flushDetached(): void {
  if (!distinctId || pendingEvents.length === 0) {
    pendingEvents = [];
    return;
  }
  try {
    const payload = JSON.stringify({
      apiKey: POSTHOG_API_KEY,
      host: POSTHOG_HOST,
      distinctId,
      events: pendingEvents,
    });
    const workerPath = path.join(__dirname, 'flush-worker.js');
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DOKKIMI_TELEMETRY_PAYLOAD: payload },
    });
    child.unref();
  } catch {
    // Never throw from telemetry shutdown
  }
  pendingEvents = [];
}

/**
 * Enable or disable telemetry. Writes to ~/.dokkimi/telemetry.json.
 */
export function setTelemetryEnabled(value: boolean): void {
  const state = readState();
  if (state) {
    state.enabled = value;
    writeState(state);
  } else {
    writeState({
      distinctId: crypto.randomUUID(),
      enabled: value,
      firstRunNoticeSeen: true,
    });
  }
  enabled = value;
  if (!value) {
    pendingEvents = [];
    if (client) {
      client.shutdown().catch(() => {});
      client = null;
    }
  }
}

/**
 * Check if telemetry is currently enabled.
 */
export function isTelemetryEnabled(): boolean {
  const state = readState();
  return state?.enabled ?? true;
}
