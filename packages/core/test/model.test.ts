import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectModelRefSites,
  isEnvModelRef,
  loadDefinition,
  loadOrThrow,
  modelEnvName,
  resolveModelRef,
  resolveStageConfigs,
  compileStageGraph,
  stageDeclarationsFromDefinition,
  type AgentDef,
} from '../src/index';
import { EXAMPLE, tempDir } from './helpers';

const ENV = {
  FACTORY_MODEL: 'best_llm',
  FACTORY_SMALL_MODEL: 'small',
  FACTORY_REVIEW_MODEL: 'review',
};

describe('model references (ADR-028)', () => {
  it('uses a literal verbatim and never looks it up', () => {
    const resolved = resolveModelRef('openai/gpt-5', {});
    expect(resolved).toEqual({ ref: 'openai/gpt-5', value: 'openai/gpt-5', source: 'literal' });
    expect(isEnvModelRef('openai/gpt-5')).toBe(false);
    expect(modelEnvName('openai/gpt-5')).toBeNull();
  });

  it('resolves env:NAME from the given environment', () => {
    const resolved = resolveModelRef('env:FACTORY_MODEL', ENV);
    expect(resolved).toEqual({
      ref: 'env:FACTORY_MODEL',
      value: 'best_llm',
      source: 'env',
    });
    expect(isEnvModelRef('env:FACTORY_MODEL')).toBe(true);
    expect(modelEnvName('env:FACTORY_MODEL')).toBe('FACTORY_MODEL');
  });

  it('reports an unset env reference as a non-fatal warning', () => {
    const { definition, errors, warnings } = loadDefinition(EXAMPLE, { env: {} });
    expect(errors).toEqual([]);
    expect(definition).not.toBeNull();
    const unresolved = warnings.filter((warning) => warning.code === 'model_env_unresolved');
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved[0]?.message).toContain('FACTORY_MODEL');
    expect(unresolved.every((warning) => warning.file.endsWith('agent.md') || warning.file === 'factory.yaml' || warning.file === 'routing.yaml')).toBe(true);
  });

  it('does not warn when every referenced variable is set', () => {
    const { warnings } = loadDefinition(EXAMPLE, { env: ENV });
    expect(warnings.filter((warning) => warning.code === 'model_env_unresolved')).toEqual([]);
  });

  it('resolves every model site in a definition, with file + pointer', () => {
    const definition = loadOrThrow(EXAMPLE);
    const sites = collectModelRefSites([
      { file: 'factory.yaml', doc: definition.manifest },
      ...definition.resources.map((resource) => ({ file: resource.path, doc: resource.doc })),
    ]);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((site) => site.file === 'factory.yaml' && site.pointer === '/agentDefaults/harness/model')).toBe(true);
    expect(sites.some((site) => site.file === 'agents/foreman/agent.md' && site.pointer === '/harness/model')).toBe(true);
    expect(sites.filter((site) => site.ref.startsWith('env:')).length).toBeGreaterThan(0);
  });

  it('rejects env: without a valid variable name as invalid_value', () => {
    const invalid = ['env:', 'env:lowercase', 'env:1LEADING', 'env:FACTORY-MODEL', 'env:FACTORY MODEL'];
    for (const ref of invalid) {
      const dir = tempDir();
      writeFileSync(
        join(dir, 'factory.yaml'),
        [
          'schemaVersion: v1alpha1',
          'name: model-fixture',
          'repositories:',
          '  - owner: acme',
          '    name: api',
          'agentDefaults:',
          `  model: "${ref}"`,
          'gates:',
          '  spec: human',
          'mergePolicy: human',
          '',
        ].join('\n'),
      );
      const { errors } = loadDefinition(dir, { env: ENV });
      expect(errors.map((error) => error.code)).toContain('invalid_value');
      expect(errors.some((error) => error.pointer === '/agentDefaults/model')).toBe(true);
    }

    // `harness.model` is a model declaration too.
    const dir = tempDir();
    writeFileSync(
      join(dir, 'factory.yaml'),
      [
        'schemaVersion: v1alpha1',
        'name: model-fixture',
        'repositories:',
        '  - owner: acme',
        '    name: api',
        'agentDefaults:',
        '  harness:',
        '    type: opencode',
        '    model: env:lowercase',
        'gates:',
        '  spec: human',
        'mergePolicy: human',
        '',
      ].join('\n'),
    );
    const { errors } = loadDefinition(dir, { env: ENV });
    expect(errors.map((error) => error.code)).toContain('invalid_value');
    expect(errors.some((error) => error.pointer === '/agentDefaults/harness/model')).toBe(true);
  });

  it('resolves the stage config model to the env value', () => {
    const definition = loadOrThrow(EXAMPLE);
    const agents = definition.resources
      .filter((resource) => resource.kind === 'agent')
      .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
    const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
    const configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      env: ENV,
    });
    expect(configs.triage.model).toBe('small');
    expect(configs.review.model).toBe('review');
    expect(configs.implement.model).toBe('best_llm');
  });

  it('leaves the model null when the reference is unset', () => {
    const definition = loadOrThrow(EXAMPLE);
    const agents = definition.resources
      .filter((resource) => resource.kind === 'agent')
      .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
    const graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
    const configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      env: {},
    });
    expect(configs.triage.model).toBeNull();
    expect(configs.triage.modelRef).toEqual({
      ref: 'env:FACTORY_SMALL_MODEL',
      value: null,
      source: 'env',
    });
  });
});
