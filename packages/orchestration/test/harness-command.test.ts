import { describe, expect, test } from 'bun:test';
import { DEFAULT_HARNESS_COMMAND, RUNNER_OPENCODE_CONFIG } from '@factory/runners';
import { harnessCommandWithProxyEnv } from '../src/activities/runner';

/**
 * Native runners (macOS/Windows) do not have the runner Docker image's baked-in
 * `opencode.json`. The command must carry the same config inline so `factory/best_llm`
 * resolves instead of dying with `ModelUnavailableError`.
 */

describe('harnessCommandWithProxyEnv', () => {
  test('includes the runner opencode config for the opencode harness', () => {
    const command = harnessCommandWithProxyEnv(
      { OPENAI_BASE_URL: 'http://localhost:8080/v1', OPENAI_API_KEY: 'rsk_run' },
      'run_test',
      'opencode',
    );

    expect(command).toContain('OPENAI_BASE_URL=');
    expect(command).toContain('OPENAI_API_KEY=');
    expect(command).toContain('OPENCODE_SERVER_PASSWORD=');
    expect(command).toContain('OPENCODE_CONFIG_CONTENT=');
    expect(command).toContain('factory/best_llm');
    expect(command).toContain(DEFAULT_HARNESS_COMMAND);
    expect(RUNNER_OPENCODE_CONFIG).toContain('"model": "factory/best_llm"');
  });

  test('does not add opencode config for a non-opencode harness', () => {
    const command = harnessCommandWithProxyEnv(undefined, 'run_test', 'fake');
    expect(command).not.toContain('OPENCODE_CONFIG_CONTENT=');
    expect(command).toContain(DEFAULT_HARNESS_COMMAND);
  });

  test('quotes values so a config with quotes survives the shell', () => {
    const command = harnessCommandWithProxyEnv(undefined, 'run_test', 'opencode');
    // The JSON is single-quoted; any embedded single quote is escaped as '\''.
    expect(command).toMatch(/OPENCODE_CONFIG_CONTENT='\{/);
  });
});
