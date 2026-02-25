FROM node:22-bookworm-slim

# Install git, curl, and Chromium headless dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl \
    # Chromium system deps (from Playwright nativeDeps for debian12)
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

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright MCP server + Chromium headless shell (smallest footprint)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright install --with-deps --only-shell 2>/dev/null; \
    npm install -g @playwright/mcp

# Create non-root user (Claude Code refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude

# Bypass onboarding + configure Playwright MCP for Claude Code
RUN mkdir -p /home/claude/.claude && \
    echo '{"hasCompletedOnboarding":true}' > /home/claude/.claude.json && \
    echo '{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest","--headless","--browser","chromium","--no-sandbox"]}}}' > /home/claude/.claude/settings.json && \
    chown -R claude:claude /home/claude/.claude /home/claude/.claude.json

WORKDIR /workspace
RUN chown claude:claude /workspace

# Give claude user access to playwright browsers
RUN chmod -R o+rx /ms-playwright 2>/dev/null || true

USER claude

CMD ["sleep", "3600"]
