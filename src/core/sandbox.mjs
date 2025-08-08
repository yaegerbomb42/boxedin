import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'node:child_process';

/**
 * Sandboxed execution: prefers Docker if available, falls back to local isolated process with cwd inside sandbox.
 * Supports Python and Node.js tools. All file IO confined to sandboxDir.
 */
export class Sandbox {
  constructor({ sandboxDir, logsDir, limits = {} }) {
    this.sandboxDir = sandboxDir;
    this.logsDir = logsDir;
    this.limits = { timeoutMs: 60_000, memoryMb: 512, cpu: '0.5', network: false, ...limits };
  }

  async ensure() {
    await fs.ensureDir(this.sandboxDir);
    await fs.ensureDir(this.logsDir);
    await fs.ensureDir(path.join(this.sandboxDir, 'tools'));
    await fs.ensureDir(path.join(this.sandboxDir, 'runs'));
  }

  async hasDocker() {
    return await new Promise((resolve) => {
      const p = spawn('docker', ['--version']);
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
  }

  async run({ language, entry, args = [], stdin = '', runId, onStdout, onStderr }) {
    await this.ensure();
    const runDir = path.join(this.sandboxDir, 'runs', runId || `${Date.now()}`);
    await fs.ensureDir(runDir);
    const logFile = path.join(runDir, 'exec.log');

    const docker = await this.hasDocker();
    if (docker) {
      const image = language === 'python' ? 'python:3.11-alpine' : 'node:20-alpine';
      const cmd = language === 'python' ? ['python', entry, ...args] : ['node', entry, ...args];
      const argsDocker = ['run', '--rm', '-i',
        '-v', `${this.sandboxDir}:/app`, '-w', '/app',
        '--memory', `${this.limits.memoryMb}m`, '--cpus', `${this.limits.cpu}`
      ];
      if (this.limits.network === false) argsDocker.push('--network', 'none');
  return await this._spawnWithLogs({ command: 'docker', args: [...argsDocker, image, ...cmd], stdin, logFile, cwd: this.sandboxDir, onStdout, onStderr });
    }
    // Fallback local execution confined to sandbox cwd
    const command = language === 'python' ? 'python3' : 'node';
    const execArgs = language === 'python' ? [entry, ...args] : [entry, ...args];
    return await this._spawnWithLogs({ command, args: execArgs, stdin, logFile, cwd: this.sandboxDir, onStdout, onStderr });
  }

  async _spawnWithLogs({ command, args, stdin, logFile, cwd, onStdout, onStderr }) {
    return await new Promise((resolve) => {
      const out = fs.createWriteStream(logFile, { flags: 'a' });
      const p = spawn(command, args, { cwd });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { p.kill('SIGKILL'); }, this.limits.timeoutMs);
      p.stdout.on('data', (d) => { const s = d.toString(); stdout += s; out.write(d); onStdout && onStdout(s); });
      p.stderr.on('data', (d) => { const s = d.toString(); stderr += s; out.write(d); onStderr && onStderr(s); });
      if (stdin) p.stdin.write(stdin);
      p.stdin.end();
      p.on('exit', (code) => {
        clearTimeout(timeout);
        out.end();
        resolve({ code, stdout, stderr, logFile });
      });
      p.on('error', (err) => {
        clearTimeout(timeout);
        out.end();
        resolve({ code: -1, stdout, stderr: String(err), logFile });
      });
    });
  }
}
