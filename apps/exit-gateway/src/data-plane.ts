import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import type { ServerConfig } from "./config.js";
import { readIpv4FromPacket, isIpv4Packet } from "./ipv4.js";
import { assertLinuxTunPrivileges } from "./linux-admin.js";
import { LinuxNetworkRuntime } from "./linux-network.js";

const require = createRequire(import.meta.url);

interface LinuxTunModule {
  LinuxTun?: new () => LinuxTunDevice;
}

interface LinuxTunDevice extends EventEmitter {
  readonly name: string;
  mtu: number;
  ipv4: string;
  isUp: boolean;
  write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean;
  release(callback?: () => void): void;
  on(event: "data", listener: (packet: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

export interface SessionPacketStats {
  sessionPacketsTx: number;
  sessionPacketsRx: number;
}

export interface PacketSession extends EventEmitter<{
  packet: [Buffer];
  stats: [SessionPacketStats];
}> {
  handleClientPacket(packet: Uint8Array): void;
  getStats(): SessionPacketStats;
  close(): Promise<void>;
}

export interface PacketSessionFactory {
  readonly mode: "none" | "dev-loopback" | "tun";
  createSession(options: CreatePacketSessionOptions): Promise<PacketSession | null>;
  describe(): string[];
  close(): Promise<void>;
}

export interface CreatePacketSessionOptions {
  mode: "none" | "dev-loopback" | "tun";
  sessionId: string;
  assignedTunnelIpv4: string;
}

export async function createPacketSessionFactory(config: ServerConfig): Promise<PacketSessionFactory> {
  if (config.dataPlane.mode === "none") {
    return new DisabledPacketSessionFactory();
  }

  if (config.dataPlane.mode === "dev-loopback") {
    return new DevLoopbackPacketSessionFactory();
  }

  return LinuxTunPacketSessionFactory.create(config);
}

class DisabledPacketSessionFactory implements PacketSessionFactory {
  public readonly mode = "none" as const;

  public async createSession(options: CreatePacketSessionOptions): Promise<PacketSession | null> {
    if (options.mode !== "none") {
      throw new Error(`Server data plane is disabled, but session requested '${options.mode}'`);
    }

    return null;
  }

  public describe(): string[] {
    return ["mode=none"];
  }

  public async close(): Promise<void> {
    return undefined;
  }
}

class DevLoopbackPacketSessionFactory implements PacketSessionFactory {
  public readonly mode = "dev-loopback" as const;

  public async createSession(options: CreatePacketSessionOptions): Promise<PacketSession | null> {
    if (options.mode === "none") {
      return null;
    }

    if (options.mode !== "dev-loopback") {
      throw new Error(`Dev loopback factory cannot serve session mode '${options.mode}'`);
    }

    return new DevLoopbackPacketSession();
  }

  public describe(): string[] {
    return ["mode=dev-loopback"];
  }

  public async close(): Promise<void> {
    return undefined;
  }
}

class LinuxTunPacketSessionFactory implements PacketSessionFactory {
  public readonly mode = "tun" as const;
  private readonly runtime: LinuxTunRuntime;

  private constructor(runtime: LinuxTunRuntime) {
    this.runtime = runtime;
  }

  public static async create(config: ServerConfig): Promise<LinuxTunPacketSessionFactory> {
    const runtime = await LinuxTunRuntime.create(config);
    return new LinuxTunPacketSessionFactory(runtime);
  }

  public async createSession(options: CreatePacketSessionOptions): Promise<PacketSession | null> {
    if (options.mode === "none") {
      return null;
    }

    if (options.mode !== "tun") {
      throw new Error(`Linux TUN factory cannot serve session mode '${options.mode}'`);
    }

    return this.runtime.createSession(options.sessionId, options.assignedTunnelIpv4);
  }

  public describe(): string[] {
    return this.runtime.describe();
  }

  public async close(): Promise<void> {
    await this.runtime.close();
  }
}

export class DevLoopbackPacketSession extends EventEmitter<{
  packet: [Buffer];
  stats: [SessionPacketStats];
}> implements PacketSession {
  private closed = false;
  private packetTx = 0;
  private packetRx = 0;
  private readonly inflightTasks = new Set<Promise<void>>();

  public handleClientPacket(packet: Uint8Array): void {
    if (this.closed) {
      return;
    }

    this.packetRx += 1;

    const task = this.echoPacket(packet);
    this.inflightTasks.add(task);
    void task.finally(() => this.inflightTasks.delete(task));
  }

  public getStats(): SessionPacketStats {
    return {
      sessionPacketsTx: this.packetTx,
      sessionPacketsRx: this.packetRx
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.inflightTasks]);
  }

  private async echoPacket(packet: Uint8Array): Promise<void> {
    await delay(25);

    if (this.closed) {
      return;
    }

    this.packetTx += 1;
    this.emit("packet", Buffer.from(packet));
    this.emit("stats", this.getStats());
  }
}

class LinuxTunRuntime {
  private readonly config: ServerConfig;
  private readonly tun: LinuxTunDevice;
  private readonly networkRuntime: LinuxNetworkRuntime;
  private readonly sessions = new Map<string, LinuxTunPacketSession>();
  private closed = false;

  private constructor(config: ServerConfig, tun: LinuxTunDevice, networkRuntime: LinuxNetworkRuntime) {
    this.config = config;
    this.tun = tun;
    this.networkRuntime = networkRuntime;
  }

  public static async create(config: ServerConfig): Promise<LinuxTunRuntime> {
    assertLinuxTunPrivileges("Linux TUN data plane");
    await access("/dev/net/tun");

    const module = loadLinuxTunModule();
    if (!module.LinuxTun) {
      throw new Error("Package '@xiaobaidadada/node-tuntap2-wintun' did not export LinuxTun");
    }

    const tun = new module.LinuxTun();
    tun.mtu = config.sessionTemplate.mtu;
    tun.ipv4 = `${config.sessionTemplate.gatewayIpv4}/${config.sessionTemplate.tunnelPrefixLength}`;
    tun.isUp = true;

    const networkRuntime = new LinuxNetworkRuntime({
      interfaceName: tun.name,
      gatewayIpv4: config.sessionTemplate.gatewayIpv4,
      tunnelPrefixLength: config.sessionTemplate.tunnelPrefixLength,
      applySystemNetwork: config.dataPlane.tun.applySystemNetwork,
      enableIpForwarding: config.dataPlane.tun.enableIpForwarding,
      natMode: config.dataPlane.tun.nat.mode,
      egressInterface: config.dataPlane.tun.nat.egressInterface
    });

    if (config.dataPlane.tun.applySystemNetwork) {
      await networkRuntime.apply();
    }

    const runtime = new LinuxTunRuntime(config, tun, networkRuntime);
    runtime.attachTunHandlers();
    return runtime;
  }

  public describe(): string[] {
    const lines = [
      `mode=tun`,
      `tun.name=${this.tun.name}`,
      `tun.ipv4=${this.config.sessionTemplate.gatewayIpv4}/${this.config.sessionTemplate.tunnelPrefixLength}`,
      `tun.mtu=${this.config.sessionTemplate.mtu}`
    ];

    if (this.config.dataPlane.tun.applySystemNetwork) {
      for (const item of this.networkRuntime.describePlan()) {
        lines.push(`${item.reason}: ${item.command}`);
      }
    } else {
      lines.push("system-network=manual");
      for (const item of this.networkRuntime.describePlan()) {
        lines.push(`planned: ${item.reason}: ${item.command}`);
      }
    }

    return lines;
  }

  public createSession(sessionId: string, assignedTunnelIpv4: string): LinuxTunPacketSession {
    const existing = this.sessions.get(assignedTunnelIpv4);
    if (existing) {
      throw new Error(`Tunnel IPv4 '${assignedTunnelIpv4}' is already attached to another session`);
    }

    const session = new LinuxTunPacketSession(this, sessionId, assignedTunnelIpv4);
    this.sessions.set(assignedTunnelIpv4, session);
    return session;
  }

  public injectClientPacket(session: LinuxTunPacketSession, packet: Buffer): boolean {
    if (this.closed) {
      return false;
    }

    if (!isIpv4Packet(packet)) {
      return false;
    }

    const sourceIpv4 = readIpv4FromPacket(packet, 12);
    if (sourceIpv4 !== session.assignedTunnelIpv4) {
      return false;
    }

    return this.tun.write(Buffer.from(packet));
  }

  public releaseSession(session: LinuxTunPacketSession): void {
    const current = this.sessions.get(session.assignedTunnelIpv4);
    if (current === session) {
      this.sessions.delete(session.assignedTunnelIpv4);
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const session of [...this.sessions.values()]) {
      await session.close();
    }

    await this.networkRuntime.cleanup().catch(() => undefined);
    await releaseTunDevice(this.tun).catch(() => undefined);
  }

  private attachTunHandlers(): void {
    this.tun.on("data", (packet: Buffer) => {
      if (!isIpv4Packet(packet)) {
        return;
      }

      const destinationIpv4 = readIpv4FromPacket(packet, 16);
      const session = this.sessions.get(destinationIpv4);
      if (!session) {
        return;
      }

      session.receiveFromTun(packet);
    });
  }
}

class LinuxTunPacketSession extends EventEmitter<{
  packet: [Buffer];
  stats: [SessionPacketStats];
}> implements PacketSession {
  private readonly runtime: LinuxTunRuntime;
  private readonly sessionId: string;
  public readonly assignedTunnelIpv4: string;
  private packetTx = 0;
  private packetRx = 0;
  private closed = false;

  public constructor(runtime: LinuxTunRuntime, sessionId: string, assignedTunnelIpv4: string) {
    super();
    this.runtime = runtime;
    this.sessionId = sessionId;
    this.assignedTunnelIpv4 = assignedTunnelIpv4;
  }

  public handleClientPacket(packet: Uint8Array): void {
    if (this.closed) {
      return;
    }

    const buffer = Buffer.from(packet);
    const accepted = this.runtime.injectClientPacket(this, buffer);
    if (!accepted) {
      return;
    }

    this.packetRx += 1;
    this.emit("stats", this.getStats());
  }

  public receiveFromTun(packet: Uint8Array): void {
    if (this.closed) {
      return;
    }

    this.packetTx += 1;
    this.emit("packet", Buffer.from(packet));
    this.emit("stats", this.getStats());
  }

  public getStats(): SessionPacketStats {
    return {
      sessionPacketsTx: this.packetTx,
      sessionPacketsRx: this.packetRx
    };
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.runtime.releaseSession(this);
  }
}

function loadLinuxTunModule(): LinuxTunModule {
  try {
    return require("@xiaobaidadada/node-tuntap2-wintun") as LinuxTunModule;
  } catch (error) {
    throw new Error(
      `Failed to load '@xiaobaidadada/node-tuntap2-wintun' for Linux TUN: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function releaseTunDevice(tun: LinuxTunDevice): Promise<void> {
  await new Promise<void>((resolve) => {
    tun.release(() => resolve());
  });
}
