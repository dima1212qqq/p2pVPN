import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { networkCidrFromHost } from "./ipv4.js";

const execFileAsync = promisify(execFile);

export interface LinuxNetworkPlanItem {
  command: string;
  reason: string;
}

export interface LinuxNetworkRuntimeOptions {
  interfaceName: string;
  gatewayIpv4: string;
  tunnelPrefixLength: number;
  applySystemNetwork: boolean;
  enableIpForwarding: boolean;
  natMode: "none" | "iptables-masquerade";
  egressInterface?: string;
}

export class LinuxNetworkRuntime {
  private readonly options: LinuxNetworkRuntimeOptions;
  private applied = false;
  private previousIpv4Forward: string | null = null;
  private resolvedEgressInterface: string | null = null;

  public constructor(options: LinuxNetworkRuntimeOptions) {
    this.options = options;
  }

  public describePlan(): LinuxNetworkPlanItem[] {
    const tunnelSubnet = networkCidrFromHost(this.options.gatewayIpv4, this.options.tunnelPrefixLength);
    const plan: LinuxNetworkPlanItem[] = [];

    if (this.options.enableIpForwarding) {
      plan.push({
        command: "sysctl -w net.ipv4.ip_forward=1",
        reason: "Allow Linux to route packets between the tunnel and the public interface"
      });
    }

    if (this.options.natMode === "iptables-masquerade") {
      const egress = this.options.egressInterface ?? "<default-egress>";
      plan.push({
        command: `iptables -A FORWARD -i ${this.options.interfaceName} -j ACCEPT`,
        reason: "Accept packets coming from the VPN tunnel"
      });
      plan.push({
        command: `iptables -A FORWARD -o ${this.options.interfaceName} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
        reason: "Allow return traffic back into the VPN tunnel"
      });
      plan.push({
        command: `iptables -t nat -A POSTROUTING -s ${tunnelSubnet} -o ${egress} -j MASQUERADE`,
        reason: "NAT client traffic to the server's public interface"
      });
    }

    return plan;
  }

  public async apply(): Promise<void> {
    if (!this.options.applySystemNetwork || this.applied) {
      return;
    }

    if (this.options.enableIpForwarding) {
      this.previousIpv4Forward = await readProcValue("/proc/sys/net/ipv4/ip_forward");
      await execFileAsync("sysctl", ["-w", "net.ipv4.ip_forward=1"]);
    }

    if (this.options.natMode === "iptables-masquerade") {
      this.resolvedEgressInterface = this.options.egressInterface ?? (await detectDefaultEgressInterface());
      const tunnelSubnet = networkCidrFromHost(this.options.gatewayIpv4, this.options.tunnelPrefixLength);

      await execFileAsync("iptables", ["-A", "FORWARD", "-i", this.options.interfaceName, "-j", "ACCEPT"]);
      await execFileAsync("iptables", [
        "-A",
        "FORWARD",
        "-o",
        this.options.interfaceName,
        "-m",
        "conntrack",
        "--ctstate",
        "RELATED,ESTABLISHED",
        "-j",
        "ACCEPT"
      ]);
      await execFileAsync("iptables", [
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        tunnelSubnet,
        "-o",
        this.resolvedEgressInterface,
        "-j",
        "MASQUERADE"
      ]);
    }

    this.applied = true;
  }

  public async cleanup(): Promise<void> {
    if (!this.options.applySystemNetwork || !this.applied) {
      return;
    }

    if (this.options.natMode === "iptables-masquerade" && this.resolvedEgressInterface) {
      const tunnelSubnet = networkCidrFromHost(this.options.gatewayIpv4, this.options.tunnelPrefixLength);

      await execFileAsync("iptables", [
        "-D",
        "FORWARD",
        "-i",
        this.options.interfaceName,
        "-j",
        "ACCEPT"
      ]).catch(() => undefined);
      await execFileAsync("iptables", [
        "-D",
        "FORWARD",
        "-o",
        this.options.interfaceName,
        "-m",
        "conntrack",
        "--ctstate",
        "RELATED,ESTABLISHED",
        "-j",
        "ACCEPT"
      ]).catch(() => undefined);
      await execFileAsync("iptables", [
        "-t",
        "nat",
        "-D",
        "POSTROUTING",
        "-s",
        tunnelSubnet,
        "-o",
        this.resolvedEgressInterface,
        "-j",
        "MASQUERADE"
      ]).catch(() => undefined);
    }

    if (this.options.enableIpForwarding && this.previousIpv4Forward !== null) {
      await execFileAsync("sysctl", ["-w", `net.ipv4.ip_forward=${this.previousIpv4Forward}`]).catch(() => undefined);
    }

    this.applied = false;
    this.previousIpv4Forward = null;
    this.resolvedEgressInterface = null;
  }
}

async function detectDefaultEgressInterface(): Promise<string> {
  const { stdout } = await execFileAsync("ip", ["route", "show", "default"]);
  const match = stdout.match(/\bdev\s+(\S+)/);

  if (!match?.[1]) {
    throw new Error("Could not detect default egress interface from 'ip route show default'");
  }

  return match[1];
}

async function readProcValue(path: string): Promise<string> {
  const value = await readFile(path, "utf8");
  return value.trim();
}
