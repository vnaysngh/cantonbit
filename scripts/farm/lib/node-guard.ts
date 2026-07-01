/**
 * Fail-fast if the farm is running under a Node older than the project's
 * required major (see package.json "engines": ">=22"). Older Node (esp. v14,
 * which nvm may leave active in a stale shell) cannot parse tsx@4's `static {}`
 * class blocks, so every spawned child script (consolidation, refill,
 * party-balances) dies with a cryptic SyntaxError and an EMPTY error message —
 * a failure mode that already cost hours this project. A loud, explicit guard
 * turns that silent trap into an actionable message.
 */
const REQUIRED_MAJOR = 22;

export function assertNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < REQUIRED_MAJOR) {
    throw new Error(
      `Node ${process.versions.node} is too old — this farm requires Node >= ${REQUIRED_MAJOR}. ` +
        `Your shell defaulted to an old Node. Fix it with:\n` +
        `    nvm use ${REQUIRED_MAJOR}\n` +
        `  (or prefix the command: PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" npm run ...)\n` +
        `Running under old Node makes spawned sub-scripts (consolidation/refill) fail silently.`
    );
  }
}
