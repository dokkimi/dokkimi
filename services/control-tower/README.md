# Control Tower

Dokkimi's single backend service. NestJS v11, port `19001`.

After the service consolidation, Control Tower is the whole backend — log
ingestion and test validation used to be separate services (LPS, TVS) and
now live here as internal feature modules.

## Feature Modules

| Module                                 | Responsibility                                                                                           | Key routes                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `namespace/` + `namespace-lifecycle/`  | Docker network + container lifecycle, config file management, Dokkimi CA, container crash monitoring     | `POST /namespaces/*`                                                                                                       |
| `runs/`                                | Run creation, per-instance deployment, status, stop/delete                                               | `POST /runs`, `GET /runs/latest`, `POST /runs/stop`, `POST /runs/instances-stopped`, `POST /runs/test-validation-complete` |
| `log-query/`                           | Read path for the logs written by `log-processing`                                                       | `GET /logs/{http,console,database,test-execution,assertion-results}/instance/:id`                                          |
| `log-processing/` (absorbed from LPS)  | Log ingestion from interceptor / db-proxy / test-agent. `@SkipThrottle()`, 10MB body limit preserved.    | `POST /logs/{http,console,database,test-execution}`                                                                        |
| `test-validation/` (absorbed from TVS) | Async assertion validation when a run finishes. Calls `RunsService.handleValidationComplete` in-process. | `POST /test-complete`                                                                                                      |
| `health/`                              | Aggregated `/health` (database + Prisma). Accepts readiness updates from sidecars.                       | `GET /health`, `POST /health/status`                                                                                       |

## Scripts

```bash
yarn start:dev          # watch mode
yarn start:prod         # run built output
yarn test               # unit tests
yarn prisma:migrate     # apply SQLite migrations (desktop)
```

## Environment variables

The service reads its config from `config/config.yaml` via `@dokkimi/config`.
