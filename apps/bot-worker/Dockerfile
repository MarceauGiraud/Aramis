FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install additional dependencies for audio/video capture
RUN apt-get update && apt-get install -y \
    pulseaudio \
    ffmpeg \
    alsa-utils \
    libasound2-dev \
    xvfb \
    x11-utils \
    imagemagick \
    matchbox-window-manager \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/bot-worker/package.json ./apps/bot-worker/
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Install Google Chrome for Teams video codec support (H.264/AAC).
# The container always runs as linux/amd64 (QEMU on Apple Silicon),
# so Chrome for Testing is always available.
RUN pnpm --filter @aramis/bot-worker exec playwright install --with-deps chrome

# Generate Prisma client and build all packages in a single layer
RUN pnpm --filter @aramis/database generate \
    && pnpm --filter @aramis/shared build \
    && pnpm --filter @aramis/database build \
    && pnpm --filter @aramis/bot-worker build

# Create recordings directory
RUN mkdir -p /tmp/recordings /tmp/bot-screenshots

# Set environment variables
ENV NODE_ENV=production

# Configure PulseAudio (daemon only -- sinks are created per-bot by DisplayAllocator)
RUN mkdir -p /root/.config/pulse
COPY <<EOF /root/.config/pulse/default.pa
load-module module-native-protocol-unix
EOF

# Create entrypoint script: start PulseAudio, then Node
# Xvfb displays and PulseAudio sinks are managed per-bot by DisplayAllocator
RUN echo '#!/bin/bash\n\
# Start PulseAudio daemon (sinks created dynamically per bot)\n\
pulseaudio --start --exit-idle-time=-1\n\
sleep 1\n\
\n\
# Run the bot worker\n\
exec node apps/bot-worker/dist/index.js\n\
' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Start command
CMD ["/app/entrypoint.sh"]
