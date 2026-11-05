import { readFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import type { RunnerDiskMetrics, RunnerMetrics } from './remote-protocol';
import { runCommand } from './util';

/**
 * Host health sampling for a remote runner agent.
 *
 * Everything here is best effort: a command that is missing, a `/proc` file that does
 * not exist, or a platform without `df` must degrade to an empty/zero value instead of
 * failing the heartbeat. The payload carries no secrets, no prompts and no provider
 * credentials — only counters.
 *
 * Linux/macOS use `/proc`, `df -Pk`/`df -i`, `ps` and (macOS) `sysctl -n vm.swapusage`.
 * Windows has none of those: a single PowerShell/CIM script reports CPU load, memory,
 * logical disks, uptime and process count. Unsupported fields are omitted (load averages
 * do not exist on Windows) instead of being fabricated.
 */

const CPU_SAMPLE_MS = 200;
const COMMAND_TIMEOUT_MS = 5_000;
/** The control plane rejects a metrics sample with more than 32 mounts. */
const MAX_DISKS = 32;
const POWERSHELL = 'powershell.exe';

/** Pseudo filesystems that report meaningless capacity numbers. */
const PSEUDO_FILESYSTEMS =
  /^(devfs|map|none|proc|sysfs|devpts|cgroup2?|securityfs|pstore|bpf|tracefs|debugfs|mqueue|hugetlbfs|fusectl|configfs|ramfs|autofs|binfmt_misc|nsfs|tmpfs|devtmpfs|shm)$/;

interface CpuTimes {
  idle: number;
  total: number;
}

export interface DfLine {
  filesystem: string;
  mount: string;
  integers: number[];
  percents: number[];
}

interface DfEntry {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  free: number;
  percent?: number;
}

interface InodeEntry {
  mount: string;
  usedPercent: number;
}

interface SwapUsage {
  totalBytes: number;
  usedBytes: number;
}

/** The subset of host health the Windows CIM script reports. */
export interface WindowsMetricsSample {
  cpuPercent?: number;
  memoryTotalBytes?: number;
  memoryFreeBytes?: number;
  uptimeSeconds?: number;
  processCount?: number;
  disks: RunnerDiskMetrics[];
}

/**
 * Samples the host and returns a `RunnerMetrics` payload.
 *
 * `platform` is the enrolled platform mapped to `process.platform` (`win32`, `darwin`,
 * `linux`). CPU percentage is a delta over a short `os.cpus()` sample on POSIX and the
 * CIM `LoadPercentage` average on Windows; memory comes from `os` (and CIM on Windows);
 * swap and process count are best effort; disks are parsed from `df` or logical disks.
 * The function never throws.
 */
export async function collectMetrics(
  agentVersion: string,
  platform: NodeJS.Platform = process.platform,
): Promise<RunnerMetrics> {
  const capturedAt = new Date().toISOString();

  try {
    const metrics =
      platform === 'win32'
        ? await collectWindowsMetrics(capturedAt, agentVersion)
        : await collectPosixMetrics(capturedAt, agentVersion, platform);

    return metrics;
  } catch {
    // A metrics sample must never take the agent down.
    return emptyMetrics(capturedAt, agentVersion);
  }
}

export function emptyMetrics(capturedAt: string, agentVersion: string): RunnerMetrics {
  return {
    capturedAt,
    cpuPercent: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    memoryTotalBytes: 0,
    memoryUsedBytes: 0,
    memoryAvailableBytes: 0,
    memoryUsedPercent: 0,
    disks: [],
    agentVersion,
  };
}

/* -------------------------------------------------------------------------- */
/* POSIX (Linux / macOS)                                                      */
/* -------------------------------------------------------------------------- */

async function collectPosixMetrics(
  capturedAt: string,
  agentVersion: string,
  platform: NodeJS.Platform,
): Promise<RunnerMetrics> {
  const [cpuPercent, disks, swap, processCount] = await Promise.all([
    sampleCpuPercent(),
    collectDisks(),
    collectSwap(platform),
    collectProcessCount(),
  ]);

  const memoryTotal = totalmem();
  const memoryFree = freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  const [load1, load5, load15] = loadavg();

  const metrics: RunnerMetrics = {
    capturedAt,
    cpuPercent: round(cpuPercent, 1),
    load1: round(load1 ?? 0, 2),
    load5: round(load5 ?? 0, 2),
    load15: round(load15 ?? 0, 2),
    memoryTotalBytes: memoryTotal,
    memoryUsedBytes: memoryUsed,
    memoryAvailableBytes: memoryFree,
    memoryUsedPercent: memoryTotal > 0 ? round((memoryUsed / memoryTotal) * 100, 1) : 0,
    disks,
    uptimeSeconds: round(uptime(), 0),
    agentVersion,
  };

  if (swap) {
    metrics.swapTotalBytes = swap.totalBytes;
    metrics.swapUsedBytes = swap.usedBytes;
  }
  if (processCount !== undefined) metrics.processCount = processCount;

  return metrics;
}

/* -------------------------------------------------------------------------- */
/* Windows                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One PowerShell/CIM query per heartbeat: CPU load, memory, logical disks (fixed drives
 * only), uptime and process count, emitted as a single JSON object.
 */
const WINDOWS_METRICS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$cpu = (Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
  '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
  "$disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, Size, FreeSpace)",
  '$processes = @(Get-Process).Count',
  '[pscustomobject]@{',
  '  cpuPercent = $cpu',
  '  memoryTotalBytes = [int64]$os.TotalVisibleMemorySize * 1024',
  '  memoryFreeBytes = [int64]$os.FreePhysicalMemory * 1024',
  '  uptimeSeconds = [int64](((Get-Date) - $os.LastBootUpTime).TotalSeconds)',
  '  processCount = $processes',
  '  disks = $disks',
  '} | ConvertTo-Json -Compress -Depth 4',
].join('\n');

async function collectWindowsMetrics(
  capturedAt: string,
  agentVersion: string,
): Promise<RunnerMetrics> {
  const sample = await collectWindowsSample();

  // Node reports total/free memory on Windows too, so a missing CIM value still yields an
  // honest sample instead of a fabricated zero.
  const memoryTotal = sample.memoryTotalBytes ?? totalmem();
  const memoryFree = sample.memoryFreeBytes ?? freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);

  const metrics: RunnerMetrics = {
    capturedAt,
    cpuPercent: round(clamp(sample.cpuPercent ?? 0, 0, 100), 1),
    // Windows has no load-average counter; the wire contract requires numbers, and 0 is
    // the documented "not reported" value for this field on that platform.
    load1: 0,
    load5: 0,
    load15: 0,
    memoryTotalBytes: memoryTotal,
    memoryUsedBytes: memoryUsed,
    memoryAvailableBytes: memoryFree,
    memoryUsedPercent: memoryTotal > 0 ? round((memoryUsed / memoryTotal) * 100, 1) : 0,
    disks: sample.disks,
    uptimeSeconds: round(sample.uptimeSeconds ?? uptime(), 0),
    agentVersion,
  };

  if (sample.processCount !== undefined) metrics.processCount = sample.processCount;
  return metrics;
}

