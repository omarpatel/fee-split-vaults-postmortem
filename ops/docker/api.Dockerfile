# The API image: the control plane.
#
# Build context is the REPOSITORY ROOT, not this directory:
#   docker build -f ops/docker/api.Dockerfile -t fee-split-vaults/api .
#
# Consent signing and verification, vault deployment, the dual-consent
# onboarding machine, receipts and the weekly report. Entry point is
# apps/api/dist/main.js, which is what apps/api's own `start` script runs.
#
# THIS CONTAINER TOUCHES SIGNING MATERIAL. So does the orchestrator under
# FLEET_SETTLEMENT=live, and it is the SAME key (.env.example: one signer
# deploys vaults here and settles pulls there). Keys reach both from a secrets
# manager at runtime, never through a build argument and never in the image:
# a build arg is visible in the image history to anyone who can pull it.

# ---------------------------------------------------------------------------
# Stage 1: build the whole workspace once.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY config/ ./config/
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY ops/ ./ops/

RUN npm ci --no-audit --fund=false
RUN npm install --no-save --no-audit --fund=false pg@8.13.1
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

# ttf-dejavu: the sans-serif @resvg/resvg-js needs when the onboarding flow
# renders a coin's creative assets. node:alpine ships no fonts; without one the
# render refuses (`font_unresolved`). CREATIVE_FONT_FILES (comma-separated
# .ttf paths) pins the font set for byte-identical assets across hosts.
RUN apk add --no-cache tini ttf-dejavu

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/config ./config
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
# ops/ is present so the API image can run migrations as a deploy job and so
# `status` is available for an incident inside a running container.
COPY --from=build /app/ops ./ops

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
