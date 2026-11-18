# A runtime image for the party service, and deliberately nothing more.
#
# Three properties matter and each is a requirement in its own right:
#
# 1. **The proprietary client is not in the image.** The service serves a client
#    that is derived from the original game's bundles, which are archived in
#    `private-client/` and are not independently licensed. Baking them into an
#    image would make every pull of that image a redistribution. So the image
#    contains only this project's own source, and the archived material is
#    mounted: the prepared client at `/app/web`, and the three original bundles
#    the server's adapter imports at `/app/private-client/assets`.
#    See `docs/operations.md` for the exact commands.
#
# 2. **It runs as a non-root user.** The process needs to write one SQLite
#    database and, if configured, one event log. Nothing else. The data directory
#    is owned by the runtime user; everything else is read-only to it.
#
# 3. **The build is reproducible.** The only toolchain is Bun at a pinned version,
#    there are no runtime npm dependencies, and nothing is fetched at runtime.
#    `--frozen-lockfile` would be meaningless here because there are no
#    dependencies to freeze; the pin that matters is the Bun image tag.
#
# Architecture: this is a multi-arch manifest. Bun publishes `linux/amd64` and
# `linux/arm64`, so `docker build` produces a working image on either; the Oracle
# host this was verified on is `aarch64`. Nothing in the image is architecture
# specific: there are no compiled addons and no native modules.

FROM oven/bun:1.4.2-alpine AS source

WORKDIR /app
COPY package.json ./
# Only the code the server reads at runtime. `node_modules` is absent because
# every import is either relative or a `bun:`/`node:` builtin, which the runtime
# provides; there is no dependency install step at all.
COPY src ./src
# Three authored TypeScript scripts are transpiled by the server at request time,
# so the sources have to be present but their output must not be generated here.
COPY scripts/home.ts scripts/leaderboard.ts scripts/admin.ts ./scripts/
COPY scripts/container-health.js ./scripts/
# The prepared client is a mount point, never image content. Creating it empty
# means a misconfigured run fails loudly at the first asset request rather than
# appearing to work with a stale copy.
# `private-client/assets` is a mount point for the same reason. The server's
# upstream adapter imports two original bundles directly by relative path
# (`date-*.js` and `createServerFn-*.js`, the latter pulling in `redirect-*.js`),
# so those files have to be reachable at the paths the imports name. They are
# original game code, so they are mounted rather than copied in.
RUN mkdir -p /app/web /app/state /app/private-client/assets

FROM oven/bun:1.4.2-alpine AS runtime

# A fixed numeric uid/gid keeps file ownership stable across rebuilds, so a data
# directory prepared once does not need re-chowning.
RUN addgroup -g 10001 -S party \
    && adduser -u 10001 -S -G party -h /app -s /sbin/nologin party

WORKDIR /app
COPY --from=source --chown=root:root /app/package.json ./
COPY --from=source --chown=root:root /app/src ./src
COPY --from=source --chown=root:root /app/scripts ./scripts
# Owned by the runtime user because SQLite writes here, and empty on purpose so a
# mounted client is obviously a mount rather than something the image supplied.
COPY --from=source --chown=party:party /app/web ./web
COPY --from=source --chown=party:party /app/private-client ./private-client
RUN mkdir -p /app/state /app/state/events && chown -R party:party /app/state

# Loopback inside the container. A published port is the operator's decision;
# binding the container's own address keeps the default unreachable from outside
# unless something explicitly publishes it.
ENV BP_HOST=0.0.0.0 \
    PORT=8789 \
    BP_DB=/app/state/rooms.sqlite \
    NODE_ENV=production

USER party

EXPOSE 8789

# Exec form, so the process is PID 1 and receives `SIGTERM` directly. The service
# has a real ordered shutdown - cancel timers, stop the listener, close sockets,
# checkpoint every room, close the database - and a shell wrapper would swallow
# the signal and send the shutdown path down its timeout instead.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["bun", "/app/scripts/container-health.js"]

CMD ["bun", "src/server.ts"]
