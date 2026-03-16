import { readFile, writeFile } from "node:fs/promises";

export interface InviteBotConfig {
  version: 1;
  telegram: {
    botToken: string;
    allowedChatIds: number[];
    pollingTimeoutSeconds: number;
  };
  invites: {
    invitesPath: string;
    defaultMaxUses: number;
    maxMaxUses: number;
    inviteTtlMinutes: number;
    labelPrefix: string;
  };
}

export function generateInviteBotConfig(): InviteBotConfig {
  return {
    version: 1,
    telegram: {
      botToken: "",
      allowedChatIds: [],
      pollingTimeoutSeconds: 25
    },
    invites: {
      invitesPath: "./config/generated/invite-codes.json",
      defaultMaxUses: 1,
      maxMaxUses: 5,
      inviteTtlMinutes: 15,
      labelPrefix: "telegram"
    }
  };
}

export async function saveInviteBotConfig(path: string, config: InviteBotConfig): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadInviteBotConfig(path: string): Promise<InviteBotConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as InviteBotConfig;

  if (parsed.version !== 1) {
    throw new Error("Unsupported invite bot config version");
  }

  parsed.telegram.pollingTimeoutSeconds ??= 25;
  parsed.invites.defaultMaxUses ??= 1;
  parsed.invites.maxMaxUses ??= 5;
  parsed.invites.inviteTtlMinutes ??= 15;
  parsed.invites.labelPrefix ??= "telegram";

  return parsed;
}
