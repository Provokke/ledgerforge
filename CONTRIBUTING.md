# Contributing

Thanks for wanting to help out. A few ground rules keep things easy.

## Getting set up

```sh
git clone https://github.com/Provokke/ledgerforge.git
cd ledgerforge
npm install
```

You'll need Node 22.18 or newer (24 is what the image uses) and Docker for the integration tests.

## Before you open a pull request

- Run `npm run typecheck` and `npm test`. Neither needs Docker.
- Run `npm run test:integration` if you touched the database, the queues or a service. It starts its own containers and cleans them up.
- Run `docker compose up -d --build` then `npm run e2e` if you changed anything that crosses services.
- Add a test for anything you change or add. Unit tests are `*.test.ts`, anything that needs real infrastructure is `*.itest.ts`.
- Keep comments short and plain, and use Australian spelling.

## House rules for the code

- Money is integers only. `number` is fine inside the matching book as long as it is a safe integer; everywhere else it is `bigint`. Never a float.
- Node strips the types, so no `enum`, no constructor parameter properties, `.ts` import extensions and `import type` for types.
- A consumer must be safe to run twice with the same message. Give every event an id and let the database reject the repeat.
- The journal is append-only. Fix a mistake with a new entry, never an update.

## Reporting bugs

Open an issue with what you ran, what you expected and what happened. Logs help. Every request carries an `x-request-id`, so send that along if you have it.

## Licence

By contributing, you agree your changes are released under the MIT licence in [LICENSE](LICENSE).
