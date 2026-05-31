# Proposal: Migrate from Kubernetes to Docker-Native Architecture

## Motivation

Dokkimi currently requires a running Kubernetes cluster to create isolated test environments. This proposal replaces K8s with plain Docker containers and Docker networks, achieving the same isolation guarantees with significantly less operational complexity and faster startup times.

## Advantages

### 1. Test Startup Time

**Current (K8s):**
- Namespace creation + service account setup: ~500ms
- Scheduler → kubelet → container start per pod: ~2-5s each
- Readiness probe convergence: ~2-10s (depends on initialDelaySeconds + intervals)
- Total for a 3-service environment: **15-45 seconds**

**Proposed (Docker):**
- `docker network create`: ~50ms
- `docker run` per container (cached image): ~200-500ms
- DNS available immediately (Docker embedded DNS)
- Total for a 3-service environment: **2-5 seconds**

The difference compounds with test parallelism. Running 10 test suites concurrently means 10 namespaces competing for scheduler time in K8s vs. 10 independent Docker networks with no shared bottleneck.

### 2. User Installation Simplicity

**Current requirements:**
- Docker (for building images)
- A running Kubernetes cluster (minikube, kind, Docker Desktop K8s, or remote)
- kubectl configured with appropriate context
- Sufficient cluster resources for multiple namespaces

**Proposed requirements:**
- Docker

That's it. No cluster, no kubeconfig, no context switching, no resource quotas to manage. The barrier to first test run drops from "configure a K8s cluster" to "have Docker installed."

### 3. No Orchestrator Overhead

K8s is a declarative reconciliation system. You declare desired state, then multiple controllers (scheduler, kubelet, endpoint controller, DNS controller) converge on it asynchronously. For ephemeral test environments that live seconds to minutes, this model provides no benefit — you want imperative "run this now" semantics.

Docker gives imperative control: start a container, it starts. Stop it, it stops. No reconciliation loops, no eventual consistency, no watching for state convergence.

### 4. Simpler Debugging

When something fails in K8s, the failure surface includes: scheduling failures, image pull backoff, CrashLoopBackOff, readiness probe failures, DNS propagation delays, RBAC denials, resource limit evictions. With Docker, a container either starts or it doesn't — the failure modes are fewer and more direct.

### 5. Resource Efficiency

K8s system components (API server, etcd, scheduler, kubelet, kube-proxy, CoreDNS) consume memory and CPU even when idle. A kind cluster takes ~500MB+ RAM before a single user container runs. Docker's overhead is near-zero when no containers are running.

---

## Feature Parity Analysis

Every K8s feature currently used maps to a Docker-native equivalent:

### Namespace Isolation → Docker Networks

| K8s | Docker |
|-----|--------|
| One namespace per test run | One Docker network per test run |
| Pods within namespace can reach each other by service name | Containers on same network can reach each other by container name/alias |
| Pods across namespaces cannot communicate | Containers on different networks cannot communicate |
| `kubectl delete namespace X` removes everything | `docker network rm X` + `docker rm` removes everything |

Docker networks provide identical network-level isolation. Two containers on different networks cannot communicate — period. Same guarantee as K8s namespaces with default network policies.

### Service Discovery (DNS) → Docker Embedded DNS

| K8s | Docker |
|-----|--------|
| `<service>.<namespace>.svc.cluster.local` | Container name or network alias |
| CoreDNS resolves service names to ClusterIPs | Docker's embedded DNS (127.0.0.11) resolves container names to IPs |
| Services load-balance across pod IPs | Single container per "service" — no load balancing needed |

Docker's built-in DNS resolves container names within a network. If you start a container with `--name payment-service --network dokkimi-run-abc`, other containers on that network can reach it at `payment-service`. No external DNS server needed.

### Sidecar Pattern → Shared Network Namespace

| K8s | Docker |
|-----|--------|
| Multiple containers per pod share `localhost` | `--network=container:<other>` shares network namespace |
| Pod-level DNS config applies to all containers | DNS config on the "primary" container applies to the shared namespace |

Docker supports sharing a container's network namespace via `--network=container:<id>`. The interceptor container starts first, then the user's service container joins its network namespace — they share `localhost`, same as a K8s pod. The dnsmasq sidecar also joins the same network namespace.

### ConfigMaps → Config Files or Environment Variables

| K8s | Docker |
|-----|--------|
| ConfigMap mounted as file | `--mount type=bind,src=<host-path>,dst=<container-path>` or `--mount type=tmpfs` with content written by Control Tower |
| ConfigMap as env vars | `--env` or `--env-file` |

Control Tower already generates the ConfigMap content (urlMap, httpMocks, databaseMap, etc.). Instead of writing it to a K8s ConfigMap, write it to a temp file on the host and bind-mount it into the interceptor container.

### Secrets (CA Certs, Registry Creds) → Volume Mounts

| K8s | Docker |
|-----|--------|
| Secret mounted as volume | Bind-mount from host filesystem |
| dokkimi-ca-cert distributed per namespace | CA cert file written once to temp dir, mounted into all containers in the run |
| registry-creds for private images | `docker login` (already authenticated) or `--auth` on pull |

