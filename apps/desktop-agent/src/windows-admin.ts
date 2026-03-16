import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isRunningAsWindowsAdmin(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const script = [
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
    "$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
  ].join("; ");

  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
  return stdout.trim().toLowerCase() === "true";
}

export async function assertWindowsAdmin(context: string): Promise<void> {
  const isAdmin = await isRunningAsWindowsAdmin();
  if (!isAdmin) {
    throw new Error(`${context} requires an elevated Administrator shell on Windows`);
  }
}
