/**
 * 引擎单例与初始化状态。
 *
 * - 生产路径：静态导入 src/engine 的 createEngine。
 * - 开发路径：只有 `import.meta.env.DEV` 且 URL 带 `?demo` 时，动态引入
 *   src/ui/dev/fakeEngine（纯内存假引擎，仅用于无引擎时的界面自测）。
 *   生产构建中 import.meta.env.DEV 为 false，该分支被静态移除，不会引用 dev 模块。
 */
import { useCallback, useEffect, useState } from 'react';
import { createEngine } from '../engine';
import type { LibraryEngine } from '../engine/types';

interface EngineState {
  status: 'loading' | 'ready' | 'error';
  engine: LibraryEngine | null;
  error: Error | null;
}

let enginePromise: Promise<LibraryEngine> | null = null;

/** 仅开发环境 + `?demo` 时启用内存假引擎。 */
function isDemoRequest(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('demo');
  } catch {
    return false;
  }
}

/** 当前是否处于开发演示模式（DEV + ?demo，使用内存假引擎）。 */
export function isDemoMode(): boolean {
  return isDemoRequest();
}

/**
 * 动态加载开发用假引擎。
 * 注意：这里用运行时拼出的 URL（@vite-ignore）而不是静态 import 说明符，
 * 这样生产构建既不会把 dev 假引擎打进产物，也不会生成它的 chunk；
 * 而生产路径本身在 `import.meta.env.DEV === false` 时被静态移除。
 */
async function loadFakeEngine(): Promise<LibraryEngine> {
  // 用 BASE_URL 拼运行时 URL，避免 Vite 在构建期把 dev 模块当成静态依赖打进产物。
  const moduleUrl = `${import.meta.env.BASE_URL}src/ui/dev/fakeEngine.ts`;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as {
    createFakeEngine: () => Promise<LibraryEngine>;
  };
  return module.createFakeEngine();
}

function loadEngine(): Promise<LibraryEngine> {
  if (enginePromise) return enginePromise;
  const promise = import.meta.env.DEV && isDemoRequest() ? loadFakeEngine() : createEngine();
  enginePromise = promise.catch((error: unknown) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

export function resetEngine(): void {
  enginePromise = null;
}

export function useEngine(): EngineState & { retry: () => void } {
  const [state, setState] = useState<EngineState>({ status: 'loading', engine: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', engine: null, error: null });
    loadEngine()
      .then((engine) => {
        if (alive) setState({ status: 'ready', engine, error: null });
      })
      .catch((error: unknown) => {
        if (alive) {
          setState({
            status: 'error',
            engine: null,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    resetEngine();
    setAttempt((value) => value + 1);
  }, []);

  return { ...state, retry };
}
