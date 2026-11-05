import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The runner's opencode config, shared by the Docker image and native agents.
 *
 * Docker bakes `packages/runners/docker/opencode.json` into the image. Native macOS and
 * Windows agents have no such image, so the workflow passes the same content through
 * `OPENCODE_CONFIG_CONTENT` in the harness command. Keeping one file as the source of
 * truth prevents the two paths from drifting.
 */
export const RUNNER_OPENCODE_CONFIG = readFileSync(
  fileURLToPath(new URL('../docker/opencode.json', import.meta.url)),
  'utf8',
);
