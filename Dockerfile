FROM node:20-slim

WORKDIR /app

# Install dependencies first so this layer caches unless package files change
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

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
COPY config.yaml tunnel-registration.yaml ./

# The bridge listens on 8009 for Synapse's appservice traffic
EXPOSE 8009

CMD ["node", "index.js", "-p", "8009", "-f", "tunnel-registration.yaml"]
