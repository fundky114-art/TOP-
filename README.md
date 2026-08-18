# TRP Colombia Welcome

Cloudflare Worker for the TRP Colombia advertising landing page. It keeps the public landing URL stable while the active WhatsApp group invite can be changed from Telegram.

## Cloudflare products

- **Workers + Static Assets** serve the landing page and API routes.
- **Workers KV** stores the active WhatsApp group URL.
- **D1** stores privacy-minimized click events and hourly report state.
- **Cron Triggers** send an hourly click summary.
- **Workers Secrets** hold Telegram credentials; secrets are never committed.

## Routes

- `GET /` — Spanish landing page.
- `GET /go` — records a click, sends a Telegram notification, and redirects to WhatsApp.
- `GET /health` — checks link configuration and D1 availability.
- `POST /telegram/webhook` — accepts authenticated Telegram bot updates.

## Telegram commands

- `/setgroup https://chat.whatsapp.com/...` — change the active group link.
- `/status` or `/report` — show current link and click totals.
- `/test` — test the bot connection.

Only the chat ID stored in `TELEGRAM_ADMIN_CHAT_ID` can run commands.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

Use dummy Telegram values locally unless you intentionally want to call the real bot API.

## Production setup

Authenticate Wrangler, then create the resources before the first production deploy:

```bash
npx wrangler login
npx wrangler kv namespace create CONFIG
npx wrangler d1 create trp-colombia-clicks
```

Copy the returned resource IDs into `wrangler.jsonc`. Then apply the migration and set secrets:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID
```

Validate and deploy:

```bash
npm run check
npm run deploy
```

Finally register the webhook using the same `TELEGRAM_WEBHOOK_SECRET` value:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<WORKER_HOST>/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message"]}'
```

Do not commit tokens, chat IDs, `.dev.vars`, or `.env` files.

## Operational notes

- The hourly cron runs at minute `0` in UTC and reports the previous complete hour.
- Click records exclude IP addresses and are retained for 90 days.
- If the KV link is missing or malformed, `/go` falls back to `DEFAULT_WHATSAPP_URL`.
- The Worker can repair malformed KV configuration, but it cannot create a new WhatsApp invite if WhatsApp has revoked the group link. It reports the configured link so an administrator can replace it with `/setgroup`.