async function collectWindowsSample(): Promise<WindowsMetricsSample> {
  try {
    const result = await runCommand(
      [POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', WINDOWS_METRICS_SCRIPT],
      { timeoutMs: COMMAND_TIMEOUT_MS * 2 },
    );
    if (result.code !== 0) return { disks: [] };
    return parseWindowsMetricsJson(result.stdout) ?? { disks: [] };
  } catch {
    // PowerShell missing, blocked by policy or the query failed: degrade, do not fail.
    return { disks: [] };
  }
}

/**
 * Parses the `ConvertTo-Json` output of {@link WINDOWS_METRICS_SCRIPT}.
 *
 * Pure so Windows parsing is testable off a Windows host. A single object, an array of
 * one object and numeric strings (older PowerShell) are all accepted; a missing or
 * unparsable payload returns `undefined`.
 */
export function parseWindowsMetricsJson(text: string): WindowsMetricsSample | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }

  const record = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
  if (Object.keys(record).length === 0) return undefined;

  const disksValue = Array.isArray(record.disks)
    ? record.disks
    : record.disks === undefined || record.disks === null
      ? []
      : [record.disks];
  const disks = disksValue
    .map(parseWindowsDisk)
    .filter((disk): disk is RunnerDiskMetrics => disk !== undefined)
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, MAX_DISKS);

  const sample: WindowsMetricsSample = { disks };
  const cpuPercent = numberFrom(record.cpuPercent);
  if (cpuPercent !== undefined) sample.cpuPercent = clamp(cpuPercent, 0, 100);
  const memoryTotalBytes = numberFrom(record.memoryTotalBytes);
  if (memoryTotalBytes !== undefined && memoryTotalBytes > 0) {
    sample.memoryTotalBytes = memoryTotalBytes;
    // A free value without a total is a failed CIM query (PowerShell casts `$null` to 0),
    // so it is omitted rather than reported as "0 bytes free".
    const memoryFreeBytes = numberFrom(record.memoryFreeBytes);
    if (memoryFreeBytes !== undefined && memoryFreeBytes >= 0) {
      sample.memoryFreeBytes = Math.min(memoryFreeBytes, memoryTotalBytes);
    }
  }
  const uptimeSeconds = numberFrom(record.uptimeSeconds);
  if (uptimeSeconds !== undefined && uptimeSeconds > 0) sample.uptimeSeconds = uptimeSeconds;
  const processCount = numberFrom(record.processCount);
  if (processCount !== undefined && processCount > 0) {
    sample.processCount = Math.trunc(processCount);
  }
  return sample;
}

