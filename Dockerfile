FROM oven/bun:1.2-alpine AS base
WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock* /temp/dev/
RUN cd /temp/dev && (bun install --frozen-lockfile || bun install)

FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

ENV NODE_ENV=production
RUN bun run build

FROM base AS release
COPY --from=install /temp/dev/node_modules node_modules
COPY --from=prerelease /usr/src/app/dist ./dist
COPY --from=prerelease /usr/src/app/package.json ./package.json
COPY --from=prerelease /usr/src/app/tsconfig.json ./tsconfig.json
COPY --from=prerelease /usr/src/app/mikro-orm.config.ts* ./

USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "dist/main.js" ]
