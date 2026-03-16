import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { SessionConfigMessage } from "@p2pvpn/protocol";

import type { TransportNetworkContext } from "./network-types.js";
import { assertWindowsAdmin } from "./windows-admin.js";
import { WindowsNetworkSession } from "./windows-network.js";
import type { TunnelAdapter, TunnelEvent } from "./tunnel.js";

const require = createRequire(import.meta.url);

interface LoadedWintunModule {
  Wintun?: {
    init: () => number;
    set_ipv4: (name: string, ip: string, mask: number, guid?: string) => number;
    on_data: (handler: (data: Buffer) => void) => number;
    close: () => number;
    send_data: (data: Buffer) => number;
    set_dll_path: (dllPath: string) => void;
    get_wintun_dll_path: () => string;
  };
}

export interface WintunAdapterOptions {
  adapterName: string;
  applyRoutes: boolean;
  dllPath?: string;
  networkContext?: TransportNetworkContext;
}

export class WintunTunnelAdapter extends EventEmitter<{
  packet: [Buffer];
  event: [TunnelEvent];
}> implements TunnelAdapter {
  public readonly kind = "wintun";
  private readonly options: WintunAdapterOptions;
  private wintun: NonNullable<LoadedWintunModule["Wintun"]> | null = null;
  private networkSession: WindowsNetworkSession | null = null;
  private closed = false;

  public constructor(options: WintunAdapterOptions) {
    super();
    this.options = options;
  }

  public async start(config: SessionConfigMessage): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Wintun tunnel mode is only supported on Windows");
    }

    this.wintun = await loadWintunAddon();

    const dllPath = resolve(this.options.dllPath ?? process.env.P2PVPN_WINTUN_DLL ?? this.wintun.get_wintun_dll_path());
    await access(dllPath);
    await assertWindowsAdmin("Wintun tunnel mode");

    this.emit("event", {
      type: "started",
      message: `Preparing Wintun adapter '${this.options.adapterName}' with DLL ${dllPath}`
    });

    this.wintun.set_dll_path(dllPath);

    const initResult = this.wintun.init();
    if (!isAddonSuccess(initResult)) {
      throw new Error(`Wintun.init() returned unexpected result ${String(initResult)}`);
    }

    const setIpv4Result = this.wintun.set_ipv4(this.options.adapterName, config.assignedTunnelIpv4, config.tunnelPrefixLength);
    if (!isAddonSuccess(setIpv4Result)) {
      throw new Error(`Wintun.set_ipv4() returned unexpected result ${String(setIpv4Result)}`);
    }

    this.networkSession = new WindowsNetworkSession(config, {
      adapterName: this.options.adapterName,
      applyRoutes: this.options.applyRoutes,
      bypassTargets: this.options.networkContext?.bypassTargets ?? []
    });

    if (this.options.applyRoutes) {
      this.emit("event", {
        type: "started",
        message: `Applying Windows route/DNS plan for adapter '${this.options.adapterName}'`
      });
      await this.networkSession.apply();
    }

    const onDataResult = this.wintun.on_data((data) => {
      if (this.closed) {
        return;
      }

      this.emit("packet", Buffer.from(data));
      this.emit("event", {
        type: "packet-outbound",
        packetBytes: data.byteLength,
        message: `Wintun captured packet from OS (${data.byteLength} bytes)`
      });
    });

    if (!isAddonSuccess(onDataResult)) {
      throw new Error(`Wintun.on_data() returned unexpected result ${String(onDataResult)}`);
    }

    if (!this.options.applyRoutes) {
      const planSummary = this.networkSession
        .describePlan()
        .map((item) => `${item.reason}: ${item.command}`)
        .join(" | ");

      this.emit("event", {
        type: "started",
        message: `Wintun adapter '${this.options.adapterName}' initialized without route takeover. Planned commands: ${planSummary}`
      });
    }
  }

  public injectInbound(packet: Uint8Array): void {
    if (this.closed || !this.wintun) {
      return;
    }

    const buffer = Buffer.from(packet);
    const result = this.wintun.send_data(buffer);
    if (!isAddonSuccess(result)) {
      this.emit("event", {
        type: "packet-inbound",
        packetBytes: buffer.byteLength,
        message: `Wintun.send_data() returned unexpected result ${String(result)} for inbound packet (${buffer.byteLength} bytes)`
      });
      return;
    }

    this.emit("event", {
      type: "packet-inbound",
      packetBytes: buffer.byteLength,
      message: `Injected remote packet into Wintun (${buffer.byteLength} bytes)`
    });
  }

  public async close(): Promise<void> {
    this.closed = true;

    if (this.networkSession) {
      await this.networkSession.cleanup().catch((error: unknown) => {
        this.emit("event", {
          type: "stopped",
          message: `Windows route cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
    }

    if (this.wintun) {
      const closeResult = this.wintun.close();
      if (!isAddonSuccess(closeResult)) {
        this.emit("event", {
          type: "stopped",
          message: `Wintun.close() returned unexpected result ${String(closeResult)}`
        });
      }
    }

    this.emit("event", {
      type: "stopped",
      message: `Wintun adapter '${this.options.adapterName}' stopped`
    });
  }

  public async whenIdle(): Promise<void> {
    return undefined;
  }
}

async function loadWintunAddon(): Promise<NonNullable<LoadedWintunModule["Wintun"]>> {
  try {
    const module = require("@xiaobaidadada/node-tuntap2-wintun") as LoadedWintunModule;
    if (!module.Wintun) {
      throw new Error("Package did not export Wintun");
    }

    return module.Wintun;
  } catch (error) {
    throw new Error(
      `Failed to load '@xiaobaidadada/node-tuntap2-wintun': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isAddonSuccess(value: unknown): boolean {
  return value === 1 || value === true;
}
