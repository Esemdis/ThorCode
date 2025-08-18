ThorCode Backend Toolbox API

A modular and production-ready Node.js backend built with Express. This project serves as a showcase of backend consulting expertise, integrating modern authentication flows, 3rd-party APIs, data exporting, and performance optimizations using scalable infrastructure.

✨ Features

  🧾 JWT & Role-based Authentication (Auth0-ready fallback)

  🔐 OAuth Integration Login via TMDB (with access token verification)

  🎮 Steam API Integration Fetch and persist top 5 most played games

  ☁️ Weather API Integration For demonstrating third-party API integration

  📊 Excel & PDF Export (planned) Generate downloadable user reports

  📦 Rate Limiting & Caching Built-in protection and Redis optimization

  🌍 Environment Variables Managed securely via Doppler

  🧵 Fully Modular Folder Structure Routes, middleware, and utilities

🏗️ Tech Stack
  Category	Technology
  Language	JavaScript (ES6+) / TypeScript-ready
  Framework	Express.js
  Auth	JWT + Role-based + OAuth (TMDB)
  Database	PostgreSQL (via Supabase or Prisma-ready)
  ORM	(Optional) Prisma
  API Hosting	Render
  Database Hosting	Supabase / Neon
  Cache	Upstash (Redis)
  Env Management	Doppler
  CI/CD	GitHub Actions (planned)
  Monitoring	Datadog / OpenTelemetry (planned)

🛠 Setup Instructions
1. Clone & Install

git clone https://github.com/your-username/thorcode.git
cd thorcode
npm install

2. Configure Environment

cp .env_example .env
# Fill in your tokens, API keys, database URL, etc.

3. Start the server

npm run dev

📤 Planned Features

  📁 Export to Excel / PDF

  ✉️ Email export to users

  ⚙️ Add GitHub Actions CI/CD pipeline for testing

  🌍 Add Swagger/OpenAPI docs

🎯 Use Case

This API can serve as:

  A portfolio project demonstrating backend architecture, auth flows, and API integration

  A modular boilerplate for future freelance/consulting projects
