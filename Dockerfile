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

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests and schema first so dep install is cached separately from source changes
COPY package*.json ./
COPY prisma ./prisma/

# npm ci runs the postinstall hook which calls prisma generate
RUN npm ci

COPY . .

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
CMD ["sh", "-c", "npx prisma migrate deploy && node index.js"]
