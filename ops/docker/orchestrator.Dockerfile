# The orchestrator image: the recurring-job scheduler.
#
# Build context is the REPOSITORY ROOT, not this directory:
#   docker build -f ops/docker/orchestrator.Dockerfile -t fee-split-vaults/orchestrator .
#
# This is the process that sweeps escrow, settles, reconciles, re-tiers,
# re-checks delivery, sends the weekly reports and re-screens on metadata
# change. If it is not running, none of that happens - which is why
# `scheduler_tick_stalled` is a page and why the container has a healthcheck.

# ---------------------------------------------------------------------------
# Stage 1: build the whole workspace once.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-run the install layer.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY config/ ./config/
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY ops/ ./ops/

RUN npm ci --no-audit --fund=false

# `pg` is deliberately not a build-time dependency of ops/ - the package must
# typecheck and unit-test with no database driver present - so it is installed
# here, pinned, for the runtime image only. ops/lib/pg.ts imports it lazily.
RUN npm install --no-save --no-audit --fund=false pg@8.13.1

# tsc --build walks the project references from the root solution file, which
# includes ./ops. A type error anywhere fails the image, on purpose.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    OPS_TICK_SECONDS=30 \
    OPS_LOG_LEVEL=info

# tini gives the scheduler a real init so SIGTERM reaches Node and the graceful
# stop path runs. Without it a rolling deploy kills a worker mid-lease.
#
# ttf-dejavu is the sans-serif @resvg/resvg-js resolves when packages/creative
# renders a coin's banner/avatar/card. node:alpine ships no fonts at all, and a
# host with no font fails the render (`font_unresolved`) rather than shipping
# an image with the text silently dropped. Image hashes are stable per font
# set, so for byte-identical assets ACROSS hosts set CREATIVE_FONT_FILES to a
# comma-separated list of pinned .ttf paths instead of relying on this package.
RUN apk add --no-cache tini ttf-dejavu

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config ./config
COPY --from=build /app/packages ./packages
COPY --from=build /app/ops ./ops

# The go-live gate (`docker compose run --rm preflight`).
# tools/ is executed as TypeScript source by Node's type stripping (22.18+),
# never built, so it is copied from the context, not from the build stage.
# Only what preflight imports: its own file and the shared CLI layer.
COPY tools/preflight.ts ./tools/preflight.ts
COPY tools/lib/cli.ts ./tools/lib/cli.ts

# Never root. Under FLEET_SETTLEMENT=live this process holds OPERATOR_SIGNER_KEY
# (reimbursement pulls, escrow claims, settle, suspend, heartbeat - see
# packages/fleet/src/ports.ts), reached from a secrets manager at runtime and
# never baked in; it also holds a database connection with write access to
# the ledger's freeze table.
USER node

# The scheduler refuses to start with pending migrations, so `migrate status`
# is an honest readiness probe: it exits non-zero exactly when this image and
# the database schema disagree.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node ops/migrations/cli.js status || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "ops/scheduler/main.js"]
