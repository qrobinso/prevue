const { spawn } = require('child_process');
const path = require('path');

const isWindows = process.platform === 'win32';
const root = path.resolve(__dirname, '..');

const child = spawn(
  'npx',
  ['concurrently', '"npm run dev:server"', '"npm run dev:client"'],
  {
    stdio: 'inherit',
    shell: true,
    cwd: root,
    ...(isWindows ? {} : { detached: true })
  }
);

function cleanup() {
  if (child.pid) {
    if (isWindows) {
      spawn('taskkill', ['/T', '/F', '/PID', child.pid.toString()], {
        stdio: 'ignore',
        shell: true
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
child.on('exit', (code) => process.exit(code ?? 0));
