# Playwright base image ships Chromium + all system deps preinstalled.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV NODE_ENV=production
# Render injects PORT; server.mjs reads it.
CMD ["node", "server.mjs"]
