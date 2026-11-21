import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where the document states a tier its legend does not define: the label and the line itself. */
export const statedTierSchema = z.object({
  label: z.string().min(1),
  page: z.number().int().positive(),
  line: z.number().int().positive(),
  raw: z.string().min(1),
});
export type StatedTier = z.infer<typeof statedTierSchema>;

/**
 * The output of `formulary.py --feed` (src/ingest/carrier-documents): the drug rows with page,
 * line, raw lines and confidence, the document's own legend, and its cover.
 */
export const extractedFormularySchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.object({ pages: z.number().int().nonnegative() }),
  legend: z.object({
    tiers: z.record(z.string(), z.string()),
    flags: z.record(z.string(), z.string()),
    /**
     * Tiers the legend leaves out that the document's own text states (a heading, footnote or
     * tiering-table line naming the tier and its cost), with the line that states each one.
     */
    stated_tiers: z.record(z.string(), statedTierSchema),
  }),
  cover: z.object({
    plan_names: z.array(z.string()),
    plan_year: z.number().int().nullable(),
  }),
  rows: z.array(
    z.object({
      page: z.number().int().positive(),
      line: z.number().int().positive(),
      category: z.string().nullable(),
      name: z.string().min(1),
      tier: z.number().int(),
      tier_label: z.string().nullable(),
      flags: z.array(z.string()),
      ql_text: z.string(),
      raw: z.array(z.string()).min(1),
      confidence: z.enum(["high", "medium", "low"]),
      reasons: z.array(z.string()),
    }),
  ),
});
export type ExtractedFormulary = z.infer<typeof extractedFormularySchema>;
export type FormularyExtractor = (
  pdfPath: string,
) => Promise<ExtractedFormulary>;

/**
 * The extractor in a source checkout. `dist/` and `src/` both sit one level below the package
 * root, so the same relative path works from either.
 */
export const DEFAULT_EXTRACTOR = fileURLToPath(
  new URL(
    "../../../src/ingest/carrier-documents/formulary.py",
    import.meta.url,
  ),
);
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
const EXTRACT_MAX_OUTPUT = 512 * 1024 * 1024;

/**
 * Runs the Python extractor (standard library plus Poppler's `pdftotext`, an operator
 * prerequisite like the VT rate preparation; the API image has neither). Any failure, including
 * a missing Poppler, rejects, and the core turns it into `stage_failed`.
 */
export function pythonExtractor(
  script = DEFAULT_EXTRACTOR,
  python = "python3",
  pdftotext?: string,
): FormularyExtractor {
  return (pdfPath) =>
    new Promise((resolve, reject) => {
      execFile(
        python,
        ["-B", script, "--feed", pdfPath],
        {
          encoding: "utf8",
          timeout: EXTRACT_TIMEOUT_MS,
          maxBuffer: EXTRACT_MAX_OUTPUT,
          // Only what the extractor needs: PATH to find Python and Poppler, never other settings.
          env: {
            PATH: process.env.PATH ?? "",
            PYTHONDONTWRITEBYTECODE: "1",
            ...(pdftotext ? { OPENPLANS_PDFTOTEXT: pdftotext } : {}),
          },
        },
        (error, stdout) => {
          if (error) return reject(new Error("formulary extraction failed"));
          try {
            resolve(extractedFormularySchema.parse(JSON.parse(stdout)));
          } catch {
            reject(new Error("formulary extraction output is invalid"));
          }
        },
      );
    });
}
