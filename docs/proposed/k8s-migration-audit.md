# K8s-to-Docker Migration Audit

**Branch:** `remove-k8s-v2`
**Date:** 2026-06-02
**Scope:** 103 files changed, ~8,000 lines added, ~736 deleted across 18 commits
**Method:** 6-dimension parallel review with adversarial verification of all critical findings

## Summary

The core Docker architecture — networks, container groups, dnsmasq routing, interceptor topology, db-proxy port shifting — is correctly implemented and matches the migration doc. The branch implements Phases 0-10 of the migration. Phases 11-13 (K8s code deletion, GitHub Action, docs) remain.

13 critical findings were raised across 6 review dimensions. After adversarial verification: **9 confirmed real, 2 partial, 2 false positives.** All confirmed bugs have been fixed.

---

## Bugs (all fixed)

### 1. Scheduler duplicate deploy race — CRITICAL

- **File:** `services/control-tower/src/runs/deployment-scheduler.service.ts`
- **Issue:** `deployPendingInstances` called concurrently from multiple code paths. Two callers both read the same instance as PENDING, both deploy it. The second deploy hits a 409 on network creation, throws, teardown removes the network the first deploy created, and both fail.
- **Fix:** Atomic claim via `updateMany` with `where: { status: PENDING }`. Only one caller wins; the other gets `count: 0` and skips. Also added 409 handling in `createNetwork` as defense-in-depth.
- [x] Fixed

### 2. Go health check retry reuses consumed request body

- **File:** `services/interceptor/health.go:346`
- **Issue:** `sendStatusUpdate` and `sendStatusUpdateToTestAgent` create the `http.Request` once before the retry loop. After the first `httpClient.Do(req)`, the body is drained. Retries send empty bodies.
- **Fix:** Move `http.NewRequest` inside the retry loop.
- [x] Fixed

### 3. Phase 1 used `Promise.all` instead of `allSettled`

- **File:** `services/control-tower/src/namespace-lifecycle/docker/docker-deployer.service.ts`
- **Issue:** If one container in Phase 1 failed, `Promise.all` rejected immediately while the other container was still starting. The catch block ran teardown, removing the network mid-start.
- **Fix:** All three phases now use `Promise.allSettled`.
- [x] Fixed

### 4. Instances with no test results silently pass

- **File:** `services/control-tower/src/runs/deployment-scheduler.service.ts`
- **Issue:** `checkRunCompletion` treated STOPPED instances with `testStatus: null` as successful.
- **Fix:** Treat `STOPPED && !testStatus` as failed.
- [x] Fixed

### 5. DB connection pool maps have no mutex (Go)

- **File:** `services/test-agent/database_query_executor.go`
- **Issue:** `pgPools`, `mysqlPools`, `redisClients`, `mongoClients` maps read/written without synchronization. Concurrent `dbQuery` steps could panic on map write.
- **Fix:** Added `sync.Mutex` protecting all 4 pool getter methods.
- [x] Fixed

### 6. Chromium container missing CA bundle mounts

- **File:** `services/control-tower/src/namespace-lifecycle/docker/docker-deployer.service.ts`
- **Issue:** `caBundlePaths` passed to `createChromiumGroup` but never mounted. Browser couldn't trust Dokkimi CA for HTTPS mock interception.
- **Fix:** Added `getServiceCaEnvVars()` and `getServiceCaBinds()` to chromium container.
- [x] Fixed

### 7. Inner CT crashes on database unavailability

