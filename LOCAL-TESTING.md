# Local Gmail and Proton testing

This branch is a personal testing prototype. Run the web app on your computer so it can reach Proton Mail Bridge on loopback. PostgreSQL and Redis run in the existing development Compose stack. No external Inbox Zero account or hosted database is required. Google OAuth and a paid Proton Mail plan with Bridge are still required for real mail.

## What is consolidated

The fork starts from upstream `elie222/inbox-zero` main at `db610cb2636abe45fa4e7bcf01f0edd6dbdda501`. It merges [PR #2194](https://github.com/elie222/inbox-zero/pull/2194), `tozzilla:feat/imap-provider`, head `23878c58ef44917446b820e36cb883ca06499cd1`, with substantial repairs for the current provider and draft contracts. The PR's old password-login changes and unfinished polling endpoint are excluded. Existing Google and Microsoft OAuth stay in place. Account linking uses an authenticated server action, encrypted credentials, an explicit host allowlist and verified TLS.

PWA, combined-account views, TypeSafe/Jev configuration and experimental Codex CLI integration are already on current upstream main. No separate branch is needed for those. This does not establish that all existing features work with Proton. The original LICENSE remains in force.

## Start the local app

Use Node 24 and the repository's pinned pnpm through Corepack. From the repository root:

```sh
corepack pnpm install --frozen-lockfile --filter '!@inboxzero/desktop'
cp apps/web/.env.example apps/web/.env
chmod 600 apps/web/.env
```

If `.env` already exists, edit it instead of copying over it. Set these values there:

```dotenv
NEXT_PUBLIC_BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/inboxzero?schema=public
DIRECT_URL=postgresql://postgres:password@localhost:5432/inboxzero?schema=public
UPSTASH_REDIS_URL=http://localhost:8079
UPSTASH_REDIS_TOKEN=dev_token
REDIS_URL=redis://localhost:6380
QUEUE_BACKEND=internal
NEXT_PUBLIC_ENABLE_IMAP=true
IMAP_ALLOWED_HOSTS=127.0.0.1,localhost
NEXT_PUBLIC_AUTO_DRAFT_DISABLED=true
NEXT_PUBLIC_EMAIL_SEND_ENABLED=false
CLI_LLM_ENABLED=false
DEFAULT_CLASSIFIER_ENABLED=false
```

Generate separate random values for `AUTH_SECRET`, `EMAIL_ENCRYPT_SECRET`, `EMAIL_ENCRYPT_SALT` and `CRON_SECRET`, for example with `openssl rand -hex 32`, and paste them into the ignored `.env`. Keep the encryption values stable or stored mailbox credentials will become unreadable. Set `AUTH_ALLOWED_EMAILS` to your Google test address. Leave AI API keys, classifier selection, telemetry credentials and real webhook configuration unset for the first mail test. Sending is deliberately disabled above; enable `NEXT_PUBLIC_EMAIL_SEND_ENABLED` and restart when you choose to test sending.

Start infrastructure and apply migrations:

```sh
docker compose -f docker-compose.dev.yml up -d db redis serverless-redis-http
corepack pnpm --filter inbox-zero-ai exec prisma migrate deploy
```

On a Podman machine, `podman compose` with a Compose provider is equivalent. The database and Redis ports in this Compose file bind only to loopback. If ports are occupied, use its port override variables and update the app URLs to match.

## Google test login

Create a Google Cloud project, enable Gmail API, configure the OAuth consent screen for External testing and add your test Google address as a test user. Create a Web application OAuth client with origin `http://localhost:3000` and both redirect URLs:

- `http://localhost:3000/api/auth/callback/google`
- `http://localhost:3000/api/google/linking/callback`

Put its `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. The existing env validator also requires a nonempty `GOOGLE_PUBSUB_TOPIC_NAME`; retain the example value for manual testing, but it is not a working subscription. Automatic Gmail processing requires a real Pub/Sub topic and reachable, authenticated webhook. Watch setup may report an error until that is configured. Google testing-mode grants can expire and require reconnection.

## Proton Bridge

Install and sign in to Proton Mail Bridge using your agent mailbox. Use the email address, Bridge-generated password, host, ports and encryption modes displayed by Bridge. The defaults in the form are `127.0.0.1:1143` for IMAP and `127.0.0.1:1025` for SMTP with STARTTLS. They must match your Bridge settings. This prototype requires the email field to match the Bridge username; aliases need further work.

Export Bridge's TLS certificate using its settings. Before starting Node, trust that certificate through an absolute path:

```sh
export NODE_EXTRA_CA_CERTS=/absolute/path/to/bridge-certificate.pem
corepack pnpm --filter inbox-zero-ai exec next dev --hostname 127.0.0.1 --port 3000
```

Use a hostname covered by the certificate. If it covers `localhost` rather than `127.0.0.1`, enter `localhost` for both servers in the form. Do not disable certificate verification. Bridge and this Node process must remain running for Proton access.

Open `http://localhost:3000`, sign in with the Google test account, open Accounts and choose **Add Proton / IMAP account**. Both IMAP and SMTP authentication are tested before credentials are saved. A connection test does not send mail. Remove the linked account through the existing Accounts menu; reconnect it to replace changed Bridge credentials.

Check reading, unread counts, account identity, attachments, archive and undo against the original mailbox. Use disposable messages. Create, edit and discard a draft, reload and check that only the intended draft changes. Enable sending only when ready and send a test message to another account you control. SMTP and IMAP are not an atomic transaction: after an uncertain send result, inspect Sent before retrying.

## Limits and next checks

Proton background automation, incremental/offline mailbox synchronization, contacts, provider filters, advanced split queries and aliases are not implemented. Refresh the online mailbox to see external changes. The adapter rejects unsupported operations. Pagination is message-based within folders; a thread can span pages, and cross-folder results do not promise one global date order. Large mailboxes and Proton's virtual folders need live testing. Archive/Trash undo returns messages to Inbox and needs an RFC Message-ID; undo to arbitrary original folders is not implemented. Attachments are currently buffered in memory.

The app already has a PWA manifest and service worker. A localhost desktop test does not give your phone access to it. Mobile access needs a reachable HTTPS app and a continuously available Bridge host. Published native apps' compatibility with this self-hosted fork is unverified. No mobile hosting or device synchronization service is provisioned here.

Codex CLI and Jev are optional later steps. See `.env.example` for role-specific model settings. CLI support depends on a separately installed, pinned community AI SDK provider; compatibility with this checkout's AI SDK version and the installed Codex executable has not been verified. Leave it disabled for the mail smoke test. Running Codex locally can still send selected mail to a hosted model. Jev configuration does not make the missing Proton background pipeline work.

## Verification

Account-linking tests cover authentication, identity mismatch, failed connection handling and encrypted persistence. Connection policy tests cover disabled access, plaintext and non-allowlisted hosts. Provider tests cover mailbox identity, MIME/thread parsing, mutation targeting and draft behavior. A throwaway PostgreSQL database successfully applied all 280 migrations, including the new credential table. On 2026-09-19, 19 adapter tests, 7 connection-policy/linking tests and 48 existing provider/compose/watch/rate-limit/local-sync regression tests passed. Folder-route and external-link regression tests also passed. The Google emulator login and Bridge dialog Playwright checks passed, with the dialog screenshot reviewed. Focused TypeScript diagnostics for the changed app files and Biome checks passed; a full production build was not run. A migration/schema comparison reports four pre-existing index-name differences in unrelated tables, with no IMAP schema difference. No real mailbox credentials or message content were used in these checks.
