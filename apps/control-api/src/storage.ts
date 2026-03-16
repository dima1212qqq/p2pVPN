import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export interface InviteCodeRecord {
  id: string;
  code: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  maxUses: number;
  uses: number;
  revoked: boolean;
}

export interface InviteCodesFile {
  version: 1;
  invites: InviteCodeRecord[];
}

export interface RegisteredDevice {
  clientFingerprint: string;
  publicKeyPem: string;
  name: string;
  registeredAt: string;
  inviteId: string;
  disabled: boolean;
}

export interface RegisteredDevicesFile {
  version: 1;
  devices: RegisteredDevice[];
}

export async function loadInviteCodes(path: string): Promise<InviteCodesFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as InviteCodesFile;

  if (parsed.version !== 1 || !Array.isArray(parsed.invites)) {
    throw new Error("Invalid invite codes file");
  }

  return parsed;
}

export async function saveInviteCodes(path: string, file: InviteCodesFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export async function loadRegisteredDevices(path: string): Promise<RegisteredDevicesFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as RegisteredDevicesFile;

  if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
    throw new Error("Invalid registered devices file");
  }

  return parsed;
}

export async function saveRegisteredDevices(path: string, file: RegisteredDevicesFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function createInviteCode(options: {
  label?: string;
  maxUses?: number;
  expiresAt?: string;
}): InviteCodeRecord {
  return {
    id: randomUUID(),
    code: randomBytes(12).toString("base64url"),
    label: options.label,
    createdAt: new Date().toISOString(),
    expiresAt: options.expiresAt,
    maxUses: options.maxUses ?? 1,
    uses: 0,
    revoked: false
  };
}
