# Build context: repo root (docker build -f services/control-tower/Dockerfile .)
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace config and lockfile
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/

# Copy ALL workspace package.json files so yarn sees the complete workspace set
# (required for yarn install --immutable to match the lockfile)
COPY shared/config/package.json shared/config/
COPY shared/platform/package.json shared/platform/
COPY shared/telemetry/package.json shared/telemetry/
COPY shared/definition-validator/package.json shared/definition-validator/
COPY shared/definition-resolver/package.json shared/definition-resolver/
COPY shared/service-manager/package.json shared/service-manager/
COPY services/control-tower/package.json services/control-tower/
COPY apps/vscode/package.json apps/vscode/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY apps/landing/package.json apps/landing/

# Copy Prisma schema (needed for install/generate)
COPY shared/prisma/ shared/prisma/

# Install dependencies
RUN yarn install --immutable

# Generate Prisma client (needed before Control Tower can compile — CT's
# src/lib/prisma imports @prisma/client)
RUN npx prisma generate --schema=shared/prisma/postgresql/schema.prisma

# Copy shared source and service source, then build all
COPY shared/config/ shared/config/
COPY shared/platform/ shared/platform/
COPY shared/telemetry/ shared/telemetry/
COPY shared/definition-validator/ shared/definition-validator/
COPY services/control-tower/ services/control-tower/

RUN yarn workspace @dokkimi/config build && \
    yarn workspace @dokkimi/platform build && \
    yarn workspace @dokkimi/telemetry build && \
    yarn workspace @dokkimi/definition-validator build && \
    yarn workspace control-tower build

# Production stage
FROM node:22-alpine

ARG VERSION=dev
ENV APP_VERSION=${VERSION}
ENV CONTROL_TOWER_HOST=0.0.0.0

WORKDIR /app

# Copy workspace config
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ .yarn/

# Copy shared packages (built)
COPY --from=builder /app/shared/config/ shared/config/
COPY --from=builder /app/shared/platform/ shared/platform/
COPY --from=builder /app/shared/telemetry/ shared/telemetry/

# Copy Prisma schema
COPY --from=builder /app/shared/prisma/ shared/prisma/

# Stub out other workspaces (yarn needs all package.jsons to resolve the lockfile)
COPY shared/definition-validator/package.json shared/definition-validator/
COPY shared/definition-resolver/package.json shared/definition-resolver/
COPY shared/service-manager/package.json shared/service-manager/
COPY apps/vscode/package.json apps/vscode/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY apps/landing/package.json apps/landing/

# Copy config files for runtime
COPY config/config.yaml config/config.yaml

# Copy service (built)
COPY --from=builder /app/services/control-tower/package.json services/control-tower/
COPY --from=builder /app/services/control-tower/dist/ services/control-tower/dist/

# Install production dependencies only
RUN yarn workspaces focus control-tower --production

# Generate Prisma client in production image
RUN npx prisma generate --schema=shared/prisma/postgresql/schema.prisma

USER node
WORKDIR /app/services/control-tower

EXPOSE 19001
CMD ["node", "dist/main"]
