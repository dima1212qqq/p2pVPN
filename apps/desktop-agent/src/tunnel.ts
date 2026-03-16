import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import type { SessionConfigMessage } from "@p2pvpn/protocol";

import type { TransportNetworkContext } from "./network-types.js";
import { WintunTunnelAdapter } from "./wintun.js";

export interface TunnelEvent {
  type: "started" | "packet-outbound" | "packet-inbound" | "stopped";
  message: string;
  packetBytes?: number;
}

export interface TunnelAdapter extends EventEmitter<{
  packet: [Buffer];
  event: [TunnelEvent];
}> {
  readonly kind: string;
  start(config: SessionConfigMessage): Promise<void>;
  injectInbound(packet: Uint8Array): void;
  close(): Promise<void>;
  whenIdle(): Promise<void>;
}

export interface TunnelAdapterFactoryOptions {
  wintunAdapterName?: string;
  wintunDllPath?: string;
  applyRoutes?: boolean;
  networkContext?: TransportNetworkContext;
}

export class NullTunnelAdapter extends EventEmitter<{
  packet: [Buffer];
  event: [TunnelEvent];
}> implements TunnelAdapter {
  public readonly kind = "none";

  public async start(_config: SessionConfigMessage): Promise<void> {
    this.emit("event", {
      type: "started",
      message: "Tunnel adapter is disabled; control plane only"
    });
  }

  public injectInbound(packet: Uint8Array): void {
    this.emit("event", {
      type: "packet-inbound",
      packetBytes: packet.byteLength,
      message: `Discarded inbound packet (${packet.byteLength} bytes) because no tunnel adapter is attached`
    });
  }

  public async close(): Promise<void> {
    this.emit("event", {
      type: "stopped",
      message: "Tunnel adapter stopped"
    });
  }

  public async whenIdle(): Promise<void> {
    return undefined;
  }
}

export class DevLoopbackTunnelAdapter extends EventEmitter<{
  packet: [Buffer];
  event: [TunnelEvent];
}> implements TunnelAdapter {
  public readonly kind = "dev-loopback";
  private closed = false;
  private readonly inflightTasks = new Set<Promise<void>>();

  public async start(config: SessionConfigMessage): Promise<void> {
    this.emit("event", {
      type: "started",
      message: `Dev loopback tunnel started for ${config.assignedTunnelIpv4} -> ${config.gatewayIpv4}`
    });

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const task = this.scheduleSyntheticPacket(sequence, config);
      this.inflightTasks.add(task);
      void task.finally(() => this.inflightTasks.delete(task));
    }
  }

  public injectInbound(packet: Uint8Array): void {
    if (this.closed) {
      return;
    }

    this.emit("event", {
      type: "packet-inbound",
      packetBytes: packet.byteLength,
      message: `Received packet from remote (${packet.byteLength} bytes)`
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.whenIdle();
    this.emit("event", {
      type: "stopped",
      message: "Dev loopback tunnel stopped"
    });
  }

  public async whenIdle(): Promise<void> {
    if (this.inflightTasks.size === 0) {
      return;
    }

    await Promise.allSettled([...this.inflightTasks]);
    await delay(125);
  }

  private async scheduleSyntheticPacket(sequence: number, config: SessionConfigMessage): Promise<void> {
    await delay(sequence * 350);

    if (this.closed) {
      return;
    }

    const packet = createSyntheticIpv4Packet(sequence, config.assignedTunnelIpv4, config.gatewayIpv4);
    this.emit("packet", packet);
    this.emit("event", {
      type: "packet-outbound",
      packetBytes: packet.byteLength,
      message: `Generated synthetic dev packet #${sequence} (${packet.byteLength} bytes)`
    });
  }
}

export function createTunnelAdapter(
  mode: "none" | "dev-loopback" | "wintun",
  options: TunnelAdapterFactoryOptions = {}
): TunnelAdapter {
  if (mode === "dev-loopback") {
    return new DevLoopbackTunnelAdapter();
  }

  if (mode === "wintun") {
    return new WintunTunnelAdapter({
      adapterName: options.wintunAdapterName ?? "p2pvpn",
      dllPath: options.wintunDllPath,
      applyRoutes: options.applyRoutes ?? false,
      networkContext: options.networkContext
    });
  }

  return new NullTunnelAdapter();
}

function createSyntheticIpv4Packet(sequence: number, sourceIpv4: string, destinationIpv4: string): Buffer {
  const payload = Buffer.from(`p2pvpn-dev-${sequence}`, "utf8");
  const totalLength = 20 + payload.byteLength;
  const buffer = Buffer.alloc(totalLength);

  buffer[0] = 0x45;
  buffer[1] = 0x00;
  buffer.writeUInt16BE(totalLength, 2);
  buffer.writeUInt16BE(sequence & 0xffff, 4);
  buffer.writeUInt16BE(0x0000, 6);
  buffer[8] = 64;
  buffer[9] = 253;
  writeIpv4(buffer, 12, sourceIpv4);
  writeIpv4(buffer, 16, destinationIpv4);
  buffer.writeUInt16BE(ipv4HeaderChecksum(buffer.subarray(0, 20)), 10);
  payload.copy(buffer, 20);
  return buffer;
}

function writeIpv4(buffer: Buffer, offset: number, value: string): void {
  const octets = value.split(".").map((octet) => Number.parseInt(octet, 10));

  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new Error(`Invalid IPv4 address '${value}'`);
  }

  for (let index = 0; index < 4; index += 1) {
    buffer[offset + index] = octets[index]!;
  }
}

function ipv4HeaderChecksum(header: Buffer): number {
  let sum = 0;

  for (let index = 0; index < header.byteLength; index += 2) {
    if (index === 10) {
      continue;
    }

    sum += header.readUInt16BE(index);
    while (sum > 0xffff) {
      sum = (sum & 0xffff) + (sum >>> 16);
    }
  }

  return (~sum) & 0xffff;
}
