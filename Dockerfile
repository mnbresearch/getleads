# Single image runs API or worker (command decides). Free-tier friendly on Render/Fly/Railway/Koyeb.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --ignore-scripts && npm run build -w packages/core -w packages/db -w apps/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
