import { ToolError } from "./cursor.js";

export const DEFAULT_OUTPUT_BYTES = 64 * 1024;

export function serializedBytes(value: unknown, reserve = 0): number {
  return Buffer.byteLength(JSON.stringify(value)) + reserve;
}

/** Serialize the payload once; substitute its byte length into the measured envelope. */
export function measuredToolResult<T>(value: T, reserve = 0) {
  const text = JSON.stringify(value);
  const answer = {
    content: [{ type: "text" as const, text }],
    structuredContent: value,
  };
  const bytes =
    serializedBytes({ ...answer, structuredContent: null }, reserve) +
    Buffer.byteLength(text) -
    4; // Replace the four bytes of null with the already serialized payload.
  return { answer, bytes };
}

export interface OutputBudget<T> {
  maxBytes?: number;
  /** Include the transport envelope, duplicate text and framing when applicable. */
  measure?: (value: T) => number;
}

export function fitsOutput<T>(
  value: T,
  {
    maxBytes = DEFAULT_OUTPUT_BYTES,
    measure = serializedBytes,
  }: OutputBudget<T> = {},
): boolean {
  return measure(value) <= maxBytes;
}

export function outputSizeError(): ToolError {
  return new ToolError("result_too_large");
}

export function assertOutputCount(count: number, maximum: number): void {
  if (count > maximum) throw outputSizeError();
}

export function assertOutputFits<T>(value: T, budget?: OutputBudget<T>): void {
  if (!fitsOutput(value, budget)) throw outputSizeError();
}

interface RowGroup {
  rows: unknown[];
  minimum?: number;
  onOmit?: () => void;
}

/** Remove complete tail rows in group order; recompute evidence and cursors before measuring. */
export function boundOutput<T>(
  value: T,
  options: OutputBudget<T> & {
    groups: RowGroup[];
    complete?: (omitted: number) => void;
    withinLimits?: () => boolean;
  },
): { output: T; omitted: number } {
  let omitted = 0;
  options.complete?.(omitted);
  while (!fitsOutput(value, options) || options.withinLimits?.() === false) {
    const group = options.groups.find(
      ({ rows, minimum = 0 }) => rows.length > minimum,
    );
    if (!group) throw outputSizeError();
    group.rows.pop();
    group.onOmit?.();
    omitted++;
    options.complete?.(omitted);
  }
  return { output: value, omitted };
}
