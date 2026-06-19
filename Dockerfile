FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests and schema first so dep install is cached separately from source changes
COPY package*.json ./
COPY prisma ./prisma/

# npm ci runs the postinstall hook which calls prisma generate
RUN npm ci

COPY . .

EXPOSE 4000

# Apply any pending migrations, then start
CMD ["sh", "-c", "npx prisma db push && node index.js"]
