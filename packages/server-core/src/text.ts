import path from 'node:path';

/** Sorted offsets of line starts, for offset -> line/column conversion. */
export function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (code.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 1-based line and column for a UTF-16 offset. */
export function positionAt(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

/** `file` relative to `root`, with forward slashes. */
export function toRel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