/** Maps one `Win32_LogicalDisk` row (`DeviceID`/`Size`/`FreeSpace`) to disk metrics. */
function parseWindowsDisk(value: unknown): RunnerDiskMetrics | undefined {
  const record = asRecord(value);
  const mount = typeof record.DeviceID === 'string' ? record.DeviceID.trim() : '';
  const totalBytes = numberFrom(record.Size);
  if (mount === '' || totalBytes === undefined || totalBytes <= 0) return undefined;

  const freeBytes = Math.max(0, numberFrom(record.FreeSpace) ?? 0);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    mount: mount.slice(0, 255),
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: round((usedBytes / totalBytes) * 100, 1),
  };
}

/* -------------------------------------------------------------------------- */
/* CPU                                                                        */
/* -------------------------------------------------------------------------- */

function readCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus() ?? []) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** CPU percent over a short sample window. Returns 0 when the counters did not move. */
async function sampleCpuPercent(): Promise<number> {
  const before = readCpuTimes();
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
  const after = readCpuTimes();

  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (!(totalDelta > 0)) return 0;

  const busy = Math.max(0, totalDelta - idleDelta);
  return clamp((busy / totalDelta) * 100, 0, 100);
}

/* -------------------------------------------------------------------------- */
/* Memory / swap                                                              */
/* -------------------------------------------------------------------------- */

async function collectSwap(platform: NodeJS.Platform): Promise<SwapUsage | undefined> {
  if (platform === 'linux') return collectLinuxSwap();
  if (platform === 'darwin') return collectMacosSwap();
  // Windows page-file counters are not part of the current wire contract.
  return undefined;
}

/** Reads `/proc/meminfo` on Linux. */
async function collectLinuxSwap(): Promise<SwapUsage | undefined> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const values = new Map<string, number>();
    for (const line of text.split('\n')) {
      const match = /^(\w+):\s+(\d+)\s*kB/i.exec(line.trim());
      if (match) values.set(match[1] as string, Number(match[2]) * 1024);
    }
    const total = values.get('SwapTotal');
    const free = values.get('SwapFree');
    if (total === undefined || free === undefined) return undefined;
    return { totalBytes: total, usedBytes: Math.max(0, total - free) };
  } catch {
    return undefined;
  }
}

/**
 * macOS exposes no swap counters through Node; `sysctl -n vm.swapusage` prints
 * `total = 2048.00M  used = 512.50M  free = 1535.50M`.
 */
async function collectMacosSwap(): Promise<SwapUsage | undefined> {
  try {
    const result = await runCommand(['sysctl', '-n', 'vm.swapusage'], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) return undefined;
    return parseSysctlSwap(result.stdout);
  } catch {
    return undefined;
  }
}

/** Parses `sysctl -n vm.swapusage` into bytes; a missing/unparsable value returns `undefined`. */
export function parseSysctlSwap(text: string): SwapUsage | undefined {
  const total = /total\s*=\s*([\d.]+)\s*([KMGTB])?/i.exec(text);
  const used = /used\s*=\s*([\d.]+)\s*([KMGTB])?/i.exec(text);
  if (!total || !used) return undefined;

  const totalBytes = sizeToBytes(Number.parseFloat(total[1] as string), total[2]);
  const usedBytes = sizeToBytes(Number.parseFloat(used[1] as string), used[2]);
  if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes)) return undefined;

  return { totalBytes, usedBytes: Math.min(usedBytes, totalBytes) };
}

function sizeToBytes(value: number, unit: string | undefined): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const multiplier =
    unit?.toUpperCase() === 'K'
      ? 1024
      : unit?.toUpperCase() === 'M'
        ? 1024 ** 2
        : unit?.toUpperCase() === 'G'
          ? 1024 ** 3
          : unit?.toUpperCase() === 'T'
            ? 1024 ** 4
            : 1;
  return Math.round(value * multiplier);
}

/* -------------------------------------------------------------------------- */
/* Disks                                                                      */
/* -------------------------------------------------------------------------- */

