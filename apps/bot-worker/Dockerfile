FROM mcr.microsoft.com/playwright:v1.41.0-jammy

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

# Generate Prisma client
RUN pnpm --filter @aramis/database generate

# Build packages
RUN pnpm --filter @aramis/shared build
RUN pnpm --filter @aramis/database build
RUN pnpm --filter @aramis/bot-worker build

# Create recordings directory
RUN mkdir -p /tmp/recordings

# Set environment variables
ENV NODE_ENV=production
ENV DISPLAY=:99

# Configure PulseAudio for headless audio capture
RUN mkdir -p /root/.config/pulse
COPY <<EOF /root/.config/pulse/default.pa
load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description="Virtual_Speaker"
set-default-sink virtual_speaker
load-module module-native-protocol-unix
EOF

# Create entrypoint script to start Xvfb + PulseAudio + Node
RUN echo '#!/bin/bash\n\
# Start Xvfb (virtual X display)\n\
Xvfb :99 -screen 0 1920x1080x24 &\n\
sleep 1\n\
\n\
# Start PulseAudio\n\
pulseaudio --start --exit-idle-time=-1\n\
sleep 1\n\
\n\
# Run the bot worker\n\
exec node apps/bot-worker/dist/index.js\n\
' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Start command
CMD ["/app/entrypoint.sh"]
