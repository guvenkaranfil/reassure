import * as React from 'react';
import type { ReactTestRendererJSON, ReactTestRendererNode } from 'react-test-renderer';
import * as R from 'remeda';
import * as logger from '@callstack/reassure-logger';
import { config } from './config';
import { RunResult, processRunResults } from './measure-helpers';
import { showFlagsOutputIfNeeded, writeTestStats } from './output';
import { resolveTestingLibrary, getTestingLibrary } from './testing-library';
import type { MeasureRendersResults } from './types';

logger.configure({
  verbose: process.env.REASSURE_VERBOSE === 'true' || process.env.REASSURE_VERBOSE === '1',
  silent: process.env.REASSURE_SILENT === 'true' || process.env.REASSURE_SILENT === '1',
});

export interface MeasureRendersOptions {
  runs?: number;
  warmupRuns?: number;
  wrapper?: React.ComponentType<{ children: React.ReactElement }>;
  scenario?: (screen: any) => Promise<any>;
  writeFile?: boolean;
}

export async function measureRenders(
  ui: React.ReactElement,
  options?: MeasureRendersOptions
): Promise<MeasureRendersResults> {
  const stats = await measureRendersInternal(ui, options);

  if (options?.writeFile !== false) {
    await writeTestStats(stats, 'render');
  }

  return stats;
}

/**
 * @deprecated The `measurePerformance` function has been renamed to `measureRenders`. The `measurePerformance` alias is now deprecated and will be removed in future releases.
 */
export async function measurePerformance(
  ui: React.ReactElement,
  options?: MeasureRendersOptions
): Promise<MeasureRendersResults> {
  logger.warnOnce(
    'The `measurePerformance` function has been renamed to `measureRenders`.\n\nThe `measurePerformance` alias is now deprecated and will be removed in future releases.'
  );

  return await measureRenders(ui, options);
}

async function measureRendersInternal(
  ui: React.ReactElement,
  options?: MeasureRendersOptions
): Promise<MeasureRendersResults> {
  const runs = options?.runs ?? config.runs;
  const scenario = options?.scenario;
  const warmupRuns = options?.warmupRuns ?? config.warmupRuns;

  const { render, cleanup } = resolveTestingLibrary();
  const testingLibrary = getTestingLibrary();

  showFlagsOutputIfNeeded();

  const runResults: RunResult[] = [];
  let hasTooLateRender = false;
  let renderJsonTrees: ToJsonTree[] = [];

  for (let i = 0; i < runs + warmupRuns; i += 1) {
    let duration = 0;
    let count = 0;
    let isFinished = false;

    let renderResult: any = null;

    const captureJsonTree = () => {
      if (testingLibrary === 'react-native' && i === 0) {
        renderJsonTrees.push(renderResult?.toJSON() ?? null);
      }
    };

    const handleRender = (_id: string, _phase: string, actualDuration: number) => {
      captureJsonTree();

      duration += actualDuration;
      count += 1;

      if (isFinished) {
        hasTooLateRender = true;
      }
    };

    const uiToRender = buildUiToRender(ui, handleRender, options?.wrapper);
    renderResult = render(uiToRender);
    captureJsonTree();

    if (scenario) {
      await scenario(renderResult);
    }

    cleanup();

    isFinished = true;
    global.gc?.();

    runResults.push({ duration, count });
  }

  if (hasTooLateRender) {
    const testName = expect.getState().currentTestName;
    logger.warn(
      `test "${testName}" still re-renders after test scenario finished.\n\nPlease update your code to wait for all renders to finish.`
    );
  }

  const initialRenderTrees = renderJsonTrees.filter((tree) => tree === null);
  const regularRenderTrees = renderJsonTrees.filter((tree) => tree !== null);

  return {
    ...processRunResults(runResults, warmupRuns),
    redundantRenders: {
      initial: initialRenderTrees.length - 1,
      update: detectRedundantUpdates(regularRenderTrees).length,
    },
  };
}

export function buildUiToRender(
  ui: React.ReactElement,
  onRender: React.ProfilerOnRenderCallback,
  Wrapper?: React.ComponentType<{ children: React.ReactElement }>
) {
  const uiWithProfiler = (
    <React.Profiler id="REASSURE_ROOT" onRender={onRender}>
      {ui}
    </React.Profiler>
  );

  return Wrapper ? <Wrapper>{uiWithProfiler}</Wrapper> : uiWithProfiler;
}

export type ToJsonTree = ReactTestRendererJSON | ReactTestRendererJSON[] | null;

export function isJsonTreeEqual(a: ToJsonTree | null, b: ToJsonTree | null): boolean {
  return R.isDeepEqual(a, b);
}

export function detectRedundantUpdates(components: ToJsonTree[]): number[] {
  const result = [];

  for (let i = 1; i < components.length; i += 1) {
    if (isJsonTreeEqual(components[i], components[i - 1])) {
      result.push(i);
    }
  }

  return result;
}
