import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { SessionConfigMessage } from "@p2pvpn/protocol";

import type { RouteBypassTarget } from "./network-types.js";

const execFileAsync = promisify(execFile);

export interface WindowsNetworkSessionOptions {
  adapterName: string;
  applyRoutes: boolean;
  bypassTargets: RouteBypassTarget[];
}

export interface NetworkCommandPlan {
  command: string;
  reason: string;
}

interface ResolvedDefaultRoute {
  interfaceIndex: number;
  interfaceAlias: string;
  nextHop: string;
  routeMetric: number;
  interfaceMetric: number;
}

export class WindowsNetworkSession {
  private readonly adapterName: string;
  private readonly sessionConfig: SessionConfigMessage;
  private readonly applyRoutes: boolean;
  private readonly bypassTargets: RouteBypassTarget[];
  private applied = false;
  private adapterInterfaceIndex: number | null = null;
  private uplinkRoute: ResolvedDefaultRoute | null = null;
  private appliedBypassTargets: RouteBypassTarget[] = [];

  public constructor(sessionConfig: SessionConfigMessage, options: WindowsNetworkSessionOptions) {
    this.adapterName = options.adapterName;
    this.sessionConfig = sessionConfig;
    this.applyRoutes = options.applyRoutes;
    this.bypassTargets = options.bypassTargets;
  }

  public describePlan(): NetworkCommandPlan[] {
    const plan: NetworkCommandPlan[] = [
      {
        command: `Get-NetAdapter -Name '${this.adapterName}'`,
        reason: "Resolve adapter index for route programming"
      },
      {
        command: "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0'",
        reason: "Resolve the current uplink gateway before changing the default route"
      },
      {
        command: `netsh interface ip set dnsservers name="${this.adapterName}" static ${this.sessionConfig.dnsServers[0] ?? "1.1.1.1"} primary`,
        reason: "Point adapter DNS to the server-provided resolver"
      },
      {
        command: `route add 0.0.0.0 mask 0.0.0.0 ${this.sessionConfig.gatewayIpv4} if <ifIndex> metric 5`,
        reason: "Send default IPv4 traffic into the tunnel"
      }
    ];

    for (const target of this.bypassTargets) {
      plan.splice(2, 0, {
        command: `route add ${target.ip} mask 255.255.255.255 <uplinkNextHop> if <uplinkIfIndex> metric 1`,
        reason: target.reason
      });
    }

    return plan;
  }

  public async apply(): Promise<void> {
    if (!this.applyRoutes || this.applied) {
      return;
    }

    const interfaceIndex = await this.resolveInterfaceIndex();
    const uplinkRoute = await this.resolveDefaultRoute();
    const primaryDns = this.sessionConfig.dnsServers[0];

    this.adapterInterfaceIndex = interfaceIndex;
    this.uplinkRoute = uplinkRoute;

    for (const target of this.bypassTargets) {
      await execFileAsync("route", [
        "delete",
        target.ip,
        "mask",
        "255.255.255.255",
        uplinkRoute.nextHop,
        "if",
        String(uplinkRoute.interfaceIndex)
      ]).catch(() => undefined);

      await execFileAsync("route", [
        "add",
        target.ip,
        "mask",
        "255.255.255.255",
        uplinkRoute.nextHop,
        "if",
        String(uplinkRoute.interfaceIndex),
        "metric",
        "1"
      ]);
    }

    this.appliedBypassTargets = [...this.bypassTargets];

    if (primaryDns) {
      await execFileAsync("netsh", [
        "interface",
        "ip",
        "set",
        "dnsservers",
        `name=${this.adapterName}`,
        "static",
        primaryDns,
        "primary"
      ]);

      for (let index = 1; index < this.sessionConfig.dnsServers.length; index += 1) {
        const dnsServer = this.sessionConfig.dnsServers[index];
        if (!dnsServer) {
          continue;
        }

        await execFileAsync("netsh", [
          "interface",
          "ip",
          "add",
          "dnsservers",
          `name=${this.adapterName}`,
          dnsServer,
          `index=${index + 1}`
        ]);
      }
    }

    await execFileAsync("route", [
      "delete",
      "0.0.0.0",
      "mask",
      "0.0.0.0",
      this.sessionConfig.gatewayIpv4,
      "if",
      String(interfaceIndex)
    ]).catch(() => undefined);

    await execFileAsync("route", [
      "add",
      "0.0.0.0",
      "mask",
      "0.0.0.0",
      this.sessionConfig.gatewayIpv4,
      "if",
      String(interfaceIndex),
      "metric",
      "5"
    ]);

    this.applied = true;
  }