async function collectDisks(): Promise<RunnerDiskMetrics[]> {
  const blocks = await dfBlocks();
  if (blocks.length === 0) return [];

  const inodes = await dfInodes();
  const inodeByMount = new Map(inodes.map((entry) => [entry.mount, entry]));

  // The control plane's metrics schema accepts at most 32 mounts; keep the largest ones.
  const kept = [...blocks].sort((a, b) => b.total - a.total).slice(0, MAX_DISKS);

  return kept.map((entry) => {
    const inode = inodeByMount.get(entry.mount);
    const disk: RunnerDiskMetrics = {
      mount: entry.mount.slice(0, 255),
      totalBytes: entry.total,
      usedBytes: entry.used,
      freeBytes: entry.free,
      usedPercent:
        entry.percent ?? (entry.total > 0 ? round((entry.used / entry.total) * 100, 1) : 0),
    };
    if (inode) disk.inodeUsedPercent = inode.usedPercent;
    return disk;
  });
}

async function dfBlocks(): Promise<DfEntry[]> {
  const output = await safeDf(['-Pk']);
  if (!output) return [];

  const entries: DfEntry[] = [];
  for (const line of output.split('\n')) {
    const parsed = parseDfLine(line);
    if (!parsed) continue;
    if (isPseudoFilesystem(parsed.filesystem)) continue;

    const total = (parsed.integers[0] ?? 0) * 1024;
    const used = (parsed.integers[1] ?? 0) * 1024;
    const free = (parsed.integers[2] ?? 0) * 1024;
    if (total <= 0) continue;

    const percent = parsed.percents[0];
    entries.push({
      filesystem: parsed.filesystem,
      mount: parsed.mount,
      total,
      used,
      free,
      ...(percent === undefined ? {} : { percent }),
    });
  }
  return entries;
}

async function dfInodes(): Promise<InodeEntry[]> {
  const output = await safeDf(['-i']);
  if (!output) return [];

  const entries: InodeEntry[] = [];
  for (const line of output.split('\n')) {
    const parsed = parseDfLine(line);
    if (!parsed) continue;
    if (isPseudoFilesystem(parsed.filesystem)) continue;

    // `df -i` has exactly one percentage on Linux. macOS adds a block capacity
    // column before it, so the inode percentage is always the last one.
    const usedPercent = parsed.percents.at(-1);
    if (usedPercent === undefined) continue;
    entries.push({ mount: parsed.mount, usedPercent });
  }
  return entries;
}

async function safeDf(flags: string[]): Promise<string | undefined> {
  try {
    const result = await runCommand(['df', ...flags], { timeoutMs: COMMAND_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses one `df` line: `<filesystem> <integers/percentages...> <mount>`.
 *
 * The mount point is the trailing path: scanning from the right for the last token that
 * starts with `/` survives both the Linux POSIX layout and macOS's extra block/inode
 * columns. The header and malformed lines return `undefined`.
 */
export function parseDfLine(line: string): DfLine | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || /^Filesystem\b/i.test(trimmed)) return undefined;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return undefined;

  let mountStart = -1;
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    if ((parts[index] as string).startsWith('/')) {
      mountStart = index;
      break;
    }
  }
  if (mountStart < 0) return undefined;

  const integers: number[] = [];
  const percents: number[] = [];
  for (let index = 1; index < mountStart; index += 1) {
    const token = parts[index] as string;
    if (/^\d+%$/.test(token)) {
      percents.push(Number.parseInt(token.slice(0, -1), 10));
      continue;
    }
    const value = Number.parseInt(token, 10);
    if (Number.isFinite(value)) integers.push(value);
  }

  return {
    filesystem: parts[0] as string,
    mount: parts.slice(mountStart).join(' '),
    integers,
    percents,
  };
}

function isPseudoFilesystem(filesystem: string): boolean {
  const name = filesystem.replace(/^\/dev\//, '');
  return PSEUDO_FILESYSTEMS.test(name);
}

/* -------------------------------------------------------------------------- */
/* Processes                                                                  */
/* -------------------------------------------------------------------------- */

async function collectProcessCount(): Promise<number | undefined> {
  try {
    const result = await runCommand(['ps', '-e'], { timeoutMs: COMMAND_TIMEOUT_MS });
    if (result.code !== 0) return undefined;
    return parseProcessCount(result.stdout);
  } catch {
    return undefined;
  }
}

/** `ps -e` prints one header line followed by one line per process. */
export function parseProcessCount(output: string): number | undefined {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return undefined;
  return Math.max(0, lines.length - 1);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** PowerShell may serialise `[int64]` as a JSON number or a string; accept both. */
function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
