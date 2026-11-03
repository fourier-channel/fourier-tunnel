FROM node:24-slim

WORKDIR /app

# NODE 24. Pinned to 22 until 2026-10-24 because nedb, matrix-appservice-bridge
# 11's store, called util.isDate, which Node 23 removed; bridge 12 dropped nedb
# and requires Node >=24. package.json `engines` names the range, .npmrc makes
# npm enforce it during the build below, and bridge-runtime.test.js holds this
# line inside it.

# Install dependencies first so this layer caches unless package files change.
# `npm ci`, not `npm install`: exactly the lockfile, or the build fails.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# The npm CLI is a build tool: the bridge and its operator tools run under
# `node`, and nothing in the container calls npm. Left in, its bundled
# packages (brace-expansion, undici) were every High finding in this image's
# nightly vulnerability scan (2026-10-25), none reachable from the bridge.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Copy ALL application source. Glob (not an explicit allowlist) so a newly added
# module can never be silently left out of the image -- that omission crash-looped
# this bridge before (autotagger.js, then prompt-tags.js). Non-runtime files are
# kept out via .dockerignore (*.test.js, dev-autotag.js), so this ships exactly
# the same set as the old allowlist, but stays correct as modules are added.
COPY *.js ./
# The capabilities the bots share (capabilities/avatar.js, rescan.js). A
# directory, so a new capability rides in the way a new top-level module does.
# It was missing from this file once: index.js required ./capabilities/rescan,
# the checkout had it, the image did not, and the bridge crash-looped on
# MODULE_NOT_FOUND for the minutes it took to read this file (2026-09-19).
COPY capabilities ./capabilities
# The operator tools, for the same reason the line above is a glob. They are not
# on the bridge's own path, but they are how a room gets caught up, and a tool
# that is not in the image can only be run by bind-mounting code the image does
# not have -- which is the divergence this whole suite exists to catch. It runs
# HERE because the URLs in config.yaml are compose-network names: synapse,
# danbooru and fourier-spectrum resolve on this network and nowhere else.
COPY tools ./tools

# Unprivileged. hostaudit's container-user check named this bridge running as
# root (2026-11-02). Its own uid, 10004, is no login on the host, so the
# secrets it reads (these two files, 600) stay readable by it alone. Its group
# is the host's `fourier` (gid 985 on 41chan): /discord is shared with
# fourier-sampling's panel, which runs as `fourier`, through a setgid-fourier
# directory and umask 002 (discordService.js). The host owns the mounted
# config.yaml and onboarding-state/, so they are chowned to 10004:985 before the
# first start as this user (README, Setup step 1). On another box, put that
# box's `getent group fourier` gid here.
RUN groupadd --system --gid 985 fourier \
    && useradd --system --no-create-home --uid 10004 --gid fourier tunnel
COPY --chown=tunnel:fourier config.yaml tunnel-registration.yaml ./
USER tunnel

# The bridge listens on 8009 for Synapse's appservice traffic
EXPOSE 8009

CMD ["node", "index.js", "-p", "8009", "-f", "tunnel-registration.yaml"]
