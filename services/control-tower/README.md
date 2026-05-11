# Control Tower

Dokkimi's single backend service. NestJS v11, port `19001`.

After the service consolidation, Control Tower is the whole backend — log
ingestion, test validation, and K8s cluster watching used to be separate
services (LPS, TVS, CWS) and now live here as internal feature modules.

## Feature Modules

| Module                                 | Responsibility                                                                                                              | Key routes                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `namespace/` + `namespace-lifecycle/`  | K8s namespace + deployment lifecycle, ConfigMap management, Dokkimi CA, resource creation                                   | `POST /namespaces/*`                                                                                                       |
| `runs/`                                | Run creation, per-instance deployment, status, stop/delete                                                                  | `POST /runs`, `GET /runs/latest`, `POST /runs/stop`, `POST /runs/instances-stopped`, `POST /runs/test-validation-complete` |
| `log-query/`                           | Read path for the logs written by `log-processing`                                                                          | `GET /logs/{http,console,database,test-execution,assertion-results}/instance/:id`                                          |
| `log-processing/` (absorbed from LPS)  | Log ingestion from interceptor / db-proxy / test-agent. `@SkipThrottle()`, 10MB body limit preserved.                       | `POST /logs/{http,console,database,test-execution}`                                                                        |
| `test-validation/` (absorbed from TVS) | Async assertion validation when a run finishes. Calls `RunsService.handleValidationComplete` in-process.                    | `POST /test-complete`                                                                                                      |
| `cluster-watcher/` (absorbed from CWS) | Polls K8s for TERMINATING namespaces. Marks instances STOPPED and notifies `RunsService.handleInstancesStopped` in-process. | n/a (poll loop)                                                                                                            |
| `health/`                              | Aggregated `/health` (database, K8s, Prisma, Redis). Accepts readiness updates from sidecars.                               | `GET /health`, `POST /health/status`                                                                                       |

## Scripts

```bash
yarn start:dev          # watch mode
yarn start:prod         # run built output
yarn test               # unit tests
yarn prisma:migrate     # apply SQLite migrations (desktop)
```

## Environment variables

The service reads its config from `config/environments/{desktop,cloud}.yaml` via
`@dokkimi/config`. The only env-var overrides that are honored are
`CONTROL_TOWER_HOST`, `IDLE_POLL_INTERVAL_MS`, and `ACTIVE_POLL_INTERVAL_MS`.
