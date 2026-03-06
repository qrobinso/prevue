import dgram from 'node:dgram';
import os from 'node:os';

export interface DiscoveredServer {
  id: string;
  name: string;
  address: string;
}

/** Probe a single URL via Jellyfin's unauthenticated public info endpoint */
async function httpProbe(baseUrl: string): Promise<DiscoveredServer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${baseUrl}/System/Info/Public`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    return {
      id: (data.Id as string) || '',
      name: (data.ServerName as string) || 'Jellyfin Server',
      address: baseUrl,
    };
  } catch {
    return null;
  }
}

/** Get local IPv4 subnet prefixes (e.g. ["192.168.1."]) */
function getLocalSubnets(): { prefix: string; ownIp: string }[] {
  const interfaces = os.networkInterfaces();
  const subnets: { prefix: string; ownIp: string }[] = [];
  const seenPrefixes = new Set<string>();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
        if (!seenPrefixes.has(prefix)) {
          seenPrefixes.add(prefix);
          subnets.push({ prefix, ownIp: addr.address });
        }
      }
    }
  }
  return subnets;
}

/** Run UDP broadcast discovery (Jellyfin native protocol on port 7359) */
export function udpDiscover(): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const found: DiscoveredServer[] = [];
    const seen = new Set<string>();

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const message = Buffer.from('Who is JellyfinServer?');

    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        const key = data.Id || data.Address;
        if (data.Address && !seen.has(key)) {
          seen.add(key);
          found.push({
            id: data.Id || '',
            name: data.Name || 'Jellyfin Server',
            address: data.Address,
          });
        }
      } catch { /* ignore */ }
    });

    socket.on('error', () => {
      try { socket.close(); } catch { /* ignore */ }
      resolve(found);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(message, 0, message.length, 7359, '255.255.255.255');
    });

    setTimeout(() => {
      try { socket.close(); } catch { /* ignore */ }
      resolve(found);
    }, 3000);
  });
}

/** Run HTTP-based discovery by probing known IPs on Jellyfin default ports */
export async function httpDiscover(): Promise<DiscoveredServer[]> {
  const PORTS = [8096, 8920];
  const probes: Promise<DiscoveredServer | null>[] = [];

  // Always probe localhost
  for (const port of PORTS) {
    probes.push(httpProbe(`http://localhost:${port}`));
    probes.push(httpProbe(`http://127.0.0.1:${port}`));
  }

  // Probe all IPs on local subnets
  const subnets = getLocalSubnets();
  for (const { prefix } of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${prefix}${i}`;
      for (const port of PORTS) {
        probes.push(httpProbe(`http://${ip}:${port}`));
      }
    }
  }

  const results = await Promise.allSettled(probes);
  return results
    .filter((r): r is PromiseFulfilledResult<DiscoveredServer> =>
      r.status === 'fulfilled' && r.value !== null
    )
    .map(r => r.value);
}