The Dokkimi CA generation stays the same (node-forge in Control Tower). Instead of storing it in a K8s Secret and copying between namespaces, write `ca.crt` and `ca.key` to a temp directory and bind-mount into containers that need them.

For private registries: Docker already handles authentication via `~/.docker/config.json`. No separate credential copying needed — if the user can `docker pull` the image, the container runtime can too.

### Init Containers → Multi-stage Container Start

| K8s | Docker |
|-----|--------|
| Init container runs before main, shares volumes | Run a prep container first, output to a shared volume, then start main containers mounting that volume |

The CA bundle init container (combines system CAs + Dokkimi CA, creates Java truststore) can either:
1. Run as a short-lived Docker container that writes to a named volume, then main containers mount that volume.
2. Be done by Control Tower directly on the host (generate the combined bundle, write to temp dir, bind-mount).

Option 2 is simpler — Control Tower already has the CA cert and can produce the bundle without spawning a container.

### Deployments (Restart Policy) → Docker Restart Policies

| K8s | Docker |
|-----|--------|
| Deployment with replicas=1 auto-restarts crashed pods | `--restart=on-failure` or `--restart=unless-stopped` |

For test environments that live minutes, restart isn't critical — a crashed container likely means the test should fail, not retry. But `--restart=on-failure:3` gives equivalent behavior if needed.

### Health/Readiness Probes → Docker Healthchecks

| K8s | Docker |
|-----|--------|
| Liveness probe (restart on failure) | `--health-cmd` + `--restart=on-failure` |
| Readiness probe (gate traffic until ready) | `--health-cmd` + wait for "healthy" status before starting tests |

Docker healthchecks report container health state. Control Tower (or test-agent) polls `docker inspect` for health status before starting test execution — same as waiting for readiness probes today.

### RBAC (ServiceAccounts, Roles) → Not Needed

RBAC exists because K8s is a multi-tenant system where pods might access the API server. In the Docker model, containers don't talk to an orchestrator API — they just talk to each other on the network. The interceptor reads its config from a mounted file, not from a K8s API call. The test-agent reads its config the same way. No RBAC needed.

### Probes & Health Reporting → Direct HTTP

The interceptor currently reports health to Control Tower via `POST /health/status`. This works identically over Docker networking — the interceptor container can reach Control Tower at its host-accessible port. No change needed.

### Fluent Bit (Log Collection) → Docker Log Driver or Direct Capture

| K8s | Docker |
|-----|--------|
| fluent-bit sidecar tails /var/log/containers | `docker logs --follow <container>` streamed by Control Tower |

Docker provides native log access via the Docker API (`/containers/{id}/logs`). Control Tower can stream logs from each container directly — no fluent-bit sidecar needed. This eliminates one container per service/database.

Alternatively, use Docker's `fluentd` or `syslog` log driver to ship logs directly to Control Tower's log endpoint. Either way, the fluent-bit sidecar becomes unnecessary.

### Image Pull Policy → Docker Pull Behavior

Docker pulls images only if not present locally (equivalent to `IfNotPresent`). For explicit freshness, `docker pull` before `docker run`. Same behavior, no configuration needed.

---

## Architecture: Container Topology Per Test Run

```
Docker Network: dokkimi-run-{instanceId}
│
├─ [interceptor-global]
│    Ports: 80, 443
│    Mounts: config.json (urlMap, mocks, dbMap), ca.crt, ca.key
│    DNS: Docker embedded (resolves other containers by name)
│
├─ [service-a-group] (shared network namespace)
│    ├─ service-a-interceptor (ports 80, 443, service port)
│    ├─ dnsmasq (port 53, routes * → interceptor, db names → Docker DNS)
│    └─ service-a (user's container, joins interceptor's network ns)
│    Network alias: "service-a"
│
├─ [service-b-group] (shared network namespace)
│    ├─ service-b-interceptor
│    ├─ dnsmasq
│    └─ service-b (user's container)
│    Network alias: "service-b"
│
├─ [postgres-db-group] (shared network namespace)
│    ├─ db-proxy-postgres (listens on 5432, proxies to localhost:55432)
│    └─ postgres (shifted to port 55432 via PGPORT, only reachable via db-proxy)
│    Network alias: "postgres-db"
│
├─ [test-agent]
│    Mounts: config.json (testConfig, urlMap)
│    Communicates with Control Tower via host network
│
└─ [chromium] (if UI tests)
     Port: 9222 (CDP)
```

### Control Tower's Role

Control Tower runs as a **host process** (not containerized). It owns the Docker socket, orchestrates container lifecycle, and streams logs directly from containers via the Docker API. Test containers reach Control Tower via the host network — Docker provides `host.docker.internal` as a DNS name that resolves to the host machine from within containers (works on Mac, Windows, and Linux with Docker 20.10+).

This is the same model as today (CT runs on host, talks to K8s API). The only change is the API it calls.

### Container Startup Sequence (Concrete Example)

For a service group (e.g., `service-a`), the exact Docker sequence:

