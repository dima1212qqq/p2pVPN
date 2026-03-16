export const PROTOCOL_VERSION = 1;

export interface HelloMessage {
  type: "HELLO";
  protocolVersion: number;
  clientFingerprint: string;
  clientName: string;
  requestedServerId?: string;
  requestedDataPlaneMode?: "none" | "dev-loopback" | "tun";
  capabilities: string[];
}

export interface AuthChallengeMessage {
  type: "AUTH_CHALLENGE";
  sessionId: string;
  serverId: string;
  nonce: string;
  issuedAt: string;
}

export interface AuthResponseMessage {
  type: "AUTH_RESPONSE";
  sessionId: string;
  clientFingerprint: string;
  publicKeyPem: string;
  signature: string;
}

export interface SessionConfigMessage {
  type: "SESSION_CONFIG";
  sessionId: string;
  serverId: string;
  transport: "hyperdht" | "ws";
  dataPlaneMode: "none" | "dev-loopback" | "tun";
  assignedTunnelIpv4: string;
  tunnelPrefixLength: number;
  gatewayIpv4: string;
  dnsServers: string[];
  mtu: number;
  capabilities: string[];
  message: string;
}

export interface PingMessage {
  type: "PING";
  ts: number;
}

export interface PongMessage {
  type: "PONG";
  ts: number;
}

export interface StatsMessage {
  type: "STATS";
  activeSessions: number;
  serverUptimeSec: number;
  sessionPacketsTx?: number;
  sessionPacketsRx?: number;
}

export interface ErrorMessage {
  type: "ERROR";
  code: string;
  message: string;
}

export interface DisconnectMessage {
  type: "DISCONNECT";
  reason: string;
}

export type ProtocolMessage =
  | HelloMessage
  | AuthChallengeMessage
  | AuthResponseMessage
  | SessionConfigMessage
  | PingMessage
  | PongMessage
  | StatsMessage
  | ErrorMessage
  | DisconnectMessage;

export function isMessageType<TType extends ProtocolMessage["type"]>(
  message: ProtocolMessage,
  type: TType
): message is Extract<ProtocolMessage, { type: TType }> {
  return message.type === type;
}
