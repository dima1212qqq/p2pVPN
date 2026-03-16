export function isIpv4Packet(packet: Uint8Array): boolean {
  return packet.byteLength >= 20 && ((packet[0] ?? 0) >> 4) === 4;
}

export function readIpv4FromPacket(packet: Uint8Array, offset: number): string {
  if (packet.byteLength < offset + 4) {
    throw new Error(`Packet is too short to read IPv4 address at offset ${offset}`);
  }

  return [packet[offset], packet[offset + 1], packet[offset + 2], packet[offset + 3]].join(".");
}

export function ipv4ToInt(ipv4: string): number {
  const octets = parseIpv4(ipv4);
  return ((((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

export function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join(".");
}

export function networkCidrFromHost(ipv4: string, prefixLength: number): string {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`Invalid IPv4 prefix length '${prefixLength}'`);
  }

  const host = ipv4ToInt(ipv4);
  const mask = prefixLength === 0 ? 0 : ((0xffffffff << (32 - prefixLength)) >>> 0);
  const network = host & mask;
  return `${intToIpv4(network)}/${prefixLength}`;
}

function parseIpv4(ipv4: string): [number, number, number, number] {
  const octets = ipv4.split(".").map((segment) => Number.parseInt(segment, 10));

  if (
    octets.length !== 4 ||
    octets.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)
  ) {
    throw new Error(`Invalid IPv4 address '${ipv4}'`);
  }

  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}