```bash
# 1. Start the per-service interceptor — this is the "primary" container
#    that holds the Docker network connection and network alias.
docker create \
  --name service-a-interceptor-${instanceId} \
  --network dokkimi-run-${instanceId} \
  --network-alias service-a \
  -e PORT=80 \
  -e CONTROL_TOWER_URL=http://host.docker.internal:19001 \
  -e DNS_IP=127.0.0.11 \
  -v ${configDir}/config.json:/etc/dokkimi/config.json:ro \
  -v ${caDir}/ca.crt:/etc/ssl/certs/dokkimi-ca.crt:ro \
  -v ${caDir}/ca.key:/etc/ssl/certs/dokkimi-ca.key:ro \
  ghcr.io/dokkimi/interceptor:latest
docker start service-a-interceptor-${instanceId}

# 2. Start dnsmasq — joins the interceptor's network namespace (shares localhost)
docker create \
  --name service-a-dnsmasq-${instanceId} \
  --network container:service-a-interceptor-${instanceId} \
  -v ${configDir}/dnsmasq-service-a.conf:/etc/dnsmasq.conf:ro \
  andyshinn/dnsmasq:2.83
docker start service-a-dnsmasq-${instanceId}

# 3. Start user's service — also joins interceptor's network namespace
docker create \
  --name service-a-${instanceId} \
  --network container:service-a-interceptor-${instanceId} \
  --dns 127.0.0.1 \
  -e NODE_EXTRA_CA_CERTS=/etc/ssl/certs/dokkimi-ca.crt \
  -e SSL_CERT_FILE=/ca-bundle/ca-bundle.crt \
  -v ${caDir}/ca-bundle.crt:/ca-bundle/ca-bundle.crt:ro \
  -v ${caDir}/dokkimi-ca.crt:/etc/ssl/certs/dokkimi-ca.crt:ro \
  user-image:tag
docker start service-a-${instanceId}
```

**Why the interceptor is "primary":** It's the container connected to the Docker network with the alias `service-a`. When any other container on the network resolves `service-a`, Docker DNS returns the interceptor's IP. Traffic always hits the interceptor first — same as K8s where the Service pointed to the interceptor's ClusterIP.

