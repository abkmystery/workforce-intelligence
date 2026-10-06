# One immutable image serves the Next.js web app and the durable PostgreSQL worker.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN mkdir -p public && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 workforce \
    && useradd --system --uid 10001 --gid workforce --home-dir /app --shell /usr/sbin/nologin workforce

# The worker's required `--import tsx` command needs tsx, which is currently a
# dev dependency. Keep the locked node_modules tree until tsx becomes runtime.
COPY --from=dependencies --chown=workforce:workforce /app/node_modules ./node_modules
COPY --from=build --chown=workforce:workforce /app/.next/standalone ./
COPY --from=build --chown=workforce:workforce /app/.next/static ./.next/static
COPY --from=build --chown=workforce:workforce /app/public ./public
COPY --from=build --chown=workforce:workforce /app/src ./src
COPY --from=build --chown=workforce:workforce /app/scripts ./scripts
COPY --from=build --chown=workforce:workforce /app/migrations ./migrations
COPY --from=build --chown=workforce:workforce /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=workforce:workforce /app/package.json ./package.json
RUN mkdir -p /app/.next/cache && chown -R workforce:workforce /app/.next/cache
USER workforce
EXPOSE 3000
CMD ["node", "server.js"]
