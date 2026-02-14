const { execSync, spawnSync } = require('child_process');

const DEFAULT_PORTS = [3080, 5173, 5174, 5175];

function parsePorts(argv) {
  const parsed = argv
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
  return parsed.length > 0 ? parsed : DEFAULT_PORTS;
}

function findListeningPidsWindows(targetPorts) {
  const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  const pids = new Set();
  const ports = new Set(targetPorts);

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const port = parseInt(match[1], 10);
    const pid = parseInt(match[2], 10);
    if (ports.has(port) && Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return Array.from(pids);
}

function findListeningPidsUnix(targetPorts) {
  const pids = new Set();

  for (const port of targetPorts) {
    try {
      const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' });
      for (const raw of output.split(/\r?\n/)) {
        const pid = parseInt(raw.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          pids.add(pid);
        }
      }
    } catch {
      // No listener on this port or lsof unavailable.
    }
  }

  return Array.from(pids);
}

function killPidWindows(pid) {
  const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'pipe' });
  return result.status === 0;
}

function killPidUnix(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

function main() {
  const targetPorts = parsePorts(process.argv.slice(2));
  const findPids = process.platform === 'win32' ? findListeningPidsWindows : findListeningPidsUnix;
  const killPid = process.platform === 'win32' ? killPidWindows : killPidUnix;

  const pids = findPids(targetPorts);

  if (pids.length === 0) {
    console.log(`No listening processes found on ports: ${targetPorts.join(', ')}`);
    return;
  }

  console.log(`Found ${pids.length} process(es) on ports ${targetPorts.join(', ')}: ${pids.join(', ')}`);
  const killed = [];

  for (const pid of pids) {
    if (killPid(pid)) {
      killed.push(pid);
    }
  }

  if (killed.length === 0) {
    console.log('No processes were terminated.');
  } else {
    console.log(`Stopped process(es): ${killed.join(', ')}`);
  }
}

main();