  public async cleanup(): Promise<void> {
    if (!this.applyRoutes || !this.applied) {
      return;
    }

    const interfaceIndex = this.adapterInterfaceIndex ?? (await this.resolveInterfaceIndex().catch(() => null));

    if (interfaceIndex !== null) {
      await execFileAsync("route", [
        "delete",
        "0.0.0.0",
        "mask",
        "0.0.0.0",
        this.sessionConfig.gatewayIpv4,
        "if",
        String(interfaceIndex)
      ]).catch(() => undefined);
    }

    if (this.uplinkRoute) {
      for (const target of this.appliedBypassTargets) {
        await execFileAsync("route", [
          "delete",
          target.ip,
          "mask",
          "255.255.255.255",
          this.uplinkRoute.nextHop,
          "if",
          String(this.uplinkRoute.interfaceIndex)
        ]).catch(() => undefined);
      }
    }

    await execFileAsync("netsh", [
      "interface",
      "ip",
      "set",
      "dnsservers",
      `name=${this.adapterName}`,
      "dhcp"
    ]).catch(() => undefined);

    this.applied = false;
    this.adapterInterfaceIndex = null;
    this.uplinkRoute = null;
    this.appliedBypassTargets = [];
  }

  private async resolveInterfaceIndex(): Promise<number> {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const script = [
        `$adapter = Get-NetAdapter -Name '${escapePowerShellSingleQuoted(this.adapterName)}' -ErrorAction Stop`,
        "$adapter.ifIndex"
      ].join("; ");

      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]).catch(() => ({
        stdout: ""
      }));
      const parsed = Number.parseInt(stdout.trim(), 10);

      if (Number.isInteger(parsed)) {
        return parsed;
      }

      await delay(250 * attempt);
    }

    throw new Error(`Could not resolve interface index for adapter '${this.adapterName}'`);
  }

  private async resolveDefaultRoute(): Promise<ResolvedDefaultRoute> {
    const script = [
      "$route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |",
      "  Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' } |",
      "  Sort-Object @{Expression={ $_.RouteMetric + $_.InterfaceMetric }}, RouteMetric, InterfaceMetric |",
      "  Select-Object -First 1",
      "    @{Name='interfaceIndex';Expression={$_.InterfaceIndex}},",
      "    @{Name='interfaceAlias';Expression={$_.InterfaceAlias}},",
      "    @{Name='nextHop';Expression={$_.NextHop}},",
      "    @{Name='routeMetric';Expression={$_.RouteMetric}},",
      "    @{Name='interfaceMetric';Expression={$_.InterfaceMetric}}",
      "if (-not $route) { throw 'No active IPv4 default route found' }",
      "$route | ConvertTo-Json -Compress"
    ].join(" ");

    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
    const parsed = JSON.parse(stdout.trim()) as Partial<ResolvedDefaultRoute>;

    if (
      !Number.isInteger(parsed.interfaceIndex) ||
      typeof parsed.interfaceAlias !== "string" ||
      typeof parsed.nextHop !== "string"
    ) {
      throw new Error("Could not resolve the active IPv4 default route");
    }

    const interfaceIndex = parsed.interfaceIndex as number;
    const interfaceAlias = parsed.interfaceAlias as string;
    const nextHop = parsed.nextHop as string;

    return {
      interfaceIndex,
      interfaceAlias,
      nextHop,
      routeMetric: Number(parsed.routeMetric ?? 0),
      interfaceMetric: Number(parsed.interfaceMetric ?? 0)
    };
  }
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}
