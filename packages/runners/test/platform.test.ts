import { describe, expect, test } from 'bun:test';
import {
  collectMetrics,
  defaultShell,
  parseDfLine,
  parseProcessCount,
  parseSysctlSwap,
  parseWindowsMetricsJson,
  powershellQuote,
  quoteCommandArgs,
  resolveAgentConfig,
  shellArgv,
  shellKind,
  toNodePlatform,
} from '../src';

/**
 * Platform support is verified without a Windows/macOS host: shell argv, quoting and metric
 * parsing are pure, and `collectMetrics` is exercised through the platform argument.
 */

const ENV = { FACTORY_API_URL: 'https://factory.example.com' };

describe('platform mapping', () => {
  test('maps the enrolled platform to a Node platform', () => {
    expect(toNodePlatform('linux')).toBe('linux');
    expect(toNodePlatform('windows')).toBe('win32');
    expect(toNodePlatform('macos')).toBe('darwin');
  });
});

describe('backend defaults', () => {
  test('Linux defaults to the docker backend', () => {
    const config = resolveAgentConfig({}, { ...ENV, RUNNER_PLATFORM: 'linux' });
    expect(config.platform).toBe('linux');
    expect(config.backend).toBe('docker');
  });

  test('Windows and macOS default to the native backend', () => {
    expect(resolveAgentConfig({}, { ...ENV, RUNNER_PLATFORM: 'windows' }).backend).toBe('local');
    expect(resolveAgentConfig({}, { ...ENV, RUNNER_PLATFORM: 'macos' }).backend).toBe('local');
  });

  test('an explicit backend option or env still wins', () => {
    expect(
      resolveAgentConfig({}, { ...ENV, RUNNER_PLATFORM: 'windows', RUNNER_BACKEND: 'docker' }).backend,
    ).toBe('docker');
    expect(
      resolveAgentConfig(
        { backend: 'docker' },
        { ...ENV, RUNNER_PLATFORM: 'macos', RUNNER_BACKEND: 'local' },
      ).backend,
    ).toBe('docker');
    expect(
      resolveAgentConfig({ backend: 'local' }, { ...ENV, RUNNER_PLATFORM: 'linux' }).backend,
    ).toBe('local');
  });

  test('an unset platform keeps the documented Linux default', () => {
    const config = resolveAgentConfig({}, ENV);
    expect(config.platform).toBe('linux');
    expect(config.backend).toBe('docker');
  });

  test('an unknown backend is rejected', () => {
    expect(() => resolveAgentConfig({}, { ...ENV, RUNNER_BACKEND: 'firecracker' })).toThrow(
      'RUNNER_BACKEND',
    );
  });
});

describe('local shell argv', () => {
  test('POSIX keeps `/bin/sh -c`', () => {
    expect(defaultShell('linux')).toBe('/bin/sh');
    expect(defaultShell('darwin')).toBe('/bin/sh');
    expect(shellKind('/bin/sh')).toBe('posix');
    expect(shellKind('/bin/bash')).toBe('posix');
    expect(shellArgv('/bin/sh', 'echo hi')).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  test('Windows defaults to PowerShell with non-interactive flags', () => {
    expect(defaultShell('win32')).toBe('powershell.exe');
    expect(shellKind('powershell.exe')).toBe('powershell');
    expect(shellKind('pwsh.exe')).toBe('powershell');
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellArgv('powershell.exe', 'echo hi')).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'echo hi',
    ]);
  });

  test('an explicitly selected cmd.exe uses /d /s /c', () => {
    expect(shellKind('cmd.exe')).toBe('cmd');
    expect(shellArgv('cmd.exe', 'echo hi')).toEqual(['cmd.exe', '/d', '/s', '/c', 'echo hi']);
  });
});

