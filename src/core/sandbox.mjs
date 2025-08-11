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
    const toolDir = path.dirname(path.join(this.sandboxDir, entry));
    const toolRel = path.relative(this.sandboxDir, toolDir);
    const pyReq = path.join(toolDir, 'requirements.txt');
    const hasPyReq = await fs.pathExists(pyReq);
    const nodePkg = path.join(toolDir, 'package.json');
    const hasNodePkg = await fs.pathExists(nodePkg);
    const envVars = {};

    const docker = await this.hasDocker();
    if (docker) {
      const image = language === 'python' ? 'python:3.11-alpine' : 'node:20-alpine';
      const cmd = language === 'python' ? ['python', entry, ...args] : ['node', entry, ...args];
      const argsDocker = ['run', '--rm', '-i',
        '-v', `${this.sandboxDir}:/app`, '-w', '/app',
        '--memory', `${this.limits.memoryMb}m`, '--cpus', `${this.limits.cpu}`
      ];
      if (this.limits.network === false) argsDocker.push('--network', 'none');
      // Optional dependency install
      if (this.limits.network !== false) {
        if (language === 'python' && hasPyReq) {
          // install to a local site-packages directory inside the toolDir
          const site = path.posix.join('/app', toolRel, '.site');
          const req = path.posix.join('/app', toolRel, 'requirements.txt');
          await this._spawnWithLogs({ command: 'docker', args: [...argsDocker, image, 'sh', '-lc', `python -m pip install --no-cache-dir -t ${site} -r ${req}`], stdin: '', logFile, cwd: this.sandboxDir, onStdout, onStderr });
          envVars['PYTHONPATH'] = site;
        }
        if (language === 'node' && hasNodePkg) {
          await this._spawnWithLogs({ command: 'docker', args: [...argsDocker, image, 'sh', '-lc', `cd ${path.posix.join('/app', toolRel)} && npm install --omit=dev`], stdin: '', logFile, cwd: this.sandboxDir, onStdout, onStderr });
        }
      }
      const envArgs = Object.entries(envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return await this._spawnWithLogs({ command: 'docker', args: [...argsDocker, ...envArgs, image, ...cmd], stdin, logFile, cwd: this.sandboxDir, onStdout, onStderr });
    }
    // Fallback local execution confined to sandbox cwd
    const command = language === 'python' ? 'python3' : 'node';
    const execArgs = language === 'python' ? [entry, ...args] : [entry, ...args];
    // Local optional dependency install
    if (this.limits.network !== false) {
      if (language === 'python' && hasPyReq) {
        const site = path.join(toolDir, '.site');
        await this._spawnWithLogs({ command: 'sh', args: ['-lc', `python3 -m pip install --no-cache-dir -t ${site} -r ${pyReq}`], stdin: '', logFile, cwd: this.sandboxDir, onStdout, onStderr });
        envVars['PYTHONPATH'] = site;
      }
      if (language === 'node' && hasNodePkg) {
        await this._spawnWithLogs({ command: 'sh', args: ['-lc', `cd ${toolDir} && npm install --omit=dev`], stdin: '', logFile, cwd: this.sandboxDir, onStdout, onStderr });
      }
    }
    return await this._spawnWithLogs({ command, args: execArgs, stdin, logFile, cwd: this.sandboxDir, onStdout, onStderr, env: envVars });
  }

  async _spawnWithLogs({ command, args, stdin, logFile, cwd, onStdout, onStderr, env }) {
    return await new Promise((resolve) => {
      const out = fs.createWriteStream(logFile, { flags: 'a' });
      const p = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
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
