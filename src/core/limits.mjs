import os from 'os';

export function getHardwareDefaults() {
  const totalMemMb = Math.floor(os.totalmem() / 1024 / 1024);
  const cpuCount = os.cpus()?.length || 1;
  const memoryMb = Math.max(2048, Math.floor(totalMemMb * 0.85));
  const cpu = Math.max(1, cpuCount);
  return { memoryMb, cpu: String(cpu) };
}

export function parseEnvBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function getDefaultLimits() {
  const hardware = getHardwareDefaults();
  return {
    maxTokens: 8192,
    contextWindow: 20000,
    timeoutMs: parseInt(process.env.SANDBOX_TIMEOUT_MS || '60000', 10),
    memoryMb: parseInt(process.env.SANDBOX_MEMORY_MB || String(hardware.memoryMb), 10),
    cpu: process.env.SANDBOX_CPU || hardware.cpu,
    network: parseEnvBoolean(process.env.SANDBOX_NETWORK, true),
  };
}
