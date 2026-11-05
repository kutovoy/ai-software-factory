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
 */

const CPU_SAMPLE_MS = 200;
const COMMAND_TIMEOUT_MS = 5_000;
/** The control plane rejects a metrics sample with more than 32 mounts. */
const MAX_DISKS = 32;

/** Pseudo filesystems that report meaningless capacity numbers. */
const PSEUDO_FILESYSTEMS =
  /^(devfs|map|none|proc|sysfs|devpts|cgroup2?|securityfs|pstore|bpf|tracefs|debugfs|mqueue|hugetlbfs|fusectl|configfs|ramfs|autofs|binfmt_misc|nsfs|tmpfs|devtmpfs|shm)$/;

interface CpuTimes {
  idle: number;
  total: number;
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

interface DfLine {
  filesystem: string;
  mount: string;
  integers: number[];
  percents: number[];
}

/**
 * Samples the host and returns a `RunnerMetrics` payload.
 *
 * CPU percentage is a delta over a short `os.cpus()` sample (default 200ms); memory comes
 * from `os`; swap and process count are best effort; disks are parsed from `df -Pk` /
 * `df -i`. The function never throws.
 */
export async function collectMetrics(agentVersion: string): Promise<RunnerMetrics> {
  const capturedAt = new Date().toISOString();

  try {
    const [cpuPercent, disks, swap, processCount] = await Promise.all([
      sampleCpuPercent(),
      collectDisks(),
      collectSwap(),
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

/**
 * Reads `/proc/meminfo` on Linux. macOS has no swap counters exposed through Node, so the
 * field is simply omitted there.
 */
async function collectSwap(): Promise<{ totalBytes: number; usedBytes: number } | undefined> {
  if (process.platform !== 'linux') return undefined;
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
function parseDfLine(line: string): DfLine | undefined {
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
    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    // The first line is the header on Linux/macOS.
    return Math.max(0, lines.length - 1);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
