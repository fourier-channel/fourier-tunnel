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
COPY config.yaml tunnel-registration.yaml ./

# The bridge listens on 8009 for Synapse's appservice traffic
EXPOSE 8009

CMD ["node", "index.js", "-p", "8009", "-f", "tunnel-registration.yaml"]
