FROM node:22-bookworm-slim

# Install system deps: Chromium headless + curl + git
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    fonts-liberation \
    fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Playwright + Chromium
RUN npm init -y && npm install playwright pg
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium

# Copy agent script
COPY agent.mjs /app/agent.mjs

CMD ["sleep", "3600"]
