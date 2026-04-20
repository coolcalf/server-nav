/**
 * Next.js Instrumentation Hook
 * 服务器启动时自动执行，用于启动后台任务。
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // 仅在 Node.js runtime 执行（排除 Edge）
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureAgentPush, isAgent } = await import("@/lib/federation");
    const { ensureHostMonitor } = await import("@/lib/host-monitor");
    const { ensureHealthMonitor } = await import("@/lib/health-monitor");

    // 启动本地监控（host + service health）
    ensureHostMonitor();
    ensureHealthMonitor();

    // agent 模式：启动向 master 的定时推送
    if (isAgent()) {
      ensureAgentPush();
    }
  }
}
