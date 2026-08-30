import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误边界
 * ------------
 * 捕获子树渲染期 / 生命周期内的未处理异常, 展示降级 UI 并提供恢复入口,
 * 避免单个面板崩溃导致整个 SPA 白屏。事件回调 / 异步任务中的异常
 * 不经过 React 渲染管线, 仍需各调用点自行 catch (本项目已在 api.ts /
 * 各面板的 async 守卫中处理)。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 组件渲染异常:', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center">
        <h1 className="text-xl font-semibold text-slate-800">
          页面出现意外错误
        </h1>
        <p className="max-w-md text-sm text-slate-500">
          {error.message || '未知错误'}
          <br />
          可以尝试重置界面; 若反复出现, 请刷新页面或查看浏览器控制台详情。
        </p>
        <div className="flex gap-3">
          <button
            onClick={this.handleReset}
            className="rounded-md bg-slate-700 px-4 py-2 text-sm text-white hover:bg-slate-600"
          >
            重试渲染
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
