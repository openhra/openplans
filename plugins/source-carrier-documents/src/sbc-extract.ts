import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const chartRow = z.object({
  label: z.string().nullable(),
  sub_label: z.string().nullable(),
  match: z.enum(["exact", "tier_suffix", "sub_row"]).nullable(),
  label_text: z.string(),
  matched: z.boolean(),
  page: z.number().int().positive(),
  event: z.string().nullable(),
  network: z.string(),
  out_of_network: z.string(),
  limitations: z.string(),
  raw: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  reasons: z.array(z.string()),
});
const questionRow = z.object({
  label: z.string().nullable(),
  label_text: z.string(),
  matched: z.boolean(),
  page: z.number().int().positive(),
  answer: z.string(),
  raw: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
});

/**
 * The output of `sbc.py --feed` (src/ingest/carrier-documents): the Important Questions answers
 * and the cost-sharing chart rebuilt from word coordinates, with page, raw lines and confidence,
 * plus the coverage period and plan name printed in the header.
 */
export const extractedSbcSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pages: z.number().int().nonnegative(),
  coverage_period: z
    .object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      plan_year: z.number().int().nullable(),
    })
    .nullable(),
  plan_name: z.string().nullable(),
  questions: z.array(questionRow),
  chart: z.array(chartRow),
  missing_services: z.array(z.string()),
});
export type ExtractedSbc = z.infer<typeof extractedSbcSchema>;
export type SbcExtractor = (pdfPath: string) => Promise<ExtractedSbc>;

/** The SBC extractor in a source checkout (see `DEFAULT_EXTRACTOR`). */
export const DEFAULT_SBC_EXTRACTOR = fileURLToPath(
  new URL("../../../src/ingest/carrier-documents/sbc.py", import.meta.url),
);
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
const EXTRACT_MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Runs `sbc.py --feed` (standard library plus Poppler's `pdftotext`, an operator prerequisite).
 * Any failure rejects, and the core turns it into `stage_failed`.
 */
export function pythonSbcExtractor(
  script = DEFAULT_SBC_EXTRACTOR,
  python = "python3",
  pdftotext?: string,
): SbcExtractor {
  return (pdfPath) =>
    new Promise((resolve, reject) => {
      execFile(
        python,
        ["-B", script, "--feed", pdfPath],
        {
          encoding: "utf8",
          timeout: EXTRACT_TIMEOUT_MS,
          maxBuffer: EXTRACT_MAX_OUTPUT,
          env: {
            PATH: process.env.PATH ?? "",
            PYTHONDONTWRITEBYTECODE: "1",
            ...(pdftotext ? { OPENPLANS_PDFTOTEXT: pdftotext } : {}),
          },
        },
        (error, stdout) => {
          if (error) return reject(new Error("SBC extraction failed"));
          try {
            resolve(extractedSbcSchema.parse(JSON.parse(stdout)));
          } catch {
            reject(new Error("SBC extraction output is invalid"));
          }
        },
      );
    });
}
