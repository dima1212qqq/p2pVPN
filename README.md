# p2pvpn

Monorepo for a Holepunch-based VPN prototype with:

- `apps/exit-gateway`: the server that accepts `hyperdht` and WebSocket fallback sessions
- `apps/desktop-agent`: the desktop-side control-plane agent
- `apps/desktop-ui`: a minimal Electron shell for the agent
- `packages/*`: shared protocol, manifest and identity utilities

## Current scope

This repository contains the first vertical slice of the control plane:

- `hyperdht` primary transport
- WebSocket fallback transport
- client identity generation and allowlist-based authentication
- shared manifest format describing servers and bootstrap nodes
- minimal Electron UI that can launch the desktop agent
- mixed control/data framing with binary `PACKET` frames
- multi-server ordering with last-used preference and failover

The repository now includes two server-side data-plane paths:

- `dev-loopback` for local packet transport verification on a development machine
- Linux `tun` for Ubuntu/VPS deployment

The desktop side still uses `dev-loopback` locally until the real `Wintun` session takeover is finished.

Current data-plane modes:

- default `connect`: control plane only, negotiates `dataPlaneMode: "none"`
- `--dev-tunnel`: enables the synthetic packet loopback mode for local verification
- `--wintun`: requests native `tun` mode and currently fails unless the server advertises `tun`
- server `dataPlane.mode: "tun"`: enables Linux TUN, packet injection into the kernel, and optional `ip_forward + iptables MASQUERADE`
- `--apply-routes`: on Windows, installs host-routes for control-plane endpoints, points DNS at the tunnel adapter, and moves the default IPv4 route into `Wintun`

## Install

```bash
npm install
npm run build
```

## Generate server config

Production-style Ubuntu config:

```bash
npm --workspace @p2pvpn/exit-gateway run dev -- init-server --config ./config/generated/server.json --allowlist ./config/generated/authorized-clients.json
```

Local Windows dev config with the old synthetic tunnel:

```bash
npm --workspace @p2pvpn/exit-gateway run dev -- init-server --config ./config/generated/server.local-dev.json --allowlist ./config/generated/authorized-clients.local-dev.json --data-plane dev-loopback
```

This generates:

- `server.json` with a fresh `hyperdht` transport keypair
- `authorized-clients.json` with an empty allowlist
- by default, new server configs use `dataPlane.mode: "tun"` with Linux NAT/forwarding settings

## Generate client identity

```bash
npm --workspace @p2pvpn/desktop-agent run dev -- init-identity --identity ./config/generated/client-identity.json --name "My Laptop"
npm --workspace @p2pvpn/desktop-agent run dev -- export-public --identity ./config/generated/client-identity.json
```

Copy the exported JSON object into `authorized-clients.json`.

## Create a manifest

Create `./config/generated/network.manifest.json` based on the generated server config:

```json
{
  "version": 1,
  "networkName": "p2pvpn-dev",
  "generatedAt": "2026-03-16T00:00:00.000Z",
  "updateUrl": "https://example.com/p2pvpn/network.hyperdht-only.manifest.json",
  "trustKeyUrl": "https://example.com/p2pvpn/manifest-signing-public-key.pem",
  "bootstrap": [
    "88.99.3.86@node1.hyperdht.org:49737",
    "142.93.90.113@node2.hyperdht.org:49737",
    "138.68.147.8@node3.hyperdht.org:49737"
  ],
  "servers": [
    {
      "id": "pl-dev-1",
      "displayName": "Poland Dev Exit",
      "country": "PL",
      "city": "Warsaw",
      "enabled": true,
      "weight": 100,
      "hyperdhtPublicKey": "REPLACE_WITH_SERVER_PUBLIC_KEY_HEX",
      "wsEndpoints": [
        "ws://127.0.0.1:8080/tunnel"
      ],
      "dnsServers": [
        "1.1.1.1",
        "9.9.9.9"
      ],
      "mtu": 1380
    }
  ]
}
```

If the manifest contains multiple enabled servers and the client is started without `--server`, the desktop agent now:

