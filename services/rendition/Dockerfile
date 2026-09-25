# The rendition service: ffmpeg plus a small walker over the media share.
#
# Separate from the API image on purpose. ffmpeg is roughly 250 MB, the API image
# also serves the travel app, and Watchtower pulls it on every check — so the
# decoder lives where the decoding happens instead of being paid for on every
# deploy of everything else.
#
# Debian's ffmpeg is built against the nv-codec headers and loads the driver's
# libraries at runtime, so this same image does NVENC as well — given
# `--gpus all` and the Unraid Nvidia driver plugin. It is worth confirming rather
# than assuming, because a missing encoder shows up as every clip failing:
#
#   docker run --rm --gpus all thorcode-rendition \
#     sh -c 'ffmpeg -hide_banner -encoders | grep nvenc && ffmpeg -hide_banner -hwaccels'
#
# If h264_nvenc or cuda is absent, base this on an image whose ffmpeg has them
# (jellyfin/ffmpeg is the usual one) and keep the rest of this file as it is.
FROM node:24-slim

# ffprobe comes with it and is not optional: the service asks each clip what it
# is before encoding, because colour decides the whole filter chain and the
# sidecar does not record it.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version | head -1 \
    && ffprobe -version | head -1

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
