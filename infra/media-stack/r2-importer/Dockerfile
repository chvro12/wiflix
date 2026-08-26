FROM node:20-bookworm-slim

ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
  && curl -fsSLo /tmp/rclone.zip "https://downloads.rclone.org/rclone-current-linux-${TARGETARCH}.zip" \
  && unzip -q /tmp/rclone.zip -d /tmp/rclone \
  && install -m 0755 /tmp/rclone/rclone-*-linux-${TARGETARCH}/rclone /usr/local/bin/rclone \
  && rm -rf /tmp/rclone /tmp/rclone.zip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs ./server.mjs

USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
