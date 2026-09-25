# The rendition service: ffmpeg plus a small walker over the media share.
#
# Separate from the API image on purpose. ffmpeg is roughly 250 MB, the API image
# also serves the travel app, and Watchtower pulls it on every check — so the
# decoder lives where the decoding happens instead of being paid for on every
# deploy of everything else.
#
# jellyfin/ffmpeg would bring hardware encoders (QSV/VAAPI) already wired up; the
# Debian package is the portable default and libx264 works everywhere. Swap the
# base and set RENDITION_VCODEC if this box has a GPU to spend.
FROM node:24-slim

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version | head -1

WORKDIR /app

# No npm install at all. This service imports five of the API's own utils and
# nothing from node_modules — it walks a share and spawns ffmpeg — so the image
# stays ffmpeg plus Node with no dependency tree to keep patched. The list is the
# real require closure, traced rather than guessed: mediaSidecar pulls in
# serialQueue, which is easy to miss and fails only at runtime in the container.
COPY utils/mediaPaths.js utils/mediaSidecar.js utils/serialQueue.js \
     utils/mediaHealth.js utils/renditionPlan.js ./utils/
COPY services/rendition/index.js ./services/rendition/

# Unprivileged: it needs to read and write the share and nothing else. Make sure
# the share's ownership lets this uid write, or run with --user on Unraid.
USER node

# No healthcheck and no port. It holds no socket, answers nothing, and its
# liveness is visible in the log as passes going by.
CMD ["node", "services/rendition/index.js"]