- **File:** `services/control-tower/src/prisma/prisma.service.ts`
- **Issue:** `pg.Pool` emits unhandled `error` events when background connections fail, crashing the Node process. Also, `$connect()` is lazy (doesn't actually connect), so `connectWithRetry` succeeded without verifying the database was reachable. The first real query then crashed the process.
- **Fix:** Create `pg.Pool` explicitly with an `error` event handler. Added `SELECT 1` probe inside the retry loop to verify actual connectivity.
- [x] Fixed

### 8. No crash detection for exited containers

- **File:** `services/control-tower/src/namespace-lifecycle/docker/docker-deployer.service.ts`
- **Issue:** If a service container crashed after deployment, nothing detected it. The test-agent waited for readiness that never came, and the definition hung until timeout.
- **Fix:** Added `monitorForCrashedContainers` — polls every 3s for exited/dead containers with `service` or `database` roles. On detection, sets instance to FAILED and runs teardown.
- [x] Fixed

### 9. Docker healthcheck infrastructure was pure overhead

- **Files:** `docker-client.service.ts`, `docker-deployer.service.ts`
- **Issue:** `getDatabaseHealthcheck` generated Docker HEALTHCHECK commands that never passed (Redis auth, Postgres timing). `waitForHealthy` blocked for 30s per database container, always timed out, then proceeded anyway. The db-proxy handles readiness independently.
- **Fix:** Removed `healthcheck` option, `getDatabaseHealthcheck`, `waitForHealthy`, and all related code. The db-proxy is the readiness gate.
- [x] Fixed

---

## Phase 11: K8s Code Deletion (not yet done)

All of these are expected remaining work per the migration doc. The K8s code is disconnected from the active code path but still on disk. Watch for K8s-specific if/else branches in Go sidecars and CT code that should be collapsed to Docker-only paths.

### Files/directories to delete

- [ ] `services/control-tower/src/namespace-lifecycle/kubernetes/` — entire directory (client, resource service, helpers, kubeconfig-loader, specs)
- [ ] `services/control-tower/src/cluster-watcher/` — entire directory (removed from app.module but files remain)
- [ ] `services/control-tower/src/namespace-deployer/namespace-deployer.service.ts` — dead, replaced by DockerDeployerService
- [ ] `services/control-tower/src/namespace-deployer/namespace-deployer.module.ts` — dead, no longer imported
- [ ] `services/control-tower/src/namespace-deployer/deployer-configmap.service.ts` — dead, uses KubernetesResourceService
- [ ] `services/control-tower/src/namespace-deployer/*.spec.ts` — specs for dead services
- [ ] `services/control-tower/src/namespace-lifecycle/registry-credentials.service.ts` — K8s secret-based, replaced by DockerRegistryService
- [ ] `services/control-tower/src/namespace-lifecycle/registry-credentials.service.spec.ts`
- [ ] `services/control-tower/src/namespace-lifecycle/dokkimi-ca.service.ts` — K8s secret-based, replaced by DockerCaService
- [ ] Resource creator services that depend on KubernetesResourceService (interceptor-creator, service-interceptor-creator, test-agent-creator, chromium-creator, instance-item-creator)

### Module/provider cleanup

- [ ] Remove `KubernetesClientService` and `KubernetesResourceService` from `namespace-lifecycle.module.ts` providers and exports
- [ ] Remove old `RegistryCredentialsService` and `DokkimiCaService` from module providers/exports
- [ ] Remove resource creator services from module providers
- [ ] Remove `@kubernetes/client-node` from `services/control-tower/package.json` (~57MB of node_modules)

### Dead code in active files

- [ ] `HealthService.checkKubernetes()` — remove the method, the KubernetesClientService injection, and the `kubernetes` key from `HealthStatus` interface
- [ ] `DeploymentContext.k8sNamespaceName` — remove the field (Docker deployer never reads it). Move `deployment-context.types.ts` and `ui-step-detection.ts` out of the namespace-deployer/ directory before deleting it.
- [ ] `app.module.ts` — dead config reads for `config.clusterWatcher` intervals
- [ ] `app.module.ts` — rename `config.kubernetes.maxConcurrentNamespaces` to something Docker-appropriate
- [ ] `configmap-builder.service.ts` — remove `@kubernetes/client-node` import and `k8s.V1ConfigMap` return type; return plain object instead
- [ ] `configmap-builder.service.ts` — remove `buildFluentBitConfig` (dead in Docker mode, log collection is via Docker API)

### Go sidecar cleanup

- [ ] Interceptor: collapse `DEPLOY_MODE` if/else branches where only Docker mode remains
- [ ] Test-agent: collapse `CONFIG_SOURCE` if/else branches where only file mode remains
- [ ] Review all K8s-specific env var references (`K8S_NAMESPACE`, `K8S_DNS_IP`) and rename or remove

---

## Phase 12: GitHub Action and CI (not yet done)

### `github-action/action.yml` (user-facing action)

- **Status:** Completely unchanged on this branch. Still installs k3s, sets KUBECONFIG, pulls fluent-bit/busybox, runs k3s-uninstall.sh.
- **Impact:** Anyone using the Dokkimi GitHub Action will get a broken experience — k3s is installed but never used, wrong images are pulled, CONTROL_TOWER_HOST is set from a K8s node IP that CT ignores.
- [ ] Remove "Install k3s" step (k3s install, KUBECONFIG, CONTROL_TOWER_HOST)
- [ ] Update "Pull external images" — remove busybox and fluent-bit, keep dnsmasq
- [ ] Remove k3s-uninstall from cleanup
- [ ] Update description from "Install k3s, set up a single-node Kubernetes cluster" to Docker-only

### `.github/workflows/ci.yml` (internal CI)

- **Status:** `integration-tests` job still installs k3s, sets KUBECONFIG/CONTROL_TOWER_HOST, pulls busybox/fluent-bit, and runs k3s-uninstall on cleanup.
- [ ] Remove "Install k3s" step and KUBECONFIG/CONTROL_TOWER_HOST env setup
- [ ] Update "Pull external images" — remove busybox and fluent-bit
- [ ] Remove k3s-uninstall from cleanup
- [ ] Remove `DOKKIMI_MAX_CONCURRENT_NAMESPACES` / `DOKKIMI_MAX_BOOTING_NAMESPACES` env vars or rename to Docker-appropriate names once config keys are renamed in Phase 11
- [ ] Delete `.github/kind-config.yaml` if it exists

---

## Phase 13: Documentation and CLI (not yet done)

- [ ] `scripts/npm-readme.md` — remove "Docker Desktop with Kubernetes enabled" and "kubectl" from prerequisites, replace with "Docker"
- [ ] `dokkimi doctor` — remove `checkKubernetes()` and `checkKubeContext()` hard-failure checks, add Docker version check (20.10+)
- [ ] `dokkimi config` — remove K8s context picker
- [ ] `scripts/publish-package.json` — remove "kubernetes" from package keywords

---

## Concerns (not blockers)

These are real issues that are low-severity or acceptable tradeoffs for a local dev tool.

| Issue | File | Notes |
|---|---|---|
| MongoDB entrypoint shell injection | `docker-deployer.service.ts` | `dbUser`/`dbPassword` with single quotes would break the shell string. Defaults (`dokkimi`/`dokkimi`) are safe. Consider escaping if custom creds are supported. |
| Temp files use default permissions | `docker-config.service.ts` | `/tmp/dokkimi-{instanceId}` created with default perms. Predictable path. Low risk for a local dev tool, but `mkdtemp` or `mode: 0o700` would be more robust. |
| Log collector cross-chunk frame splits | `docker-log-collector.service.ts` | Docker multiplexed log streams could split a frame header across two data callbacks. Rare in practice but would produce garbled log entries. |
| `host.docker.internal` injected unconditionally | `docker-client.service.ts` | Migration doc says Linux-only. Code injects it for all platforms. Works on macOS but is technically unnecessary — Docker Desktop handles it natively. |
| Domain entries in urlMap missing port | `configmap-builder.service.ts` | k8sName entries include port, but domain entries do not. Interceptor's `appendServicePort()` handles this for k8sName-based routing, but domain-based routing may default to 80/443. |

---

## Test Coverage Gaps

| Area | Gap |
|---|---|
| `pullAllImages` | No test that all image types (infra, user, DB, browser) are pulled |
| User-defined env var merging | Array and object env var formats (deployer lines 519-530) untested |
| Go `FileConfigLoader` | No dedicated tests for malformed JSON, missing keys, or partial config |
| Go `rewriteLocationHeader` | Localhost/0.0.0.0/127.0.0.1 rewrite paths untested in proxy_test.go |

---

## Code Cleanup (post-migration)

- [ ] Break up `docker-deployer.service.ts` (1089 lines) into smaller files:
  - Deploy orchestration (phase coordination, crash monitor, teardown)
  - Service group builder (createServiceGroup, createGlobalInterceptor, createTestAgent, createChromiumGroup)
  - Database group builder (createDatabaseGroup, buildMongoEntrypoint, port shifting helpers)
  - Config/dnsmasq builder (writeConfig, buildDnsmasqConfig)
  - Image pulling (pullAllImages)

---

## Architecture Verdict

The Docker migration is architecturally correct and the right direction for Dokkimi:

- Container topology matches the migration doc (interceptor standalone, user container primary with alias, dnsmasq joins namespace, db-proxy primary, database joins db-proxy namespace)
- Networking flow is correct (service → dnsmasq → interceptor IP → Docker DNS → target)
- Database port shifting works (PGPORT, MYSQL_TCP_PORT, command args for Redis/MongoDB)
- Config delivery (bind-mounted JSON) replaces K8s ConfigMaps correctly
- CA handling (filesystem-based) replaces K8s Secrets correctly
- Log collection (Docker API streaming) replaces Fluent Bit sidecars correctly
- All bugs fixed. The Phase 11-13 work is mechanical deletion and text edits.
