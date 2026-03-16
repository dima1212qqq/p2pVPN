import { spawn } from "node:child_process";

import type { InviteBotConfig } from "./config.js";

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: {
      id: number;
    };
    from?: TelegramUser;
  };
}

interface TelegramUser {
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface RunningInviteBot {
  close: () => Promise<void>;
}

export interface StartInviteBotOptions {
  config: InviteBotConfig;
  projectRoot: string;
}

export async function startInviteBot(options: StartInviteBotOptions): Promise<RunningInviteBot> {
  if (!options.config.telegram.botToken) {
    throw new Error("telegram.botToken is required");
  }

  const controller = new AbortController();
  let offset = 0;

  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const updates = await getUpdates(options.config, offset, controller.signal);

        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(options, update);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }

        console.error(`[invite-bot] ${error instanceof Error ? error.message : String(error)}`);
        await delay(2_000, controller.signal).catch(() => undefined);
      }
    }
  })();

  console.log("[invite-bot] started");

  return {
    close: async () => {
      controller.abort();
      await loop.catch(() => undefined);
    }
  };
}

async function handleUpdate(options: StartInviteBotOptions, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text) {
    return;
  }

  const chatId = message.chat.id;
  if (!options.config.telegram.allowedChatIds.includes(chatId)) {
    console.warn(`[invite-bot] unauthorized chatId=${chatId} user=${buildInviteLabel("telegram", message.from)}`);
    await sendMessage(options.config, chatId, "Access denied.");
    return;
  }

  const text = message.text.trim();
  if (text === "/start" || text === "/help") {
    await sendMessage(
      options.config,
      chatId,
      [
        "Commands:",
        "/invite",
        "/invite <maxUses>",
        "/whoami",
        "",
        "Example:",
        "/invite 3"
      ].join("\n")
    );
    return;
  }

  if (text === "/whoami") {
    await sendMessage(options.config, chatId, `chatId: \`${String(chatId)}\``);
    return;
  }

  if (!text.startsWith("/invite")) {
    await sendMessage(options.config, chatId, "Unknown command. Use /help");
    return;
  }

  const maxUses = parseMaxUses(text, options.config.invites.defaultMaxUses, options.config.invites.maxMaxUses);
  const label = buildInviteLabel(options.config.invites.labelPrefix, message.from);
  const inviteCode = await createInviteCodeViaCli({
    projectRoot: options.projectRoot,
    invitesPath: options.config.invites.invitesPath,
    label,
    maxUses
  });

  await sendMessage(
    options.config,
    chatId,
    [
      `Invite code: \`${inviteCode}\``,
      `max uses: ${maxUses}`
    ].join("\n")
  );
}

function parseMaxUses(text: string, defaultValue: number, maxAllowed: number): number {
  const [, value] = text.split(/\s+/u, 2);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }

  return Math.min(parsed, maxAllowed);
}

function buildInviteLabel(
  prefix: string,
  from: TelegramUser | undefined
): string {
  const username = from?.username?.trim();
  const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim();
  const suffix = username || displayName || "telegram-user";
  return `${prefix}:${suffix}`;
}

async function createInviteCodeViaCli(options: {
  projectRoot: string;
  invitesPath: string;
  label: string;
  maxUses: number;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "node",
      [
        "apps/control-api/dist/cli.js",
        "create-invite",
        "--invites",
        options.invitesPath,
        "--label",
        options.label,
        "--max-uses",
        String(options.maxUses)
      ],
      {
        cwd: options.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `create-invite failed${signal ? ` via signal ${signal}` : ` with code ${code ?? "null"}`}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        );
        return;
      }

      const line = stdout
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .find((item) => item.startsWith("[control-api] invite="));

      if (!line) {
        reject(new Error(`create-invite did not return invite code. Output: ${stdout.trim()}`));
        return;
      }

      resolve(line.split("=").at(-1) ?? "");
    });
  });
}

async function getUpdates(config: InviteBotConfig, offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
  const response = await telegramFetch<TelegramUpdate[]>(config, "getUpdates", {
    offset,
    timeout: config.telegram.pollingTimeoutSeconds
  }, signal);

  return response;
}

async function sendMessage(config: InviteBotConfig, chatId: number, text: string): Promise<void> {
  await telegramFetch(
    config,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    },
    undefined
  );
}

async function telegramFetch<TResult>(
  config: InviteBotConfig,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<TResult> {
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
  }

  const parsed = (await response.json()) as TelegramResponse<TResult>;
  if (!parsed.ok) {
    throw new Error(`Telegram API ${method} returned ok=false`);
  }

  return parsed.result;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}
