FROM ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11 AS package

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

# This target deliberately extends, rather than replaces, the retained package
# builder. `fork-release.json` pins it separately for local checks, so adding
# a browser or provider-test prerequisite cannot change an accepted package's
# build environment.
FROM package AS checks

USER root

# Playwright 1.58.2's Chromium/WebKit Linux prerequisites beyond the package
# builder's Electron/Chromium dependencies. Browser binaries themselves stay
# in the caller-mounted PLAYWRIGHT_BROWSERS_PATH cache and are installed from
# the checked-out package lock by the check selector.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    fonts-freefont-ttf fonts-ipafont-gothic fonts-noto-color-emoji fonts-tlwg-loma-otf \
    fonts-unifont fonts-wqy-zenhei libatomic1 libavif13 libegl1 libenchant-2-2 \
    libepoxy0 libevdev2 libffi7 libfontconfig1 libfreetype6 libgdk-pixbuf-2.0-0 \
    libgles2 libglx0 libgstreamer-gl1.0-0 libgstreamer-plugins-base1.0-0 \
    libgstreamer1.0-0 libgtk-4-1 libgudev-1.0-0 libharfbuzz-icu0 libharfbuzz0b \
    libhyphen0 libicu70 libjpeg-turbo8 liblcms2-2 libmanette-0.2-0 libnotify4 \
    libopengl0 libopenjp2-7 libopus0 libpng16-16 libproxy1v5 libsecret-1-0 \
    libsoup-3.0-0 libwayland-client0 libwayland-egl1 libwayland-server0 libwebpdemux2 \
    libwoff1 libx264-163 libxml2 libxslt1.1 gstreamer1.0-libav \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    xfonts-cyrillic xfonts-scalable libcurl4-openssl-dev libexpat1-dev gettext \
    libssl-dev zlib1g-dev \
    && curl --fail --show-error --location \
      https://www.kernel.org/pub/software/scm/git/git-2.43.0.tar.xz \
      --output /tmp/git.tar.xz \
    && echo '5446603e73d911781d259e565750dcd277a42836c8e392cac91cf137aa9b76ec  /tmp/git.tar.xz' | sha256sum --check - \
    && tar -xJf /tmp/git.tar.xz -C /tmp \
    && make -C /tmp/git-2.43.0 prefix=/usr/local NO_TCLTK=YesPlease all install \
    && git --version | grep -Fx 'git version 2.43.0' \
    && curl --fail --show-error --location \
      https://github.com/cli/cli/releases/download/v2.45.0/gh_2.45.0_linux_amd64.deb \
      --output /tmp/gh.deb \
    && echo '3e5410ca55f5a56c88516f53cd4cc9dc1bb106288be2b9ac2d5d79f6e20915a4  /tmp/gh.deb' | sha256sum --check - \
    && dpkg --install /tmp/gh.deb \
    && gh --version | head -n 1 | grep -Fx 'gh version 2.45.0 (2024-03-04)' \
    && rm -rf /tmp/git.tar.xz /tmp/git-2.43.0 /tmp/gh.deb /var/lib/apt/lists/*

# Keep the same provider CLI surface as the selected Linux browser and CLI
# checks. These package versions are deliberate test inputs; the image content
# ID in fork-release.json records the resulting resolved dependency trees. npm
# creates a per-user configuration path while this target runs as root, so give
# it back to builder before any check writes isolated tool state.
RUN npm_config_cache=/tmp/npm-cache npm install --global --no-audit --no-fund \
    @anthropic-ai/claude-code@2.1.322 \
    @openai/codex@0.105.0 \
    opencode-ai@1.19.5 \
    && command -v claude \
    && command -v codex \
    && command -v opencode \
    && npm ls --global --depth=0 \
      @anthropic-ai/claude-code@2.1.322 \
      @openai/codex@0.105.0 \
      opencode-ai@1.19.5 \
    && rm -rf /tmp/npm-cache \
    && chown -R builder:builder /home/builder

LABEL io.paseo.check.playwright-version="1.58.2" \
      io.paseo.check.claude-code-version="2.1.322" \
      io.paseo.check.codex-version="0.105.0" \
      io.paseo.check.opencode-version="1.19.5" \
      io.paseo.check.git-version="2.43.0" \
      io.paseo.check.github-cli-version="2.45.0"

USER builder

# Keep an unadorned Docker build on the package environment. Check callers
# select the richer `checks` target explicitly.
FROM package AS default
