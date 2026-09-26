# node 24, matching the npm that writes package-lock.json here.
#
# This was node:20-slim, whose npm 10 refused the lock outright: vitest's bundled
# vite declares a peer of esbuild ^0.27||^0.28, tsx depends on esbuild ~0.25.0,
# and those ranges are disjoint, so the tree needs a second nested copy. npm 11
# leaves the peer unsatisfied and calls it valid; npm 10 calls it a broken lock
# and `npm ci` exits 1. Every image build failed on that from 30 July, which is
# why the deployed container was still the one built on 26 July while the
# database moved four migrations ahead of it.
#
# Keep this in step with whatever writes the lock, or the same thing recurs
# silently — a failing build only shows up as an image that quietly stops
# changing. Node 20 is past end-of-life besides.
FROM node:24-slim

RUN apt-get update -y && apt-get install -y openssl curl gnupg && rm -rf /var/lib/apt/lists/*

# Doppler CLI. The container gets exactly one secret — DOPPLER_TOKEN, a
# read-only service token — and fetches DATABASE_URL, SCRAPER_TOKEN and the
# rest at boot, so a value lives in Doppler and nowhere else. Previously they
# were also typed into the Unraid container template, which is how ThorCode's
# SCRAPER_TOKEN and the scraper's drifted apart.
#
# Pinned on purpose. `install.sh` has no --version flag and always takes the
# latest, so an unrelated push to main could rebuild this image onto a CLI the
# code was never run against — the same silent-drift failure the node version
# comment above is about. Bump this deliberately.
RUN curl -sLf --retry 3 --tlsv1.2 --proto "=https" \
      'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' \
      | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" \
      > /etc/apt/sources.list.d/doppler-cli.list \
    && apt-get update && apt-get install -y doppler=3.76.5 \
    && rm -rf /var/lib/apt/lists/* \
    && doppler --version

WORKDIR /app

# Copy manifests and schema first so dep install is cached separately from source changes
COPY package*.json ./
COPY prisma ./prisma/

# npm ci runs the postinstall hook which calls prisma generate
RUN npm ci

COPY . .

RUN mkdir -p /doppler

# Set here rather than left to Doppler, because it decides what a client is
# told when something breaks: outside production, every 500 — from index.js's
# handler and from apiResponse.fail — returns the raw error message, which for
# a database error names tables, columns, constraints and sometimes the values
# in them. Nothing in the repo set it, so whether the deployed API leaked those
# depended on a config nobody could see from here. After `npm ci`, so the image
# still installs exactly what the lock says.
ENV NODE_ENV=production

EXPOSE 4000

# Apply any pending migrations, then start.
#
# `migrate deploy`, never `db push`. This was `db push` from June, when
# migrations were gitignored and a container built from the repo therefore had
# none to deploy — push only needs the schema file, so it started the server and
# the problem looked solved.
#
# What it actually does is force the database to match schema.prisma, with no
# notion of a migration and no memory of what has already been applied. That is
# a no-op exactly as long as the image and the database agree, which is why it
# was quiet for seven weeks. The first image to lag behind tried to delete
# everything in the database that its older schema did not mention: seven Trip
# columns and the whole TripPlace table, fourteen rows of a real trip. It
# refused without --accept-data-loss, exited non-zero, and the `&&` below meant
# the API never started — a container dying on boot, which is the good outcome
# here only because push happened to ask first.
#
# The `&&` is deliberate: a failed migration should stop the server, not leave
# it serving requests against a schema it does not match.
# Wrapped in `doppler run` so migrate deploy and the server both see the same
# injected secrets — prisma reads DATABASE_URL from the environment, so the
# wrapper has to be outside the `&&`, not inside it.
#
# --fallback is what keeps boot from depending on the WAN: doppler run fetches
# over the network at process start, and without a fallback a Doppler outage
# becomes a container that will not start. It writes an encrypted copy after
# each successful fetch and reads it only when the API is unreachable. Map
# /doppler to a host path on Unraid or the file dies with the container.
CMD ["doppler", "run", "--fallback", "/doppler/fallback.json", "--", "sh", "-c", "npx prisma migrate deploy && node index.js"]
