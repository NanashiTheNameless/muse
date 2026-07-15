import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

describe('GitHub test workflow', () => {
  it('tests the exact minimum Node version and rolling Node 24', async () => {
    const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
    const matrixValues = workflow.match(/matrix:\s*\n\s+node-version:\s*\[([^\]]+)\]/u)?.[1]
      .split(',')
      .map(value => value.trim().replaceAll(/["']/g, ''));

    expect(matrixValues).toEqual(['24.15.0', '24']);
    expect(workflow).toContain('node-version: ${{ matrix.node-version }}');
  });

  it('activates Yarn 4 via Corepack before installing', async () => {
    const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');

    // setup-node's `cache: yarn` invokes the preinstalled Yarn 1 before
    // Corepack runs, which fails on a packageManager: yarn@4 project.
    expect(workflow).not.toContain("cache: 'yarn'");
    expect(workflow).toContain('corepack enable');
    expect(workflow).toContain('corepack prepare yarn@4.14.1 --activate');
    expect(workflow.indexOf('corepack enable')).toBeLessThan(workflow.indexOf('yarn install'));
    expect(workflow).toContain('yarn install --immutable');
  });
});
