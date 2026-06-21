/** Run mutating daemon phases serially, but attempt every phase before failing. */
export async function runDaemonPhases(
  phases: ReadonlyArray<readonly [label: string, phase: () => Promise<void>]>
): Promise<void> {
  const failures: string[] = [];
  for (const [label, phase] of phases) {
    try {
      await phase();
    } catch (e) {
      failures.push(
        `${label}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}
