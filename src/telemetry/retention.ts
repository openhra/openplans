export const HOUR = 60 * 60 * 1000;
export const SEVEN_DAYS = 7 * 24 * HOUR;
export const NINETY_DAYS = 90 * 24 * HOUR;
export const STORAGE_CAP_BYTES = 256 * 1024 * 1024;
// Includes bounded labels, histogram, provenance, tuple and index allocation per live row.
export const STORED_ROW_BYTES = 2048;
export const PENDING_BUCKET_CAP = 2;
export function alignedBucket(time: number, width: number): Date {
  return new Date(Math.floor(time / width) * width);
}