describe('command quoting', () => {
  test('POSIX quoting is unchanged (single quotes, escaped embedded quote)', () => {
    expect(quoteCommandArgs(['echo', 'hi'], '/bin/sh')).toBe(`'echo' 'hi'`);
    expect(quoteCommandArgs(['echo', "it's"], '/bin/sh')).toBe(`'echo' 'it'\\''s'`);
  });

  test('PowerShell quoting uses the call operator and doubled single quotes', () => {
    expect(powershellQuote("it's")).toBe("'it''s'");
    expect(quoteCommandArgs(['bun', 'test', '--filter', 'a b'], 'powershell.exe')).toBe(
      "& 'bun' 'test' '--filter' 'a b'",
    );
    // A backslash is literal in PowerShell: no POSIX-style escaping is applied.
    expect(quoteCommandArgs(['node', '-e', 'console.log("x")'], 'pwsh.exe')).toBe(
      `& 'node' '-e' 'console.log("x")'`,
    );
    expect(quoteCommandArgs([], 'powershell.exe')).toBe('');
  });

  test('cmd.exe quoting wraps arguments containing whitespace or metacharacters', () => {
    expect(quoteCommandArgs(['echo', 'hi'], 'cmd.exe')).toBe('echo hi');
    expect(quoteCommandArgs(['echo', 'a b'], 'cmd.exe')).toBe('echo "a b"');
    expect(quoteCommandArgs(['echo', 'a&b'], 'cmd.exe')).toBe('echo "a&b"');
  });
});

describe('Windows metrics parsing', () => {
  test('parses the CIM JSON object including logical disks', () => {
    const sample = parseWindowsMetricsJson(
      JSON.stringify({
        cpuPercent: 42.5,
        memoryTotalBytes: 34_359_738_368,
        memoryFreeBytes: 8_589_934_592,
        uptimeSeconds: 98_765,
        processCount: 321,
        disks: [
          { DeviceID: 'C:', Size: 512_110_190_592, FreeSpace: 128_027_547_648 },
          { DeviceID: 'D:', Size: 1_000_000_000, FreeSpace: 250_000_000 },
        ],
      }),
    );

    expect(sample).toBeDefined();
    expect(sample?.cpuPercent).toBe(42.5);
    expect(sample?.memoryTotalBytes).toBe(34_359_738_368);
    expect(sample?.memoryFreeBytes).toBe(8_589_934_592);
    expect(sample?.uptimeSeconds).toBe(98_765);
    expect(sample?.processCount).toBe(321);
    expect(sample?.disks).toHaveLength(2);
    const c = sample?.disks.find((disk) => disk.mount === 'C:');
    expect(c?.totalBytes).toBe(512_110_190_592);
    expect(c?.freeBytes).toBe(128_027_547_648);
    expect(c?.usedBytes).toBe(512_110_190_592 - 128_027_547_648);
    expect(c?.usedPercent).toBeCloseTo(75, 0);
    // Largest disk first, matching the POSIX path.
    expect(sample?.disks[0]?.mount).toBe('C:');
  });

  test('accepts a single disk object and numeric strings from older PowerShell', () => {
    const sample = parseWindowsMetricsJson(
      JSON.stringify({
        cpuPercent: '7',
        memoryTotalBytes: '1073741824',
        memoryFreeBytes: '536870912',
        uptimeSeconds: '60',
        processCount: '12',
        disks: { DeviceID: 'E:', Size: '2000', FreeSpace: '500' },
      }),
    );
    expect(sample?.cpuPercent).toBe(7);
    expect(sample?.memoryTotalBytes).toBe(1_073_741_824);
    expect(sample?.processCount).toBe(12);
    expect(sample?.disks).toHaveLength(1);
    expect(sample?.disks[0]).toMatchObject({ mount: 'E:', totalBytes: 2000, usedBytes: 1500 });
  });

  test('omits missing fields instead of fabricating them', () => {
    const sample = parseWindowsMetricsJson('{"disks":[],"cpuPercent":null}');
    expect(sample).toBeDefined();
    expect(sample?.cpuPercent).toBeUndefined();
    expect(sample?.memoryTotalBytes).toBeUndefined();
    expect(sample?.memoryFreeBytes).toBeUndefined();
    expect(sample?.uptimeSeconds).toBeUndefined();
    expect(sample?.processCount).toBeUndefined();
    expect(sample?.disks).toEqual([]);
  });

  test('a failed CIM query (zeros/nulls) does not look like a real sample', () => {
    const sample = parseWindowsMetricsJson(
      '{"cpuPercent":null,"memoryTotalBytes":0,"memoryFreeBytes":0,"uptimeSeconds":0,"processCount":0,"disks":[]}',
    );
    expect(sample?.memoryTotalBytes).toBeUndefined();
    // Free memory is only trusted when the total came through.
    expect(sample?.memoryFreeBytes).toBeUndefined();
    expect(sample?.uptimeSeconds).toBeUndefined();
    expect(sample?.processCount).toBeUndefined();
  });

  test('ignores a disk without a size and rejects unparsable output', () => {
    expect(
      parseWindowsMetricsJson('{"disks":[{"DeviceID":"C:","Size":0,"FreeSpace":0}]}')?.disks,
    ).toEqual([]);
    expect(parseWindowsMetricsJson('not json')).toBeUndefined();
    expect(parseWindowsMetricsJson('')).toBeUndefined();
  });

  test('clamps memory free to the reported total', () => {
    const sample = parseWindowsMetricsJson(
      '{"memoryTotalBytes":1000,"memoryFreeBytes":5000,"disks":[]}',
    );
    expect(sample?.memoryFreeBytes).toBe(1000);
  });
});

