import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import {
  DefinitionValidationError,
  mapZodIssues,
  validationError,
  validationWarning,
  type ErrorCode,
  type ValidationError,
  type ValidationWarning,
} from '../errors';
import { agentFrontmatterSchema } from '../schema/agent';
import { automationFrontmatterSchema } from '../schema/automation';
import {
  benchmarkSuiteSchema,
  benchmarkTaskSchema,
  type BenchmarkSuite,
} from '../schema/benchmark';
import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from '../schema/common';
import { FACTORY_ID_RE, factorySchema, type FactoryManifest } from '../schema/factory';
import { packsLockSchema } from '../schema/packs';
import { routingSchema } from '../schema/routing';
import { runnerSchema } from '../schema/runner';
import { scorerFrontmatterSchema } from '../schema/scorer';
import { skillFrontmatterSchema } from '../schema/skill';
import { StageGraphError, compileStageGraph, isLoopStage, stageDeclarationsFromDefinition } from '../stage-graph/graph';
import type { AgentDef } from '../schema/agent';
import { collectModelRefSites, modelEnvName, resolveModelRef } from '../model/ref';
import { collectSecretReferences, declaredMcpServers } from '../secrets/references';
import { normalizeBody, splitFrontmatter } from './frontmatter';
import { ALLOWED_LOCATIONS, classify, walk, type ResourceKind } from './walk';

export interface Resource {
  kind: ResourceKind;
  name: string;
  /** POSIX path relative to the definition root. */
  path: string;
  format: 'yaml' | 'markdown';
  /** Normalised frontmatter / document (schema defaults applied, unknown keys stripped). */
  doc: unknown;
  /** Normalised prose body for Markdown resources; empty for YAML resources. */
  body: string;
}

export interface FactoryDefinition {
  root: string;
  manifest: FactoryManifest;
  resources: Resource[];
}

export interface LoadResult {
  definition: FactoryDefinition | null;
  errors: ValidationError[];
  /**
   * Non-fatal findings. `secret_unregistered` is emitted only when the caller supplies
   * the registered secret names (the API knows the registry; a fresh checkout does not).
   */
  warnings: ValidationWarning[];
}

export interface LoadOptions {
  /** Names currently registered. When omitted, no `secret_unregistered` warning is made. */
  registeredSecrets?: Iterable<string>;
  /**
   * Environment used to resolve `env:` model references (ADR-028). Defaults to
   * `process.env`; tests pass an explicit map so they never depend on the host.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Refuse a definition without `id` (change `add-factory-identity`): the API, the worker
   * and anything that starts work require `fac_<ulid>`. Off by default so fixtures,
   * CLI validation of pre-identity definitions and schema tests keep working.
   */
  requireFactoryId?: boolean;
}

const SCHEMAS: Record<Exclude<ResourceKind, 'factory'>, z.ZodTypeAny> = {
  agent: agentFrontmatterSchema,
  'agent-skill': skillFrontmatterSchema,
  automation: automationFrontmatterSchema,
  scorer: scorerFrontmatterSchema,
  skill: skillFrontmatterSchema,
  runner: runnerSchema,
  routing: routingSchema,
  packs: packsLockSchema,
  benchmark: benchmarkSuiteSchema,
  'benchmark-task': benchmarkTaskSchema,
};

