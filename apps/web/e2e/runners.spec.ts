import { expect, test } from '@playwright/test';
import {
  cleanupHosts,
  enrollRunner,
  sendHeartbeat,
  uniqueRunnerName,
} from './helpers';

/**
 * `add-runner-platforms-and-artifacts`, task 6: the Runners console surface.
 *
 * The wizard issues a one-time token plus platform-specific commands; a host then enrolls
 * with that token and reports heartbeats. Windows/macOS hosts are exercised through the
 * command rendering only — the agent-side calls are API simulations, so no real Windows or
 * macOS machine is needed. Every host created here is deleted in `afterEach`, because a
 * leftover `ready` host would be picked by the scheduler and skew other specs.
 */

test.afterEach(async ({ request }) => {
  await cleanupHosts(request);
});

test.describe('Runners', () => {
  test('healthy empty state and the add-runner wizard offers Windows and macOS', async ({
    page,
  }) => {
    await page.goto('/runners');

    await expect(page.getByTestId('runners-panel')).toBeVisible();
    await expect(page.getByTestId('runners-summary')).toBeVisible();
    for (const id of [
      'runners-summary-ready',
      'runners-summary-leases',
      'runners-summary-alerts',
      'runners-summary-pools',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.getByTestId('runners-summary-ready')).toContainText('enrolled');
    await expect(page.getByTestId('runners-note')).toBeVisible();

    // Healthy surface: the empty state when nothing is enrolled, the hosts table otherwise.
    const empty = page.getByTestId('runners-empty');
    const hosts = page.getByTestId('runners-hosts');
    await expect(empty.or(hosts)).toBeVisible();
    if (await empty.isVisible()) await expect(empty).toContainText('No runners enrolled');

    // The wizard starts open on an empty page; open it explicitly otherwise.
    const form = page.getByTestId('runner-create-form');
    if (!(await form.isVisible())) await page.getByTestId('runner-create-toggle').click();
    await expect(form).toBeVisible();

    // Both native platforms are selectable — the old wizard disabled them.
    const platform = page.getByTestId('runner-create-platform');
    await expect(platform.locator('option[value="windows"]')).toBeEnabled();
    await expect(platform.locator('option[value="macos"]')).toBeEnabled();

    const name = uniqueRunnerName('e2e-win');
    await page.getByTestId('runner-create-name').fill(name);
    await platform.selectOption('windows');
    await page.getByTestId('runner-create-arch').selectOption('x64');
    await page.getByTestId('runner-create-submit').click();

    // The one-time token is shown once; the API keeps only its hash.
    const enrollment = page.getByTestId('runner-enrollment');
    await expect(enrollment).toBeVisible();
    const token = page.getByTestId('runner-enrollment-token');
    await expect(token).toBeVisible();
    await expect(token).not.toHaveText('');
    expect((await token.textContent())?.trim()).toMatch(/^ren_/);
    await expect(page.getByTestId('runner-enrollment-state')).toHaveText('awaiting install');

    // Windows renders a PowerShell preflight, not the bash script.
    const preflight = page.getByTestId('runner-preflight-command');
    await expect(preflight).toBeVisible();
    await expect(preflight).toContainText('$apiUrl');
    await expect(preflight).toContainText('Invoke-RestMethod');
    await expect(preflight).not.toContainText('#!/usr/bin/env bash');

    // The native install path selects the local backend and keeps the token in the env.
    const install = page.getByTestId('runner-install-command');
    await expect(install).toBeVisible();
    await expect(install).toContainText(/RUNNER_BACKEND\s*=\s*'local'/);
    await expect(install).toContainText('$env:RUNNER_ENROLLMENT_TOKEN');
    await expect(install).toContainText('Start-Process');
  });

  test('API enrollment plus a simulated heartbeat show up in the list and host detail', async ({
    page,
    request,
  }) => {
    const name = uniqueRunnerName('e2e-linux');
    const runner = await enrollRunner(request, { name, platform: 'linux', arch: 'x64' });
    await sendHeartbeat(request, runner.agentToken);

    await page.goto('/runners');
    const row = page.getByTestId('runner-host-row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('runner-host-status')).toHaveText('ready');
    await expect(row.getByTestId('runner-host-pool')).toHaveText('default');
    await expect(row.getByTestId('runner-host-leases')).toContainText('0 /');
    await expect(row).toContainText('linux/x64');
    // The compact meters carry the reported values, not a fabricated zero.
    const load = row.getByTestId('runner-host-load');
    await expect(load.locator('[data-metric="cpu"]')).toHaveAttribute('data-value', '42');
    await expect(load.locator('[data-metric="ram"]')).toHaveAttribute('data-value', '50');
    await expect(load.locator('[data-metric="disk"]')).toHaveAttribute('data-value', '95');

    await row.getByTestId('runner-host-link').click();
    await expect(page.getByTestId('runner-detail-name')).toHaveText(name);
    await expect(page.getByTestId('runner-detail-status')).toHaveText('ready');
    await expect(page.getByTestId('runner-detail-id')).toHaveText(runner.hostId);

    const meta = (key: string) =>
      page.locator(`[data-testid="runner-meta-cell"][data-meta="${key}"]`);
    await expect(meta('platform')).toContainText('linux/x64');
    await expect(meta('pool')).toContainText('default');
    await expect(meta('agent')).toContainText('e2e');

    await expect(page.getByTestId('runner-gauge-cpu')).toHaveAttribute('data-value', '42');
    await expect(page.getByTestId('runner-gauge-cpu')).toContainText('42%');
    await expect(page.getByTestId('runner-gauge-memory')).toHaveAttribute('data-value', '50');
    await expect(page.getByTestId('runner-gauge-memory')).toContainText('50%');
    await expect(page.getByTestId('runner-gauge-disk')).toHaveAttribute('data-value', '95');
    await expect(page.getByTestId('runner-gauge-disk')).toContainText('95%');

    // The raw payload is collapsed by default; expanding it shows the counters verbatim.
    const raw = page.getByTestId('runner-detail-raw-metrics');
    await expect(raw).toBeVisible();
    await raw.locator('summary').click();
    await expect(raw).toContainText('cpuPercent');
    await expect(raw).toContainText('disks');
    expect(await raw.getByTestId('runner-raw-metric').count()).toBeGreaterThan(5);
  });

  test('disk threshold fires, the alert acknowledges, and the host deletes', async ({
    page,
    request,
  }) => {
    const name = uniqueRunnerName('e2e-alert');
    const runner = await enrollRunner(request, { name, platform: 'linux', arch: 'x64' });
    await sendHeartbeat(request, runner.agentToken);

    // The heartbeat reports 95% disk usage, above the seeded disk-warning (80) and
    // disk-critical (90) rules, so at least one firing alert must exist for this host.
    type AlertWire = {
      id: string;
      hostId: string;
      ruleId: string;
      metric: string;
      state: string;
      severity: string;
    };
    const alertsResponse = await request.get('/api/v1/runner-alerts');
    expect(alertsResponse.ok(), `GET /api/v1/runner-alerts failed: ${alertsResponse.status()}`).toBeTruthy();
    const { alerts } = (await alertsResponse.json()) as { alerts: AlertWire[] };
    const firing = alerts.filter((alert) => alert.hostId === runner.hostId && alert.state === 'firing');
    expect(firing.length, `no firing alert for ${runner.hostId}`).toBeGreaterThan(0);
    const diskAlert =
      firing.find((alert) => alert.ruleId === 'disk-critical') ??
      firing.find((alert) => alert.ruleId === 'disk-warning');
    expect(diskAlert, 'the seeded disk rule should fire at 95% used').toBeTruthy();
    expect(['disk-warning', 'disk-critical']).toContain(diskAlert!.ruleId);
    expect(diskAlert!.metric).toBe('disk_used_percent');
    expect(diskAlert!.severity).toBe(diskAlert!.ruleId === 'disk-critical' ? 'critical' : 'warning');

    await page.goto('/runners');
    const alertRow = page.locator(
      `[data-testid="runner-alert-row"]:has([data-testid="runner-alert-ack"][data-alert="${diskAlert!.id}"])`,
    );
    await expect(alertRow).toBeVisible();
    await expect(alertRow.getByTestId('runner-alert-state')).toHaveText('firing');
    await expect(alertRow.getByTestId('runner-alert-host')).toHaveText(name);
    await expect(alertRow.getByTestId('runner-alert-metric')).toContainText('disk_used_percent');

    await alertRow.getByTestId('runner-alert-ack').click();
    await expect(alertRow.getByTestId('runner-alert-state')).toHaveText('acknowledged');
    await expect
      .poll(
        async () => {
          const response = await request.get('/api/v1/runner-alerts');
          if (!response.ok()) return `http ${response.status()}`;
          const body = (await response.json()) as { alerts: AlertWire[] };
          return body.alerts.find((alert) => alert.id === diskAlert!.id)?.state ?? 'missing';
        },
        { timeout: 15_000 },
      )
      .toBe('acknowledged');

    // Delete through the console: the first click arms, the second removes the host.
    await page.goto('/runners');
    const hostRow = page.getByTestId('runner-host-row').filter({ hasText: name });
    await expect(hostRow).toBeVisible();
    const deleteButton = hostRow.getByTestId('runner-host-delete');
    await deleteButton.click();
    await expect(deleteButton).toHaveText('Confirm delete');
    await deleteButton.click();

    await expect(page.getByTestId('runner-host-row').filter({ hasText: name })).toHaveCount(0);
    const hostsResponse = await request.get('/api/v1/runners');
    expect(hostsResponse.ok(), `GET /api/v1/runners failed: ${hostsResponse.status()}`).toBeTruthy();
    const { hosts } = (await hostsResponse.json()) as { hosts: Array<{ id: string }> };
    expect(hosts.some((host) => host.id === runner.hostId)).toBeFalsy();
  });
});