**Why `--dns 127.0.0.1` on the user container:** Forces the user's service to use dnsmasq (running on localhost in the shared network namespace) for DNS. dnsmasq then routes:
- All HTTP hostnames → `127.0.0.1` (the interceptor, also on localhost)
- Database names → `127.0.0.11` (Docker's embedded DNS, which resolves to the db-proxy container on the network)

**Why the interceptor uses `DNS_IP=127.0.0.11`:** When forwarding to an upstream service, the interceptor must bypass dnsmasq (otherwise it would resolve back to itself in a loop). It queries Docker's embedded DNS directly at `127.0.0.11`, which resolves `service-b` → the IP of service-b's interceptor on the Docker network.

### Key Networking Details

**Service-to-service routing (full flow):**
1. `service-a` calls `http://service-b/api/users`
2. `service-a`'s DNS (`--dns 127.0.0.1`) hits dnsmasq
3. dnsmasq resolves `service-b` → `127.0.0.1` (catch-all to local interceptor)
4. `service-a-interceptor` receives the request, logs it, checks mocks
5. No mock match → forward to real `service-b`
6. Interceptor resolves `service-b` via Docker DNS (`127.0.0.11`) → gets `172.18.0.X` (service-b-interceptor's Docker network IP)
7. Request arrives at `service-b-interceptor`, which forwards to `localhost:<service-port>` (the actual service-b container in the shared network namespace)
8. Response flows back through both interceptors (both log the traffic)

**Mock DNS routing:**
- dnsmasq resolves `api.stripe.com` → `127.0.0.1` (the local interceptor)
- Interceptor checks mock config, returns mock response
- Identical to current behavior

**Database routing:**
- dnsmasq config has explicit entry: `server=/postgres-db/127.0.0.11` (forward to Docker DNS, not to interceptor)
- Docker DNS resolves `postgres-db` → the db-proxy container's IP on the network
- Service connects to `postgres-db:<proxy-port>` → hits db-proxy, which proxies to the real database on `localhost:<native-port>` in its own shared network namespace

**Important K8s→Docker port mapping difference:** In K8s, a K8s Service maps the well-known port (e.g. 5432 for Postgres) to the db-proxy's actual listen port (e.g. 15432). Callers connect to `postgres-db:5432` and K8s transparently routes to port 15432 on the db-proxy pod. In Docker, we replicate this by shifting the database's internal port and having the db-proxy listen on the standard port:
- The database container is configured to listen on a non-standard internal port (e.g. Postgres on 55432 via `PGPORT`, MySQL on 33306 via `MYSQL_TCP_PORT`)
- The db-proxy listens on the standard port (5432, 3306, 6379, 27017) via `QUERY_PORT` env var
- The db-proxy forwards to the shifted internal port via `DATABASE_PORT` env var
- Callers use the standard port (e.g. `postgres-db:5432`) and traffic goes through the db-proxy, matching K8s behavior exactly

---

## Cleanup/Teardown

```
1. docker kill $(docker ps -q --filter network=dokkimi-run-{instanceId})
2. docker rm $(docker ps -aq --filter network=dokkimi-run-{instanceId})
3. docker network rm dokkimi-run-{instanceId}
```

Or using the Docker API programmatically: disconnect all containers from the network, remove them, remove the network. Atomic, instant, no polling for namespace deletion.

---

## Cons

### 1. No Production Environment Parity (for K8s users)

If a user's production runs on K8s, testing on plain Docker means the test environment differs from production in:
- No K8s DNS search domains (`svc.cluster.local`)
- No K8s service accounts or projected volumes
- No K8s init container ordering guarantees (must be replicated manually)
- No network policies (though Dokkimi doesn't use these today)

For most microservice tests (HTTP request/response, database queries, mock verification), these differences are irrelevant. They matter only if the application code itself interacts with the K8s API (reading ConfigMaps, calling the downward API, etc.) — which is rare in the services-under-test.

### 2. No Built-in Resource Limits Across a Run

K8s namespaces can have ResourceQuotas that cap total CPU/memory for all pods in the namespace. Docker has per-container limits (`--memory`, `--cpus`) but no grouping mechanism. If a test environment is consuming too many resources, there's no single knob to throttle the whole group.

Mitigation: set per-container limits based on the definition file's resource config. For local dev this is rarely needed.

### 3. Multi-Host Scaling (Future Cloud Product)

If Dokkimi eventually offers a hosted multi-tenant service where many users submit test runs to a shared pool of machines, you lose K8s's scheduler (bin-packing pods across nodes). You'd need to build or adopt a simpler scheduler (e.g., a queue + worker pool model where each worker machine runs N concurrent Docker test environments).

This is a real cost, but it's a future-product concern, not a current-product concern. And simpler orchestrators (Nomad, ECS, even a custom queue) can handle this without full K8s.

### 4. Docker-in-Docker Complications (CI Environments)

Some CI systems (GitHub Actions, GitLab CI) run jobs inside containers. Running Docker inside Docker requires either:
- Docker socket mounting (`-v /var/run/docker.sock:/var/run/docker.sock`) — works but has security implications
- Docker-in-Docker (dind) — adds another layer

This is solvable and common (many CI tools already do this), but it's a support surface that K8s avoids (the cluster exists outside the CI runner).

### 5. Log Collection Without Fluent Bit

Streaming logs via `docker logs` or the Docker API is simpler but less battle-tested for high-throughput scenarios. If a service produces massive log volume, streaming via the Docker API puts load on the Docker daemon. Unlikely to matter for test environments, but worth noting.

---

## Key Dependency Change

**Remove:** `@kubernetes/client-node`
**Add:** `dockerode` (Node.js Docker client)

`dockerode` is the standard Node.js library for the Docker Engine API (~4k GitHub stars). It communicates via HTTP over the Docker socket and auto-detects the socket location per platform (`/var/run/docker.sock` on Mac/Linux, named pipe on Windows). No configuration needed — if Docker is running, it connects.

```typescript
import Docker from 'dockerode';
const docker = new Docker(); // auto-detects socket per OS

await docker.createNetwork({ Name: `dokkimi-run-${instanceId}` });

const container = await docker.createContainer({
  Image: 'ghcr.io/dokkimi/interceptor:latest',
  name: `interceptor-${instanceId}`,
  Env: ['PORT=80', `CONTROL_TOWER_URL=${ctUrl}`],
  HostConfig: {
    NetworkMode: `dokkimi-run-${instanceId}`,
    Binds: [`${configDir}/config.json:/etc/dokkimi/config.json:ro`],
  },
});
await container.start();
```

Compared to `@kubernetes/client-node`, there's no kubeconfig loading, no context switching, no API versioning (CoreV1 vs AppsV1 vs NetworkingV1), and no async reconciliation patterns. One client, one socket, imperative calls.

**Package size impact:** `@kubernetes/client-node` installs at **57MB** (includes openid-client, socks-proxy-agent, ws, node-fetch, and 15+ transitive deps for auth/kubeconfig/WebSocket support). `dockerode` is **~165KB** with ~15-20MB of transitive deps (grpc-js, protobufjs). Net savings: **~35-40MB** off `node_modules`.

---

## Migration Steps

### Phase 1: Docker Container Manager (replaces K8s client)

**Replace:** `namespace-lifecycle/kubernetes/kubernetes-client.service.ts`, `kubernetes-resource.service.ts`

**Build:** A `DockerClientService` that wraps `dockerode`. Methods:

- `createNetwork(instanceId)` → creates Docker network
- `removeNetwork(instanceId)` → kills containers + removes network
- `runContainer(opts)` → starts a container with network, env, mounts, network-mode
- `getContainerHealth(containerId)` → returns health status
- `streamLogs(containerId, callback)` → streams stdout/stderr
- `inspectContainer(containerId)` → returns IP, status, etc.

**Effort:** ~300-400 lines. The Docker API is simpler than the K8s API — fewer resources, no async reconciliation, no watch/retry patterns.

### Phase 2: Deployment Builders → Container Spec Builders

**Replace:** `service-deployment-builder.service.ts`, `database-deployment-builder.service.ts`

**Build:** Functions that produce Docker container configs instead of K8s Deployment manifests:

- **Service group:** 3 `docker run` calls (interceptor first, then dnsmasq + user container joining its network namespace)
- **Database group:** 2 `docker run` calls (db-proxy first, then database joining its network namespace)
- **Test agent:** 1 `docker run` call
- **Chromium:** 1 `docker run` call

The logic for computing env vars, building dnsmasq configs, and generating interceptor config stays identical — only the output format changes (Docker run options instead of K8s pod specs).

**Effort:** The builders are ~400 lines each currently. The Docker equivalents will be shorter (no RBAC, no probes spec, no volume claim templates). Estimate ~200-300 lines each.

### Phase 3: ConfigMap → Mounted Config Files

**Replace:** `configmap-builder.service.ts`

**Change:** Instead of calling `k8sClient.createConfigMap()`, write the same JSON content to a temp file on the host and return the path for bind-mounting.

```typescript
const configDir = path.join(os.tmpdir(), `dokkimi-${instanceId}`);
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(configData));
// Mount: -v ${configDir}/config.json:/etc/dokkimi/config.json:ro
```

**Effort:** Minimal. The config content generation doesn't change. Only the "where it goes" changes from K8s API call to file write.

### Phase 4: CA Certificate Handling

**Replace:** `dokkimi-ca.service.ts` (the K8s secret storage part)

**Change:** 
- CA generation stays the same (node-forge, RSA 4096)
- Instead of storing in a K8s Secret in `dokkimi-system` and copying per namespace, store CA cert + key in `~/.dokkimi/ca/` (persistent across runs)
- CA bundle preparation (combining system CAs + Dokkimi CA) done by Control Tower directly:
  - Write combined bundle to `${configDir}/ca-bundle.crt`
  - Write Java truststore to `${configDir}/java-cacerts` (via `keytool` or a JS implementation)
  - Bind-mount into containers

**Effort:** Simpler than current. Removes all the cross-namespace Secret copying logic.

### Phase 5: Registry Credentials → Docker Native Auth

**Replace:** `registry-credentials.service.ts`

**Change:** Remove entirely. Docker uses `~/.docker/config.json` for registry auth. If the user can `docker pull` an image, containers can use it. No credential copying needed.

If supporting explicit per-definition registry auth (for CI where Docker isn't pre-authenticated), use `docker login` programmatically before the run, or pass `--auth` config to the Docker API pull call.

**Effort:** Net deletion of code. The current registry credential flow is ~200 lines that go away.

### Phase 6: Namespace Deployer → Docker Orchestrator

**Replace:** `namespace-deployer.service.ts`

**Build:** A `DockerDeployerService` that orchestrates the startup sequence:

1. Create Docker network
2. Write config files to temp dir
3. Write CA bundle to temp dir
4. Start global interceptor container
5. For each service: start interceptor → start dnsmasq → start user container (joining interceptor network ns)
6. For each database: start db-proxy → start database (joining db-proxy network ns)
7. Start test-agent
8. Start chromium (if UI tests)
9. Stream logs from all containers
10. Wait for test-agent to report completion

The ordering logic is the same as today. The "start" action changes from "create K8s Deployment and wait for readiness" to "docker run and wait for healthcheck."

**Effort:** ~200-300 lines. Simpler than current because no async reconciliation — each step is synchronous (container is running or it failed).

### Phase 7: Cleanup/Teardown

**Replace:** `namespace-lifecycle.service.ts` (the K8s deletion + polling logic)

**Build:** 
```typescript
async stopInstance(instanceId: string) {
  const containers = await docker.listContainers({ 
    filters: { network: [`dokkimi-run-${instanceId}`] } 
  });
  await Promise.all(containers.map(c => docker.getContainer(c.Id).remove({ force: true })));
  await docker.getNetwork(`dokkimi-run-${instanceId}`).remove();
  // Clean up temp config dir
  fs.rmSync(path.join(os.tmpdir(), `dokkimi-${instanceId}`), { recursive: true });
}
```

**Effort:** ~30 lines. Replaces the current polling loop that waits for K8s namespace deletion.

### Phase 8: Log Collection (Replace Fluent Bit)

**Replace:** Fluent-bit sidecar container in every pod

**Build:** Control Tower streams logs via Docker API:
```typescript
const stream = await container.logs({ follow: true, stdout: true, stderr: true });
stream.on('data', (chunk) => processLog(instanceId, itemId, chunk));
```

**Effort:** ~50-100 lines in Control Tower. Eliminates the fluent-bit container entirely (one fewer container per service and database — significant resource savings).

### Phase 9: Test Agent Adaptation

**Current:** Test-agent reads config from a K8s ConfigMap via the K8s API, and discovers services via K8s DNS.

**Change:** Test-agent reads config from a mounted file (`/etc/dokkimi/config.json`) instead of calling the K8s API. Service discovery works via Docker DNS (container names on the network). The test execution logic, HTTP request making, and completion notification are unchanged.

**Effort:** Small change in test-agent's Go code — replace the ConfigMap watcher with a file watcher (or just read-once-at-startup, since config doesn't change mid-run). ~50 lines changed.

### Phase 10: Interceptor Adaptation

**Current:** Interceptor uses `K8S_DNS_IP` env var to resolve upstream services (bypassing dnsmasq to avoid circular routing).

**Change:** Replace with Docker's embedded DNS (`127.0.0.11`). The interceptor resolves upstream service names via Docker DNS instead of kube-dns. Same principle, different IP.

**Effort:** Change one env var value. The interceptor code already supports configurable DNS resolution — just point it at Docker's DNS instead of kube-dns.

### Phase 11: Remove K8s Dependencies

- Remove `@kubernetes/client-node` from package.json
- Remove `kubeconfig-loader.ts`
- Remove all RBAC-related code (ServiceAccounts, Roles, RoleBindings)
- Remove cluster-watcher module (no longer needed — Docker containers don't have a "Terminating" state that needs polling)
- Remove `kubernetes-helpers.ts` (retry/backoff logic for K8s API errors)

**Effort:** Net deletion of ~1000+ lines.

### Phase 12: GitHub Action — Remove K8s, Simplify to Docker-Only

**Replace:** `github-action/action.yml`

The current GitHub Action (`github-action/action.yml`) installs a full k3s cluster before running tests:

```yaml
# Current flow (k3s):
- Free disk space
- Install k3s (curl | sh, wait for node Ready)
- Pull sidecar images (busybox, fluent-bit, dnsmasq)
- Install Dokkimi CLI
- Run tests (dokkimi run --ci)
- Cleanup (dokkimi clean + k3s-uninstall.sh)
```

After migration, the action becomes:

```yaml
# New flow (Docker-only):
- Free disk space
- Pull Dokkimi sidecar images (interceptor, db-proxy, test-agent, dnsmasq)
- Install Dokkimi CLI
- Run tests (dokkimi run --ci)
- Cleanup (dokkimi clean)
```

**What changes:**

1. **Remove the "Install k3s" step entirely.** GitHub Actions runners have Docker pre-installed and the socket is available by default. No cluster setup, no waiting for node Ready, no KUBECONFIG export.
2. **Remove CONTROL_TOWER_HOST logic.** Currently extracts the node's InternalIP so Control Tower can be reached from inside the cluster. With Docker, Control Tower runs on the host and containers reach it via `host.docker.internal` (injected automatically by DockerClientService on Linux).
3. **Update image pre-pull list.** Remove `busybox:1.37` (init container, no longer needed) and `fluent/fluent-bit:3.2` (log sidecar, replaced by Docker log API). Keep `andyshinn/dnsmasq:2.83`. Add Dokkimi sidecar images (`ghcr.io/dokkimi/interceptor`, etc.) if not already cached in the runner.
4. **Remove k3s-uninstall.sh from cleanup.** `dokkimi clean` handles Docker cleanup (containers + networks). No cluster to tear down.
5. **Remove KUBECONFIG env var** from the action and from `GITHUB_ENV`.
6. **Remove `kind-config.yaml`** (`.github/kind-config.yaml`) — no longer needed.

**Updated action.yml:**

```yaml
name: Dokkimi Run Tests
description: Run Dokkimi integration tests using Docker.
branding:
  icon: check-circle
  color: blue
inputs:
  tests:
    description: Path to .dokkimi/ directory or a specific definition file
    required: true
  max-parallel:
    description: Maximum concurrent test environments
    default: '6'
  max-booting:
    description: Maximum environments booting simultaneously
    default: '2'
  timeout:
    description: HTTP request timeout in milliseconds
    default: '30000'
  viewport-width:
    description: Default browser viewport width for UI tests
    default: '1280'
  viewport-height:
    description: Default browser viewport height for UI tests
    default: '720'
  dokkimi-version:
    description: Dokkimi CLI version to install
    default: latest

runs:
  using: composite
  steps:
    - name: Free disk space
      shell: bash
      run: |
        sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc /usr/local/share/powershell
        docker builder prune -af

    - name: Pull sidecar images
      shell: bash
      run: |
        docker pull andyshinn/dnsmasq:2.83

    - name: Install Dokkimi CLI
      shell: bash
      run: |
        if [ "${{ inputs.dokkimi-version }}" = "latest" ]; then
          npm install -g dokkimi
        else
          npm install -g dokkimi@${{ inputs.dokkimi-version }}
        fi

    - name: Run tests
      shell: bash
      env:
        DOKKIMI_MAX_CONCURRENT_NAMESPACES: ${{ inputs.max-parallel }}
        DOKKIMI_MAX_BOOTING_NAMESPACES: ${{ inputs.max-booting }}
        DOKKIMI_HTTP_TIMEOUT: ${{ inputs.timeout }}
        DOKKIMI_DEFAULT_VIEWPORT_WIDTH: ${{ inputs.viewport-width }}
        DOKKIMI_DEFAULT_VIEWPORT_HEIGHT: ${{ inputs.viewport-height }}
      run: dokkimi run ${{ inputs.tests }} --ci

    - name: Cleanup
      if: always()
      shell: bash
      run: dokkimi clean 2>/dev/null || true
```

**CI startup time savings:** The k3s install + wait-for-ready step takes 10-20 seconds on GitHub Actions runners. Eliminating it means tests start sooner and the action YAML is half the size.

**Effort:** Minimal — editing one YAML file and deleting another. But this is user-facing (anyone using the Dokkimi GitHub Action gets the change), so it should ship alongside or shortly after the Control Tower migration, not before.

### Phase 13: Update Prerequisites and CLI Documentation

**Replace:** `scripts/npm-readme.md`, `dokkimi doctor` checks

The npm README currently lists prerequisites as:
- Node.js 20+
- Docker Desktop with Kubernetes enabled
- kubectl

After migration:
- Node.js 20+
- Docker

**Changes:**
1. **`scripts/npm-readme.md`** — remove "Docker Desktop with Kubernetes enabled" and "kubectl" from prerequisites. Replace with just "Docker". Update the project description from "isolated Kubernetes sandboxes" to "isolated Docker sandboxes" (or similar). Remove `dokkimi uninstall` from the commands table (no cluster resources to uninstall).
2. **`dokkimi doctor`** — remove K8s-related checks (cluster reachable, context valid, kubectl installed). Keep Docker socket check. Add a check for minimum Docker version (20.10+ for `host.docker.internal` on Linux).
3. **`dokkimi config`** — remove K8s context picker. No kubeconfig interaction needed.
4. **`scripts/publish-package.json`** — remove "kubernetes" from package keywords.

**Effort:** Small. Mostly text edits and deletion of K8s prerequisite checks.

---

## Summary of Effort

| Phase | Description | Lines (estimate) | Net change |
|-------|-------------|-----------------|------------|
| 1 | Docker Client Service | ~350 new | +350 |
| 2 | Container Spec Builders | ~500 new | replaces ~800 |
| 3 | Config as mounted files | ~30 new | replaces ~150 |
| 4 | CA cert handling | ~50 new | replaces ~200 |
| 5 | Registry credentials | 0 new | deletes ~200 |
| 6 | Docker Orchestrator | ~250 new | replaces ~300 |
| 7 | Cleanup/teardown | ~30 new | replaces ~150 |
| 8 | Log collection (no fluent-bit) | ~80 new | replaces sidecar |
| 9 | Test-agent config reading | ~50 changed | — |
| 10 | Interceptor DNS config | ~5 changed | — |
| 11 | Remove K8s code | 0 new | deletes ~1000+ |
| 12 | GitHub Action (remove k3s) | ~30 new | replaces ~50 |
| 13 | Update prerequisites & docs | ~10 new | replaces ~30 |

**Total new code:** ~1,340 lines
**Total deleted code:** ~2,880+ lines
**Net:** ~1,540 fewer lines of infrastructure code

The Go sidecars (interceptor, db-proxy, test-agent) need minimal changes — they're already container-native and communicate via HTTP/DNS. The bulk of the work is in Control Tower's TypeScript orchestration layer, replacing K8s API calls with Docker API calls.

---

## Suggested Migration Order

1. **Phase 1 + 7 first** — build DockerClientService and cleanup. This gives you the foundation and lets you test basic container lifecycle.
2. **Phase 3 + 4 + 5** — config and certs. Quick wins that remove K8s-specific plumbing.
3. **Phase 2 + 6** — builders and orchestrator. The core of the migration.
4. **Phase 8** — log collection. Can be done in parallel with phase 2.
5. **Phase 9 + 10** — sidecar adaptations. Small, testable changes.
6. **Phase 11** — cleanup. Remove all K8s code once Docker path is working.
7. **Phase 12 + 13** — GitHub Action and docs. Ship after Control Tower migration is verified. Phase 12 updates the user-facing GitHub Action (remove k3s, simplify to Docker-only). Phase 13 updates npm README, `dokkimi doctor`, and CLI config.

Phases 1-5 could be done behind a feature flag, allowing both Docker and K8s paths to coexist during development. But given the simplification, a clean cutover is likely less effort than maintaining both.

---

## Parallel Run Capacity

The current K8s setup supports ~6 concurrent definition runs before resource exhaustion causes throttling and crashes. Docker-native should roughly double or triple this.

**Why K8s limits parallelism:**

- K8s system components (API server, etcd, kubelet, kube-proxy, CoreDNS) consume ~500MB-1GB RAM at rest, regardless of how many runs are active
- Each run currently spawns ~17 containers (3 per service pod including fluent-bit, 3 per database pod, plus interceptors and test-agent). At 6 runs with a 3-service definition, that's ~100 containers with K8s bookkeeping overhead per pod
- etcd writes scale with resource count — 100+ Deployments/Services/ConfigMaps/Secrets creates write pressure
- kubelet housekeeping (probe checks, status reporting) scales per-pod and competes for CPU
- The scheduler makes placement decisions even on a single-node cluster — wasted work

**What Docker eliminates:**

- No system components eating base RAM (~500MB-1GB reclaimed)
- No fluent-bit sidecar per service/database (~30-50MB each, ~150MB+ per run saved)
- No per-pod bookkeeping — Docker daemon tracks containers with minimal overhead
- No etcd, no scheduler, no reconciliation loops consuming CPU
- Container startup is direct (no scheduler → kubelet → CRI chain)

**Estimated improvement:** 6 concurrent runs → 12-18 on the same hardware, depending on whether RAM or CPU is the current bottleneck. The Docker daemon itself handles hundreds of containers without issue — the limit becomes purely the resource needs of the user's actual services.

---

## Cloud Architecture (Planned, Not Yet Built)

The planned cloud architecture launches separate VMs per test run:

```
User triggers cloud run → grab pre-warmed VM from pool →
push definition + dump config → Dokkimi starts →
containers spin up → tests execute → dump file uploaded to main server →
VM destroyed or recycled to pool
```

**How Docker-native makes this better:**

- **Smaller VM image:** Docker runtime (~200MB) vs K8s single-node (~1GB+). Faster snapshot, faster boot.
- **No cluster formation:** K8s even as k3s has a startup sequence (API server, etcd, kubelet). Docker daemon starts in <1s.
- **Pre-warm is trivial:** Pool of VMs with Docker + Dokkimi images pre-pulled. Cold start is just `docker run` latency.
- **Simpler VM lifecycle:** No need to wait for K8s to be "ready" — Docker is ready the moment the daemon is up.
- **Multi-run per VM (optional):** Since Docker networks provide full isolation, a single VM could run multiple test runs concurrently if cost optimization matters more than strict resource isolation. Each run on its own Docker network, completely independent.

**Result processing:** The VM runs tests, produces a dump file (JSON snapshot of results, logs, assertion outcomes), uploads it to the main server for processing and storage, then the VM is destroyed. The main server never runs test containers — it only processes results. This keeps the central infrastructure simple and stateless.

**Scaling model:** Horizontal. More concurrent users = more VMs from the pool. No shared cluster to contend over, no noisy-neighbor problems, no namespace quota management. Each user's run gets dedicated compute that's destroyed after use.

---

## Additional Recommendations

### Phase 0: Crash-Recovery Cleanup

If Control Tower crashes mid-run, orphaned Docker networks, containers, and temp dirs (`/tmp/dokkimi-${instanceId}`) persist indefinitely. K8s has built-in namespace garbage collection; Docker does not.

Add a startup cleanup sweep to Control Tower:

```typescript
async cleanupOrphanedResources() {
  const networks = await docker.listNetworks({
    filters: { name: ['dokkimi-run-'] }
  });
  for (const net of networks) {
    const containers = await docker.listContainers({
      filters: { network: [net.Name] }
    });
    await Promise.all(containers.map(c => docker.getContainer(c.Id).remove({ force: true })));
    await docker.getNetwork(net.Id).remove();
  }
  // Clean orphaned temp dirs
  const tmpEntries = fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('dokkimi-'));
  for (const dir of tmpEntries) {
    fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true });
  }
}
```

This should run on every Control Tower startup, before accepting new run requests.

### Linux `host.docker.internal` Requires Explicit Configuration

The proposal assumes `host.docker.internal` resolves to the host from within containers. On macOS and Windows this is automatic. On Linux (Docker 20.10+), it requires `--add-host=host.docker.internal:host-gateway` on every container create call.

The `DockerClientService` (Phase 1) should detect the platform and inject this flag automatically on Linux:

```typescript
const extraHosts = process.platform === 'linux' 
  ? ['host.docker.internal:host-gateway'] 
  : [];
```

### CI Compatibility Matrix

Docker-in-Docker (Con #4) is the most likely friction point for real users. Document explicit support status:

| CI Provider | Docker Available? | Notes |
|-------------|------------------|-------|
| GitHub Actions | Yes (socket mounted by default) | Works out of the box |
| GitLab CI (Docker executor) | Yes (via `services: [docker:dind]` or socket mount) | Requires runner config |
| CircleCI | Yes (`setup_remote_docker` or machine executor) | Remote Docker adds latency |
| Jenkins | Depends on agent config | Socket mount most common |
| Corporate/self-hosted | Often restricted | May need admin approval for socket mount |

### Replace `cluster-watcher` With Container Exit Detection

The current `cluster-watcher` module polls K8s for TERMINATING namespaces and calls `RunsService.handleInstancesStopped`. With Docker, containers are either running or gone — there's no "Terminating" state to poll.

Replace with: after test-agent posts `/test-complete`, Control Tower initiates teardown directly (kill containers, remove network). No polling loop needed. If test-agent crashes without posting, use a Docker event stream (`docker.getEvents()`) or a timeout to detect the run has stalled.

### Remove K8s Context From CLI Settings

The `dokkimi config` command currently has a Kubernetes context picker. After migration:
- Remove the K8s context setting entirely
- Simplify `ensureServicesRunning()` from "check Docker + check K8s" to just "check Docker"
- Remove `dokkimi doctor` K8s-related checks (cluster reachable, context valid, resource quotas)

---

## Decision: Why Not Stay on K8s?

K8s provides value for multi-node scheduling, self-healing reconciliation, and production-parity testing of K8s-specific features. None of these apply to Dokkimi:

- **Single machine execution** — local dev and the planned cloud product both run on one machine per test run. No scheduling benefit.
- **Ephemeral environments** — test environments live 30 seconds. Reconciliation/self-healing adds latency without benefit. A crashed container means the test failed; you want a fast failure signal, not a restart loop.
- **Application-level testing** — Dokkimi tests HTTP request/response patterns and database queries. No user is asserting on K8s API interactions, projected volumes, or network policies.
- **No ecosystem tooling in use** — Dokkimi doesn't use Helm, Istio, ArgoCD, or any K8s-ecosystem tool.

The ongoing cost of K8s is paid every day: user support friction ("which context?", "why is my cluster out of resources?"), 15-45s startup penalty per run, ~500MB+ idle RAM overhead, and code complexity maintaining reconciliation/polling patterns. The migration cost is bounded (~2 weeks); the ongoing savings compound.