- prefers the last successfully connected server for this device
- otherwise picks the highest-weight enabled server
- fails over to the next enabled server when the preferred one is unavailable

## Optional: sign a manifest

Generate a signing keypair:

```bash
node ./packages/config-manifest/dist/cli.js init-signing-key --public ./config/generated/manifest-signing-public-key.pem --private ./config/generated/manifest-signing-private-key.pem
```

Sign a manifest:

```bash
node ./packages/config-manifest/dist/cli.js sign --manifest ./config/generated/network.hyperdht-only.manifest.json --private ./config/generated/manifest-signing-private-key.pem
```

Verify a manifest:

```bash
node ./packages/config-manifest/dist/cli.js verify --manifest ./config/generated/network.hyperdht-only.manifest.json --public ./config/generated/manifest-signing-public-key.pem
```

The packaged desktop client keeps a local manifest copy in `userData`, downloads `updateUrl`, verifies the signature, and replaces the local copy only if the downloaded manifest is newer and valid.

Trust bootstrap for packaged clients now works like this:

- if a pinned `manifest-signing-public-key.pem` already exists in `userData`, the client trusts only that key
- otherwise it tries the bundled `manifest-signing-public-key.pem`
- if the bundled key does not verify the downloaded manifest, the client fetches `trustKeyUrl` (or `manifest-signing-public-key.pem` next to `updateUrl`) and pins that key locally on first success

This makes the manifest itself publicly downloadable for any new client build while still pinning the signing key after the first successful bootstrap.

## Run the server

```bash
npm --workspace @p2pvpn/exit-gateway run dev -- run --config ./config/generated/server.json --allowlist ./config/generated/authorized-clients.json
```

For Linux `tun` mode, run this on Ubuntu as `root` or with `CAP_NET_ADMIN`. The server will:

- create a Linux TUN device
- assign `${gatewayIpv4}/${tunnelPrefixLength}` to it
- optionally enable `net.ipv4.ip_forward=1`
- optionally install `iptables` forwarding/NAT rules

For local Windows development, keep using the existing `config/generated/server.json` if it is still on `dev-loopback`.

## Connect from the desktop agent

```bash
npm --workspace @p2pvpn/desktop-agent run dev -- connect --manifest ./config/generated/network.manifest.json --identity ./config/generated/client-identity.json --server pl-dev-1
```

Omit `--server` to let the client auto-select and fail over across all enabled manifest servers.

## Verify packet transport locally

Run the server and then start the agent with the development tunnel adapter:

```bash
npm --workspace @p2pvpn/desktop-agent run dev -- connect --manifest ./config/generated/network.manifest.json --identity ./config/generated/client-identity.json --server pl-dev-1 --json-events --once --dev-tunnel
```

Expected output now includes:

- `connected` with `dataPlaneMode: "dev-loopback"`
- `tunnel-packet-outbound`
- `tunnel-packet-inbound`
- `stats` with `sessionPacketsTx/sessionPacketsRx`

To force `hyperdht` instead of the `ws` fallback, use `network.hyperdht-only.manifest.json`.

## Check Windows Wintun prerequisites

Before wiring a real Windows data plane, you can validate the local Wintun runtime:

```bash
npm --workspace @p2pvpn/desktop-agent run dev -- doctor-wintun
```

Expected output includes:

- detected `platform` and `arch`
- resolved `wintun` DLL path
- whether the current shell is running as Windows Administrator
- `initResult=1` when the addon and DLL load successfully

Running `connect --wintun` from a non-elevated shell now fails fast with a clear error instead of a misleading addon return code.
If the server still advertises `dev-loopback`, `connect --wintun` will now fail with `UNSUPPORTED_DATA_PLANE` instead of pretending that a real tunnel session exists.
When the server advertises real `tun`, the Windows agent can now prepare a route plan that keeps `ws`/`hyperdht` control-plane endpoints reachable outside the tunnel before installing the default route.

## Launch the Electron shell

```bash
npm --workspace @p2pvpn/desktop-ui run dev
```
