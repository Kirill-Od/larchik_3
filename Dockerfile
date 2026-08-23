# better-sqlite3 ships prebuilt binaries for common platforms, but not for every one, and
# when no prebuild matches npm falls back to compiling with node-gyp. The build stage
# carries the toolchain that compile needs; the runtime stage does not, so the shipped
# image stays small and has no compiler in it.
FROM node:22-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied before the source so a source-only change reuses the cached dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM node:22-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The database is baked in at the filesystem root so the path is short, stable, and
# obvious to override. Mount your own over it with:
#   docker run -i --rm -v /host/shop.db:/shop.db:ro shop-db-mcp
COPY shop.db /shop.db
ENV SHOP_DB_PATH=/shop.db

# Nothing here writes, so the server has no reason to run as root.
USER node

# The MCP client speaks JSON-RPC over this process's stdin/stdout. Run the container with
# `-i` and NEVER with `-t`: a TTY turns on line editing and echo, which corrupts the frames.
ENTRYPOINT ["node", "/app/src/index.js"]
