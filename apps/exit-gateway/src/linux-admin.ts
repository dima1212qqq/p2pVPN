export function assertLinuxTunPrivileges(context: string): void {
  if (process.platform !== "linux") {
    throw new Error(`${context} is only supported on Linux`);
  }

  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    throw new Error(`${context} requires a POSIX runtime with getuid() support`);
  }

  if (getuid() !== 0) {
    throw new Error(`${context} requires root or CAP_NET_ADMIN on Linux`);
  }
}
