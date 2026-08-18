const ACTIVE_LINK_KEY = "active_whatsapp_url";
const HOUR_MS = 60 * 60 * 1000;
const MAX_TELEGRAM_BODY_BYTES = 64 * 1024;
const CLICK_RETENTION_MS = 90 * 24 * HOUR_MS;

type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
};

type LinkState = {
  url: string;
  source: "kv" | "fallback";
  repaired: boolean;
};

type ClickCounts = {
  lastHour: number;
  last24Hours: number;
  total: number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/go" && request.method === "GET") {
        return await handleRedirect(request, env, ctx);
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return await handleHealth(env, ctx);
      }

      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        return await handleTelegramWebhook(request, env);
      }

      return new Response("Not Found", {
        status: 404,
        headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "Internal server error";

      console.error(
        JSON.stringify({
          event: "request_error",
          path: new URL(request.url).pathname,
          status,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      return json({ ok: false, error: message }, status);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runHourlyReport(controller.scheduledTime, env).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "hourly_report_failed",
            scheduledTime: controller.scheduledTime,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleRedirect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const link = await resolveActiveLink(env);

  if (link.repaired) {
    ctx.waitUntil(
      env.CONFIG.put(ACTIVE_LINK_KEY, link.url).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "link_repair_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  }

  const clickedAt = Date.now();
  ctx.waitUntil(
    recordClickAndNotify(request, clickedAt, env).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "click_background_work_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );

  return Response.redirect(link.url, 302);
}

async function handleHealth(env: Env, ctx: ExecutionContext): Promise<Response> {
  const [linkResult, dbResult] = await Promise.allSettled([
    resolveActiveLink(env),
    env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
  ]);

  if (linkResult.status === "fulfilled" && linkResult.value.repaired) {
    ctx.waitUntil(
      env.CONFIG.put(ACTIVE_LINK_KEY, linkResult.value.url).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "health_link_repair_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  }

  const healthy = linkResult.status === "fulfilled" && dbResult.status === "fulfilled";
  return json(
    {
      ok: healthy,
      service: "trp-colombia-welcome",
      environment: env.ENVIRONMENT,
      link: linkResult.status === "fulfilled"
        ? { configured: true, source: linkResult.value.source, repaired: linkResult.value.repaired }
        : { configured: false },
      database: dbResult.status === "fulfilled" && dbResult.value?.ok === 1 ? "ok" : "error",
      checked_at: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!(await secureEqual(suppliedSecret, env.TELEGRAM_WEBHOOK_SECRET))) {
    throw new HttpError(401, "Unauthorized");
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_TELEGRAM_BODY_BYTES) {
    throw new HttpError(413, "Payload too large");
  }

  const update = await readTelegramUpdate(request);
  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();

  if (chatId === undefined || !text) {
    return json({ ok: true });
  }

  if (String(chatId) !== env.TELEGRAM_ADMIN_CHAT_ID) {
    console.warn(JSON.stringify({ event: "telegram_unauthorized_chat", updateId: update.update_id }));
    return json({ ok: true });
  }

  const command = normalizeCommand(text.split(/\s+/, 1)[0] ?? "");
  const argument = text.slice(text.indexOf(" ") + 1).trim();

  switch (command) {
    case "/start":
    case "/help":
      await sendTelegramMessage(env, helpText());
      break;

    case "/setgroup":
      if (!isWhatsAppInviteUrl(argument)) {
        await sendTelegramMessage(
          env,
          "格式不正确。请发送：\n/setgroup https://chat.whatsapp.com/你的群代码",
        );
        break;
      }
      await env.CONFIG.put(ACTIVE_LINK_KEY, argument);
      await sendTelegramMessage(env, `✅ 群链接已更新\n${argument}`);
      break;

    case "/status":
    case "/report": {
      const [link, counts] = await Promise.all([resolveActiveLink(env), getClickCounts(env, Date.now())]);
      await sendTelegramMessage(env, formatStatus(link, counts));
      break;
    }

    case "/test":
      await sendTelegramMessage(env, "✅ Telegram 控制端工作正常。");
      break;

    default:
      await sendTelegramMessage(env, helpText());
  }

  return json({ ok: true });
}

async function recordClickAndNotify(request: Request, clickedAt: number, env: Env): Promise<void> {
  const countryValue = request.cf?.country;
  const country = bounded(typeof countryValue === "string" ? countryValue : null, 8);
  const referer = bounded(request.headers.get("Referer"), 512);
  const userAgent = bounded(request.headers.get("User-Agent"), 256);

  const results = await Promise.allSettled([
    env.DB.prepare(
      "INSERT INTO clicks (id, clicked_at, country, referer, user_agent) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), clickedAt, country, referer, userAgent)
      .run(),
    sendTelegramMessage(
      env,
      [
        "🔔 新的进群按钮点击",
        `时间：${formatKualaLumpurTime(clickedAt)}`,
        `国家/地区：${country ?? "未知"}`,
      ].join("\n"),
    ),
  ]);

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          event: index === 0 ? "click_insert_failed" : "click_notification_failed",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }),
      );
    }
  }
}

async function runHourlyReport(scheduledTime: number, env: Env): Promise<void> {
  const windowEnd = Math.floor(scheduledTime / HOUR_MS) * HOUR_MS;
  const windowStart = windowEnd - HOUR_MS;
  const reportKey = new Date(windowStart).toISOString().slice(0, 13);

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM clicks WHERE clicked_at >= ? AND clicked_at < ?",
  )
    .bind(windowStart, windowEnd)
    .first<{ count: number }>();
  const clickCount = Number(countRow?.count ?? 0);

  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO hourly_reports (report_key, window_start, window_end, click_count, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(reportKey, windowStart, windowEnd, clickCount, Date.now())
    .run();

  if (Number(claim.meta.changes ?? 0) === 0) {
    console.log(JSON.stringify({ event: "hourly_report_duplicate_skipped", reportKey }));
    return;
  }

  const link = await resolveActiveLink(env);
  const message = [
    "📊 每小时点击报告",
    `时段：${formatKualaLumpurTime(windowStart)} – ${formatKualaLumpurTime(windowEnd)}`,
    `进群按钮点击：${clickCount} 次`,
    `跳转链接：${link.url}`,
    `链接状态：${link.repaired ? "已自动恢复为备用链接" : "配置正常"}`,
  ].join("\n");

  try {
    await sendTelegramMessage(env, message);
    await env.DB.prepare("UPDATE hourly_reports SET sent_at = ?, error = NULL WHERE report_key = ?")
      .bind(Date.now(), reportKey)
      .run();
  } catch (error) {
    const errorMessage = bounded(error instanceof Error ? error.message : String(error), 500);
    await env.DB.prepare("UPDATE hourly_reports SET error = ? WHERE report_key = ?")
      .bind(errorMessage, reportKey)
      .run();
    throw error;
  }

  await env.DB.prepare("DELETE FROM clicks WHERE clicked_at < ?")
    .bind(Date.now() - CLICK_RETENTION_MS)
    .run();
}

async function resolveActiveLink(env: Env): Promise<LinkState> {
  const stored = await env.CONFIG.get(ACTIVE_LINK_KEY);
  if (isWhatsAppInviteUrl(stored)) {
    return { url: stored, source: "kv", repaired: false };
  }

  if (!isWhatsAppInviteUrl(env.DEFAULT_WHATSAPP_URL)) {
    throw new HttpError(503, "No valid WhatsApp group link is configured");
  }

  return {
    url: env.DEFAULT_WHATSAPP_URL,
    source: "fallback",
    repaired: true,
  };
}

async function readTelegramUpdate(request: Request): Promise<TelegramUpdate> {
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_TELEGRAM_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Payload too large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }

  if (!isRecord(parsed)) return {};

  const updateId = typeof parsed.update_id === "number" ? parsed.update_id : undefined;
  const rawMessage = parsed.message;
  if (!isRecord(rawMessage)) return { update_id: updateId };

  const rawChat = rawMessage.chat;
  const chatId = isRecord(rawChat) &&
      (typeof rawChat.id === "number" || typeof rawChat.id === "string")
    ? rawChat.id
    : undefined;
  const text = typeof rawMessage.text === "string" ? rawMessage.text : undefined;

  return {
    update_id: updateId,
    message: {
      chat: { id: chatId },
      text,
    },
  };
}

async function getClickCounts(env: Env, now: number): Promise<ClickCounts> {
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN clicked_at >= ? THEN 1 ELSE 0 END) AS last_hour,
      SUM(CASE WHEN clicked_at >= ? THEN 1 ELSE 0 END) AS last_24_hours,
      COUNT(*) AS total
    FROM clicks`,
  )
    .bind(now - HOUR_MS, now - 24 * HOUR_MS)
    .first<{ last_hour: number | null; last_24_hours: number | null; total: number }>();

  return {
    lastHour: Number(row?.last_hour ?? 0),
    last24Hours: Number(row?.last_24_hours ?? 0),
    total: Number(row?.total ?? 0),
  };
}

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.warn(JSON.stringify({ event: "telegram_not_configured" }));
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Telegram API returned HTTP ${response.status}`);
  }

  await response.body?.cancel();
}

function isWhatsAppInviteUrl(value: string | null | undefined): value is string {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "chat.whatsapp.com" &&
      /^\/[A-Za-z0-9_-]{10,}$/.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function secureEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/@[^\s]+$/, "");
}

function helpText(): string {
  return [
    "TRP 控制指令：",
    "/setgroup <WhatsApp链接> — 更换群链接",
    "/status — 查看当前链接与点击统计",
    "/report — 立即查看统计",
    "/test — 测试机器人连接",
  ].join("\n");
}

function formatStatus(link: LinkState, counts: ClickCounts): string {
  return [
    "📍 TRP 当前状态",
    `群链接：${link.url}`,
    `链接来源：${link.source === "kv" ? "Telegram 设置" : "备用配置"}`,
    `最近 1 小时：${counts.lastHour} 次点击`,
    `最近 24 小时：${counts.last24Hours} 次点击`,
    `累计保留：${counts.total} 次点击`,
  ].join("\n");
}

function formatKualaLumpurTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function bounded(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function securityHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("X-Content-Type-Options", "nosniff");
  result.set("X-Frame-Options", "DENY");
  result.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return result;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}
