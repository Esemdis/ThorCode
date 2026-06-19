FROM node:20-slim

WORKDIR /app

# Copy manifests and schema first so dep install is cached separately from source changes
COPY package*.json ./
COPY prisma ./prisma/

# npm ci runs the postinstall hook which calls prisma generate
RUN npm ci

COPY . .

EXPOSE 4000

# Apply any pending migrations, then start
CMD ["sh", "-c", "npx prisma migrate deploy && node index.js"]