describe('macOS metrics parsing', () => {
  test('parses sysctl vm.swapusage', () => {
    const swap = parseSysctlSwap(
      'total = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)',
    );
    expect(swap?.totalBytes).toBe(2_048 * 1024 * 1024);
    expect(swap?.usedBytes).toBe(Math.round(512.5 * 1024 * 1024));
  });

  test('handles zero swap and gigabyte units', () => {
    expect(parseSysctlSwap('total = 0.00M  used = 0.00M  free = 0.00M')?.totalBytes).toBe(0);
    const swap = parseSysctlSwap('total = 2.00G  used = 1.00G  free = 1.00G');
    expect(swap?.totalBytes).toBe(2 * 1024 ** 3);
    expect(swap?.usedBytes).toBe(1024 ** 3);
  });

  test('a missing or malformed value degrades to undefined', () => {
    expect(parseSysctlSwap('')).toBeUndefined();
    expect(parseSysctlSwap('vm.swapusage: unavailable')).toBeUndefined();
  });

  test('counts processes from ps -e output', () => {
    const output = ['  PID TTY           TIME CMD', '    1 ??         0:01.01 launchd', '  123 ??         0:00.02 bash', ''].join('\n');
    expect(parseProcessCount(output)).toBe(2);
    expect(parseProcessCount('  PID TTY TIME CMD\n')).toBe(0);
    expect(parseProcessCount('')).toBeUndefined();
  });

  test('parses the macOS df layout (block capacity before the inode percentage)', () => {
    const parsed = parseDfLine(
      '/dev/disk3s1s1   926035896 12345678 812345678    2%   /',
    );
    expect(parsed?.mount).toBe('/');
    expect(parsed?.integers.slice(0, 3)).toEqual([926035896, 12345678, 812345678]);
    expect(parsed?.percents).toEqual([2]);
  });
});

describe('collectMetrics with an explicit platform', () => {
  test('a Windows sample on a non-Windows host degrades instead of throwing', async () => {
    const metrics = await collectMetrics('9.9.9-win', 'win32');
    expect(metrics.agentVersion).toBe('9.9.9-win');
    expect(Number.isFinite(metrics.cpuPercent)).toBe(true);
    // Node still reports memory on this host, so the sample stays honest rather than empty.
    expect(metrics.memoryTotalBytes).toBeGreaterThan(0);
    expect(Array.isArray(metrics.disks)).toBe(true);
    // Windows has no load average: the contract requires numbers, documented as 0.
    expect(metrics.load1).toBe(0);
  }, 20_000);

  test('a macOS sample reports swap/process fields when the tools exist', async () => {
    const metrics = await collectMetrics('9.9.9-mac', 'darwin');
    expect(metrics.agentVersion).toBe('9.9.9-mac');
    expect(metrics.memoryTotalBytes).toBeGreaterThan(0);
    expect(Array.isArray(metrics.disks)).toBe(true);
    if (metrics.processCount !== undefined) expect(metrics.processCount).toBeGreaterThan(0);
  }, 20_000);
});
