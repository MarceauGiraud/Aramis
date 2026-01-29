FROM mcr.microsoft.com/playwright:v1.41.0-jammy

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install additional dependencies for audio capture
RUN apt-get update && apt-get install -y \
    pulseaudio \
    ffmpeg \
    alsa-utils \
    libasound2-dev \
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

# Configure PulseAudio for headless audio
RUN mkdir -p /root/.config/pulse
RUN echo "default-server = unix:/tmp/pulseaudio.socket" > /root/.config/pulse/client.conf

# Start command
CMD ["node", "apps/bot-worker/dist/index.js"]
