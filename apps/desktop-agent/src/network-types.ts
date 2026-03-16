export interface RouteBypassTarget {
  ip: string;
  reason: string;
}

export interface TransportNetworkContext {
  transportName: "hyperdht" | "ws";
  bypassTargets: RouteBypassTarget[];
}
