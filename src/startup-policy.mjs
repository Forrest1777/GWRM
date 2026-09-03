export function supervisorStartupTimeoutMs(config, stateFileCount = 0) {
  const count = Number.isInteger(stateFileCount) && stateFileCount > 0 ? stateFileCount : 0;
  const shutdownSeconds = Number(config?.service?.shutdownTimeoutSeconds) || 0;

  // Startup reconciliation may need to stop stale runtimes one state at a time.
  // Keep a reasonable floor for normal startup, add bounded cleanup budget per
  // persisted state, and retain an absolute ceiling so launcher failure is finite.
  const minimumMs = 60_000;
  const baseReconciliationMs = 30_000;
  const perStateCleanupMs = Math.max(5_000, (shutdownSeconds + 5) * 1_000);
  const reconciliationMs = baseReconciliationMs + (count * perStateCleanupMs);

  return Math.min(600_000, Math.max(minimumMs, reconciliationMs));
}
