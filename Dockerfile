# Playwright's official image: Chromium + every system dep it needs, preinstalled
# and battle-tested — the same environment the render pipeline is proven in.
# (The nixpacks chromium crashed on launch no matter the flags.)
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# System ffmpeg for the final encode (Playwright's bundled ffmpeg only muxes screencasts)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Playwright image ships browsers here; findChromium() globs this path
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["node", "server.js"]
