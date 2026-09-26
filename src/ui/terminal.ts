import { cursor } from "./ansi.ts";

type Restore = () => void;

const restores = new Set<Restore>();
let installed = false;

/**
 * Registers a terminal-state restore (raw mode, cursor, bracketed paste) that
 * runs on every exit path, including signals and an uncaught exception.
 * Returns an unregister function for the normal path.
 */
export function registerTerminalRestore(restore: Restore): () => void {
  restores.add(restore);
  install();
  return () => restores.delete(restore);
}

/** Restores raw mode, bracketed paste and the cursor. Safe to call repeatedly. */
export function restoreTerminal(): void {
  for (const restore of [...restores]) {
    try {
      restore();
    } catch {
      // Restoring must never throw; the terminal is already in a bad state.
    }
  }
  if (process.stdout.isTTY) {
    try {
      process.stdout.write(`${cursor.show()}\u001b[?2004l`);
    } catch {
      // stdout may be gone
    }
  }
}

function install(): void {
  if (installed) return;
  installed = true;

  // A normal return or process.exit() still runs 'exit' listeners.
  process.on("exit", restoreTerminal);

  // A signal with default handling terminates without emitting 'exit', which is
  // how a Ctrl+C during a live session used to leave the terminal in raw mode.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      restoreTerminal();
      // Another listener (an in-flight turn cancelling itself) owns shutdown;
      // only exit here when nothing else is listening.
      if (process.listenerCount(signal) <= 1) {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
    });
  }
}
