FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11

# Native modules, Debian packaging, Electron, Xvfb and Chromium browser tests.
# Only this image installation runs as root; source builds use the caller's UID.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils git python3 make g++ pkg-config file unzip zip \
    fakeroot dpkg-dev binutils xvfb xauth xdotool fonts-liberation \
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnss3 libnspr4 \
    libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 \
    libxss1 libxtst6 libxshmfence1 libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --show-error --location \
      https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz \
      --output /tmp/node.tar.xz \
    && echo '00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc  /tmp/node.tar.xz' | sha256sum --check - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version && npm --version

RUN groupadd --gid 1000 builder && useradd --uid 1000 --gid 1000 --create-home builder
ENV HOME=/home/builder \
    npm_config_cache=/cache/npm \
    ELECTRON_CACHE=/cache/electron \
    ELECTRON_BUILDER_CACHE=/cache/electron-builder \
    PLAYWRIGHT_BROWSERS_PATH=/cache/playwright \
    CI=1
USER builder
WORKDIR /work
