## Agent pipeline guide

Rules for the agents that work tickets here. `README.md` says what the API is;
this says how to change it without breaking a deploy.

### Branches and deploys

- `main` auto-deploys: a push runs `.github/workflows/deploy.yml`, which pushes
  `ghcr.io/esemdis/thorcode:latest`, and Watchtower pulls it. Never push to
  `main`. Use a feature branch and a PR.
- The image build `needs` two jobs, `test` (`npx vitest run`) and `database`
  (`migrate deploy` into an empty Postgres 16, a drift check, then
  `vitest run test/integration`). **A red test on `main` blocks every deploy,**
  not just the one that broke it. Check the Actions tab before you assume your
  change is live.
- The container boots with `npx prisma migrate deploy && node index.js`
  (`Dockerfile`), so a merged migration is applied to production the moment the
  image starts. A failed migration stops the API from starting.

### Verify

```sh
npm ci --no-audit --no-fund --loglevel=error && npm test 2>&1 | tail -n 60
```

This runs the unit tests only. Prisma is faked in `test/routeApp.js`, so they
need no database.

- **Never run `npm run test:integration`** in the agent sandbox: it needs a real
  Postgres. CI runs it. If a change touches database queries or the Prisma
  schema, the PR must say the integration tests were NOT run and must be run
  locally before merge.
- `npm ci` runs `prisma generate` as a postinstall, and its engine download can
  403 in the sandbox. That fails `npm ci` and so skips `npm test` in the `&&`
  chain. `npm ci --ignore-scripts` is acceptable, but the PR must say you used
  it. Without a generated client `utils/prismaAccessors.test.js` cannot load,
  so expect that file to fail there.
- On `main` today `routes/data/media.test.js` fails (the sidecar test, THO-423).
  Say so in the PR rather than assuming you broke it.

### Migrations

Any file under `prisma/migrations/` means the PR is never auto-merged. Say so
in the PR body, and say whether production rows could break the new constraint.
The CI drift check must pass: a schema change without a migration fails there.

### Consumers

- **concert-map** calls `/data/concerts`. **python-crohn** is the sync service:
  it signs in with `BACKEND_TOKEN`, a `SYSTEM` role JWT from
  `scripts/generate-service-token.js`, and posts scraped data back.
- **travel-bag** calls `/travel/*`. **wander** reads travel-bag's packing list
  and todos from `/travel/trips/:id/*` (`services/thorcode.js` there) with a
  user's own long-lived `USER` token.
- Before you change a response shape or remove a route, grep those repos for
  it. A change an API consumer needs states the merge order in the PR, and
  ThorCode goes first.

### Tests

- Add tests for new logic. A bug fix needs a test that fails before the fix.
- Name new helpers and module-level constants after your change, so they cannot
  clash with another open PR that edits the same test file.
- Vitest runs with `mockReset: true` (`vitest.config.js`): set mock
  implementations inside each test.
