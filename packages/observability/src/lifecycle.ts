/**
 * Process lifecycle for Cloud Run services.
 *
 * - SIGTERM/SIGINT: run the shutdown steps once (stop accepting work, drain, close pools)
 *   and exit 0. Cloud Run allows ~10 s after SIGTERM, so steps are bounded by `timeoutMs`.
 * - uncaughtException: the process state is unknown — log, attempt the same cleanup, exit 1
 *   so the platform restarts a clean instance instead of serving from a corrupted one.
 * - unhandledRejection: logged at error level (not fatal) to match current behaviour.
 */
export type ShutdownStep = { name: string; run: () => Promise<unknown> | unknown };

type LifecycleLogger = {
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

type ProcessLike = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit: (code: number) => void;
};

export type LifecycleOptions = {
  service: string;
  steps: ShutdownStep[];
  logger: LifecycleLogger;
  timeoutMs?: number;
  proc?: ProcessLike;
};

export function installProcessLifecycle(opts: LifecycleOptions) {
  const proc = opts.proc ?? (process as unknown as ProcessLike);
  const timeoutMs = opts.timeoutMs ?? 8000;
  let shuttingDown: Promise<void> | null = null;

  async function runSteps() {
    for (const step of opts.steps) {
      try {
        await step.run();
      } catch (err) {
        opts.logger.error({ err, step: step.name }, "shutdown step failed");
      }
    }
  }

  function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return shuttingDown;
    opts.logger.info({ reason, service: opts.service }, "shutting down");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    shuttingDown = Promise.race([runSteps().then(() => "done" as const), deadline]).then(
      (outcome) => {
        if (timer) clearTimeout(timer);
        if (outcome === "timeout") {
          opts.logger.error({ timeoutMs, service: opts.service }, "shutdown timed out");
        }
        proc.exit(exitCode);
      },
    );
    return shuttingDown;
  }

  proc.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  proc.on("SIGINT", () => void shutdown("SIGINT", 0));
  proc.on("uncaughtException", (err) => {
    opts.logger.error({ err, service: opts.service }, "uncaughtException — exiting");
    void shutdown("uncaughtException", 1);
  });
  proc.on("unhandledRejection", (reason) => {
    opts.logger.error({ err: reason, service: opts.service }, "unhandledRejection");
  });

  return { shutdown };
}
