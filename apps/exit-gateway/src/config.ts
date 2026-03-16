import { readFile, writeFile } from "node:fs/promises";

import b4a from "b4a";
import DHT from "hyperdht";

import { DEFAULT_PUBLIC_BOOTSTRAP } from "@p2pvpn/config-manifest";

export interface ServerConfig {
  version: 1;
  serverId: string;
  displayName: string;
  country: string;
  city?: string;
  bootstrap: string[];
  dht: {
    host?: string;
    port?: number;
  };
  transportKeyPair: {
    publicKeyHex: string;
    secretKeyHex: string;
  };
  websocket: {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
    tls: {
      enabled: boolean;
      certPath?: string;
      keyPath?: string;
    };
  };
  auth: {
    mode: "allowlist" | "ticket";
    ticket: {
      issuerPublicKeyPem?: string;
      expectedNetworkName: string;
      maxClockSkewSeconds: number;
    };
  };
  dataPlane: {
    mode: "none" | "dev-loopback" | "tun";
    tun: {
      applySystemNetwork: boolean;
      enableIpForwarding: boolean;
      nat: {
        mode: "none" | "iptables-masquerade";
        egressInterface?: string;
      };
    };
  };
  sessionTemplate: {
    addressPoolPrefix: string;
    tunnelPrefixLength: number;
    gatewayIpv4: string;
    dnsServers: string[];
    mtu: number;
  };
}

export function generateServerConfig(serverId = "pl-dev-1"): ServerConfig {
  const keyPair = DHT.keyPair();

  return {
    version: 1,
    serverId,
    displayName: "Poland Dev Exit",
    country: "PL",
    city: "Warsaw",
    bootstrap: [...DEFAULT_PUBLIC_BOOTSTRAP],
    dht: {},
    transportKeyPair: {
      publicKeyHex: b4a.toString(keyPair.publicKey, "hex"),
      secretKeyHex: b4a.toString(keyPair.secretKey, "hex")
    },
    websocket: {
      enabled: true,
      host: "0.0.0.0",
      port: 8080,
      path: "/tunnel",
      tls: {
        enabled: false
      }
    },
    auth: {
      mode: "allowlist",
      ticket: {
        expectedNetworkName: "p2pvpn-dev",
        maxClockSkewSeconds: 5 * 60
      }
    },
    dataPlane: {
      mode: "tun",
      tun: {
        applySystemNetwork: true,
        enableIpForwarding: true,
        nat: {
          mode: "iptables-masquerade"
        }
      }
    },
    sessionTemplate: {
      addressPoolPrefix: "10.44.0",
      tunnelPrefixLength: 24,
      gatewayIpv4: "10.44.0.1",
      dnsServers: ["1.1.1.1", "9.9.9.9"],
      mtu: 1380
    }
  };
}

export async function saveServerConfig(path: string, config: ServerConfig): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadServerConfig(path: string): Promise<ServerConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ServerConfig;

  if (parsed.version !== 1) {
    throw new Error("Unsupported server config version");
  }

  parsed.dataPlane ??= {
    mode: "dev-loopback",
    tun: {
      applySystemNetwork: true,
      enableIpForwarding: true,
      nat: {
        mode: "iptables-masquerade"
      }
    }
  };
  parsed.auth ??= {
    mode: "allowlist",
    ticket: {
      expectedNetworkName: "p2pvpn-dev",
      maxClockSkewSeconds: 5 * 60
    }
  };
  parsed.auth.ticket ??= {
    expectedNetworkName: "p2pvpn-dev",
    maxClockSkewSeconds: 5 * 60
  };
  parsed.dataPlane.tun ??= {
    applySystemNetwork: true,
    enableIpForwarding: true,
    nat: {
      mode: "iptables-masquerade"
    }
  };
  parsed.dataPlane.tun.nat ??= {
    mode: "iptables-masquerade"
  };
  parsed.sessionTemplate.tunnelPrefixLength ??= 24;
  return parsed;
}
