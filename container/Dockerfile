# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    poppler-utils \
    wget \
    lynx \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and qmd (memory search) globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @tobilu/qmd

# Install Rust toolchain + reddit-cli systemwide (readable by node user).
# build-essential/pkg-config/libssl-dev stay so agents can `cargo install` at runtime.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/* \
 && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path \
 && cargo install --root /usr/local reddit-cli \
 && chmod -R a+rX $RUSTUP_HOME $CARGO_HOME

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Install pdf-reader CLI
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
RUN chmod +x /usr/local/bin/pdf-reader

# Install transcribe CLI (audio → text via OpenRouter multimodal)
COPY skills/audio-transcribe/transcribe /usr/local/bin/transcribe
RUN chmod +x /usr/local/bin/transcribe

# Install youtube-data CLI (unified YouTube Data API v3 wrapper)
COPY skills/youtube-data/youtube-data /usr/local/bin/youtube-data
RUN chmod +x /usr/local/bin/youtube-data

# Python deps for youtube-data transcript subcommand + yt-dlp PO Token plugin
# (bgutil-ytdlp-pot-provider talks to the HTTP server running on the host;
# /etc/yt-dlp.conf points it at host.docker.internal:4416)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --break-system-packages --no-cache-dir \
      yt-dlp \
      youtube-transcript-api \
      bgutil-ytdlp-pot-provider
# yt-dlp config: PO Token via bgutil HTTP server on host + node as JS runtime
# (needed for nsig "n challenge" — the base image already ships node:22).
RUN printf -- '--extractor-args "youtubepot-bgutilhttp:base_url=http://host.docker.internal:4416"\n--js-runtimes node:/usr/local/bin/node\n' \
      > /etc/yt-dlp.conf

# yt-dlp-ejs supplies the embedded JS challenge solver scripts so the "n challenge"
# can be evaluated without a separate distribution download.
RUN pip install --break-system-packages --no-cache-dir yt-dlp-ejs || true

# Install youtube-summarize CLI (Gemini via OpenRouter, public YouTube URL input)
COPY skills/youtube-summarize/youtube-summarize /usr/local/bin/youtube-summarize
RUN chmod +x /usr/local/bin/youtube-summarize

# Install notify CLI (send messages to group via IPC)
COPY scripts/notify /usr/local/bin/notify
RUN chmod +x /usr/local/bin/notify

# Build TypeScript and record source hash so runtime can skip recompile if unchanged
RUN npm run build \
 && find src -name '*.ts' -type f -print0 | sort -z | xargs -0 md5sum | md5sum | awk '{print $1}' > /app/dist/.build-hash

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Install entrypoint
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