type Push = (code: ErrorCode, file: string, pointer: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseYamlDocument(raw: string): { doc: unknown; error?: string } {
  try {
    return { doc: parseYaml(raw) ?? {} };
  } catch (error) {
    return { doc: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function compareResources(a: Resource, b: Resource): number {
  const left = `${a.kind}:${a.name}`;
  const right = `${b.kind}:${b.name}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function loadDefinition(root: string, options: LoadOptions = {}): LoadResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const push: Push = (code, file, pointer, message) => {
    errors.push(validationError(code, file, pointer, message));
  };
  const warn = (code: ValidationWarning['code'], file: string, pointer: string, message: string) => {
    warnings.push(validationWarning(code, file, pointer, message));
  };

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    push('missing_file', root, '/', 'definition directory does not exist');
    return { definition: null, errors, warnings };
  }

  const files = walk(root);
  if (!files.includes('factory.yaml')) {
    push('missing_file', 'factory.yaml', '/', 'factory.yaml is required at the definition root');
  }

  let manifest: FactoryManifest | null = null;
  if (files.includes('factory.yaml')) {
    const { doc, error } = parseYamlDocument(readFileSync(join(root, 'factory.yaml'), 'utf8'));
    if (error) {
      push('invalid_yaml', 'factory.yaml', '/', `invalid YAML: ${error}`);
    } else if (!isRecord(doc)) {
      push('invalid_yaml', 'factory.yaml', '/', 'factory.yaml must be a YAML mapping');
    } else if (!('schemaVersion' in doc)) {
      push(
        'missing_field',
        'factory.yaml',
        '/schemaVersion',
        `missing schemaVersion; supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      );
    } else if (doc.schemaVersion !== SCHEMA_VERSION) {
      push(
        'unsupported_schema_version',
        'factory.yaml',
        '/schemaVersion',
        `unsupported schemaVersion "${String(doc.schemaVersion)}"; supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')} (migrate the definition to ${SCHEMA_VERSION})`,
      );
    } else {
      const parsed = factorySchema.safeParse(doc);
      if (parsed.success) {
        manifest = parsed.data;
        // The identity is required at runtime (spec `factory-identity` › Stable factory ID).
        if (options.requireFactoryId && !manifest.id) {
          push(
            'factory_id_missing',
            'factory.yaml',
            '/id',
            'factory.yaml must declare a stable `id: fac_<ulid>`; run `bun scripts/migrate-factory-identity.ts` to mint one',
          );
          manifest = null;
        }
      } else {
        errors.push(...mapZodIssues(parsed.error.issues, 'factory.yaml'));
      }
    }
  }

  const resources: Resource[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    if (file === 'factory.yaml') continue;

    const classified = classify(file);
    if (!classified) {
      push('unknown_file', file, '/', `unknown file; allowed locations: ${ALLOWED_LOCATIONS}`);
      continue;
    }
    if (classified.kind === 'factory') continue;

    const identity = `${classified.kind}:${classified.name.toLowerCase()}`;
    const previous = seen.get(identity);
    if (previous) {
      push(
        'duplicate_identity',
        file,
        '/',
        `${classified.kind} "${classified.name}" is already defined at ${previous}`,
      );
      continue;
    }
    seen.set(identity, file);

    const raw = readFileSync(join(root, file), 'utf8');
    let body = '';

    if (classified.format === 'markdown') {
      const split = splitFrontmatter(raw);
      if (!split.ok) {
        push(split.code, file, '/', split.message);
        continue;
      }
      const { doc, error } = parseYamlDocument(split.frontmatter);
      if (error) {
        push('invalid_yaml', file, '/', `invalid frontmatter YAML: ${error}`);
        continue;
      }
      if (!isRecord(doc)) {
        push('invalid_yaml', file, '/', 'frontmatter must be a YAML mapping');
        continue;
      }
      body = normalizeBody(split.body);
      if (body.length === 0) {
        push('missing_field', file, '/body', 'document body must contain instructions');
        continue;
      }
      const parsed = SCHEMAS[classified.kind].safeParse(doc);
      if (!parsed.success) {
        errors.push(...mapZodIssues(parsed.error.issues, file));
        continue;
      }
      resources.push({
        kind: classified.kind,
        name: classified.name,
        path: file,
        format: classified.format,
        doc: parsed.data,
        body,
      });
      continue;
    }

    const { doc, error } = parseYamlDocument(raw);
    if (error) {
      push('invalid_yaml', file, '/', `invalid YAML: ${error}`);
      continue;
    }
    if (!isRecord(doc)) {
      push('invalid_yaml', file, '/', 'document must be a YAML mapping');
      continue;
    }
    const parsed = SCHEMAS[classified.kind].safeParse(doc);
    if (!parsed.success) {
      errors.push(...mapZodIssues(parsed.error.issues, file));
      continue;
    }
    resources.push({
      kind: classified.kind,
      name: classified.name,
      path: file,
      format: classified.format,
      doc: parsed.data,
      body: '',
    });
  }

  if (manifest) crossValidate(manifest, resources, push);

  if (manifest) {
    // `env:` model references are configuration (ADR-028): an unset name is a warning,
    // never a validation error, so a fresh checkout still loads. Run creation refuses
    // the unresolved model instead of sending the literal `env:...` upstream.
    const env = options.env ?? process.env;
    const documents = [
      { file: 'factory.yaml', doc: manifest },
      ...resources.map((resource) => ({ file: resource.path, doc: resource.doc })),
    ];
    for (const site of collectModelRefSites(documents)) {
      const resolved = resolveModelRef(site.ref, env);
      if (resolved.source !== 'env' || resolved.value !== null) continue;
      const name = modelEnvName(site.ref) ?? site.ref;
      warn(
        'model_env_unresolved',
        site.file,
        site.pointer,
        `model reference "${site.ref}" is unresolved: environment variable "${name}" is not set; a run cannot start until it is`,
      );
    }
  }

  if (manifest && options.registeredSecrets) {
    const registered = new Set(options.registeredSecrets);
    const agentResources = resources.filter((resource) => resource.kind === 'agent');
    const agents = agentResources.map((resource) => ({
      name: resource.name,
      doc: resource.doc as AgentDef,
    }));
    const fileOf = new Map(agentResources.map((resource) => [resource.name, resource.path]));
    for (const reference of collectSecretReferences(manifest, agents)) {
      if (registered.has(reference.name)) continue;
      warn(
        'secret_unregistered',
        reference.kind === 'agent' ? (fileOf.get(reference.resource) ?? 'factory.yaml') : 'factory.yaml',
        reference.pointer,
        `secret "${reference.name}" is referenced but not registered; the first real run will fail until it is provided`,
      );
    }
  }

  resources.sort(compareResources);

  if (errors.length > 0) return { definition: null, errors, warnings };
  return { definition: { root, manifest: manifest as FactoryManifest, resources }, errors, warnings };
}

/**
 * The declared `id` from `factory.yaml`, even when the rest of the definition does not
 * validate (change `add-factory-identity`). The registry needs an identity for a broken
 * factory too, so the console can show it as invalid instead of losing it.
 */
export function readFactoryId(root: string): string | null {
  const path = join(root, 'factory.yaml');
  if (!existsSync(path)) return null;
  try {
    const doc = parseYaml(readFileSync(path, 'utf8'));
    const id = isRecord(doc) ? doc.id : null;
    return typeof id === 'string' && FACTORY_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function loadOrThrow(root: string, options: LoadOptions = {}): FactoryDefinition {
  const { definition, errors } = loadDefinition(root, options);
  if (!definition) throw new DefinitionValidationError(errors);
  return definition;
}

function crossValidate(manifest: FactoryManifest, resources: Resource[], push: Push): void {
  const namesOf = (kind: ResourceKind): Set<string> =>
    new Set(resources.filter((resource) => resource.kind === kind).map((resource) => resource.name));

  const agents = namesOf('agent');
  const runners = namesOf('runner');
  const secrets = new Set(manifest.secrets);
  const declared = declaredMcpServers(manifest);
  const mcpServers = new Set(declared.map((server) => server.name));

  const checkList = (
    file: string,
    pointer: string,
    values: string[] | undefined,
    allowed: Set<string>,
    label: string,
  ): void => {
    values?.forEach((value, index) => {
      if (!allowed.has(value)) {
        push('unknown_reference', file, `${pointer}/${index}`, `unknown ${label} "${value}"`);
      }
    });
  };

  const checkOne = (
    file: string,
    pointer: string,
    value: string | undefined,
    allowed: Set<string>,
    label: string,
  ): void => {
    if (value !== undefined && !allowed.has(value)) {
      push('unknown_reference', file, pointer, `unknown ${label} "${value}"`);
    }
  };

  const checkHarnessSecret = (file: string, harness: unknown): void => {
    if (!isRecord(harness)) return;
    const auth = harness.auth;
    if (!isRecord(auth) || auth.source !== 'managedSecret') return;
    checkOne(file, '/harness/auth/secretName', auth.secretName as string | undefined, secrets, 'secret');
  };

  checkOne('factory.yaml', '/agentDefaults/runner', manifest.agentDefaults.runner, runners, 'runner');
  checkList('factory.yaml', '/agentDefaults/secrets', manifest.agentDefaults.secrets, secrets, 'secret');
  checkList(
    'factory.yaml',
    '/agentDefaults/mcpServers',
    manifest.agentDefaults.mcpServers,
    mcpServers,
    'MCP server',
  );
  checkHarnessSecret('factory.yaml', manifest.agentDefaults.harness);

  // The optional `stages:` block is the loop's stage graph. Agent references are checked
  // like every other reference; the graph itself is compiled so an unknown stage or a
  // cycle fails validation with `invalid_stage_graph` naming the offending node.
  const agentSources = resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  manifest.stages?.forEach((declaration, index) => {
    checkOne('factory.yaml', `/stages/${index}/agent`, declaration.agent, agents, 'agent');
  });

  const declaresLoopStage =
    Boolean(manifest.stages && manifest.stages.length > 0) ||
    agentSources.some((agent) => agent.doc.role !== undefined && isLoopStage(agent.doc.role));

  if (declaresLoopStage) {
    try {
      compileStageGraph(stageDeclarationsFromDefinition(manifest, agentSources));
    } catch (error) {
      if (error instanceof StageGraphError) {
        push('invalid_stage_graph', 'factory.yaml', '/stages', error.message);
      } else {
        throw error;
      }
    }
  }

  for (const resource of resources) {
    const doc = resource.doc as Record<string, unknown>;

    switch (resource.kind) {
      case 'agent':
      case 'automation':
      case 'scorer': {
        checkOne(resource.path, '/runner', doc.runner as string | undefined, runners, 'runner');
        checkList(resource.path, '/secrets', doc.secrets as string[] | undefined, secrets, 'secret');
        checkList(
          resource.path,
          '/mcpServers',
          doc.mcpServers as string[] | undefined,
          mcpServers,
          'MCP server',
        );
        if (resource.kind === 'agent') {
          // Per-agent MCP allow list (spec `mcp-integration` › unknown server).
          const mcp = doc.mcp as string[] | undefined;
          mcp?.forEach((server, index) => {
            if (!mcpServers.has(server)) {
              push(
                'unknown_mcp_server',
                resource.path,
                `/mcp/${index}`,
                `agent "${resource.name}" binds unknown MCP server "${server}"; declared servers: ${
                  declared.map((candidate) => candidate.name).join(', ') || 'none'
                }`,
              );
            }
          });
        }
        checkHarnessSecret(resource.path, doc.harness);
        if (resource.kind === 'automation') {
          checkOne(resource.path, '/agent', doc.agent as string | undefined, agents, 'agent');
        }
        if (resource.kind === 'agent') {
          checkList(
            resource.path,
            '/spawnableBy',
            doc.spawnableBy as string[] | undefined,
            agents,
            'agent',
          );
        }
        if (resource.kind === 'scorer') {
          checkList(resource.path, '/agents', doc.agents as string[] | undefined, agents, 'agent');
        }
        break;
      }
      case 'benchmark': {
        const suite = doc as BenchmarkSuite;
        checkOne(resource.path, '/agent', suite.agent, agents, 'agent');
        suite.configurations.forEach((configuration, configurationIndex) => {
          configuration.agents?.forEach((pin, pinIndex) => {
            checkOne(
              resource.path,
              `/configurations/${configurationIndex}/agents/${pinIndex}/agent`,
              pin.agent,
              agents,
              'agent',
            );
          });
        });

        const suiteDir = resource.path.split('/')[1];
        const prefix = `benchmarks/${suiteDir}/tasks/`;
        const available = new Set(
          resources
            .filter((candidate) => candidate.kind === 'benchmark-task')
            .filter((candidate) => candidate.path.startsWith(prefix))
            .map((candidate) => candidate.name.slice(suiteDir.length + 1)),
        );
        suite.tasks.forEach((task, index) => {
          if (!available.has(task)) {
            push(
              'benchmark_task_mismatch',
              resource.path,
              `/tasks/${index}`,
              `suite task "${task}" has no ${prefix}${task}.yaml`,
            );
          }
        });
        for (const task of available) {
          if (!suite.tasks.includes(task)) {
            push(
              'benchmark_task_mismatch',
              `${prefix}${task}.yaml`,
              '/',
              `task "${task}" is not listed in suite ${suiteDir}`,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }
}
