/**
 * Sentinel markers used by the agent-runner container to wrap JSON output
 * chunks so the host can stream-parse them out of noisy stdout.
 *
 * The values here MUST stay in sync with container/agent-runner/src/index.ts.
 */

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isThinking?: boolean;
  isKeepalive?: boolean;
}

/**
 * Scan `buffer` for marker pairs, invoking `onChunk` for every complete pair
 * and `onError` for any that fail to parse. Returns the remaining buffer
 * (with consumed pairs sliced off). Incomplete trailing pairs stay in the
 * buffer so the caller can accumulate more stdout and scan again.
 */
export function parseOutputMarkers(
  buffer: string,
  onChunk: (parsed: ContainerOutput) => void,
  onError?: (err: unknown) => void,
): string {
  let b = buffer;
  let startIdx: number;
  while ((startIdx = b.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = b.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break;
    const jsonStr = b
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    b = b.slice(endIdx + OUTPUT_END_MARKER.length);
    try {
      onChunk(JSON.parse(jsonStr) as ContainerOutput);
    } catch (err) {
      onError?.(err);
    }
  }
  return b;
}
