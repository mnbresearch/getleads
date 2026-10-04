# Single image runs API or worker (command decides). Free-tier friendly on Render/Fly/Railway/Koyeb.
FROM node:22-alpine AS build
WORKDIR /app
# .npmrc carries the registry guard for the @prospex scope (see the file). tsconfig.base.json is
# what every workspace tsconfig extends: without it the build below fails.
COPY package.json package-lock.json* .npmrc* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# Build with the dev dependencies (TypeScript), then drop them: the runtime image carries only
# what the server loads.
RUN npm ci --ignore-scripts \
 && npm run build -w packages/core -w packages/db -w apps/api \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Owned by root, run as the image's unprivileged "node" user: the process can read the
# application but cannot rewrite it, and a bug in it is not a bug running as root.
COPY --from=build /app ./
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
