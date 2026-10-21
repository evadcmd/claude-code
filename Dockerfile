FROM node:24-slim
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY managed-settings.json /etc/claude-code/managed-settings.json
WORKDIR /opt/claude-wrap
COPY package.json package-lock.json claude.ts ./
RUN npm ci --omit=dev \
    && mkdir bin \
    && printf '#!/bin/sh\nexec node /opt/claude-wrap/claude.ts "$@"\n' > bin/claude \
    && chmod +x bin/claude

RUN mkdir /workspace && chown node:node /workspace
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/opt/claude-wrap/bin:/home/node/.local/bin:$PATH \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AWS_REGION=ap-northeast-1

WORKDIR /workspace
CMD ["sleep", "infinity"]