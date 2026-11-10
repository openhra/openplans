/**
 * CMS Medicare plan files: www.cms.gov `/files/zip/` archives found on listing pages.
 * Discovery URLs never carry a query string (www.cms.gov robots: `Disallow: /*?`).
 */
export type MedicareFamily =
  "landscape" | "pbp" | "stars" | "crosswalk" | "service_area";
export const families: readonly MedicareFamily[] = [
  "landscape",
  "pbp",
  "stars",
  "crosswalk",
  "service_area",
];
export const host = "www.cms.gov";
const enrollment =
  "https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data";

export const sourceIds: Record<MedicareFamily, string> = {
  landscape: "cms-medicare-landscape",
  pbp: "cms-medicare-pbp",
  stars: "cms-medicare-stars",
  crosswalk: "cms-medicare-crosswalk",
  service_area: "cms-medicare-service-area",
};
export const pageSourceId = "cms-medicare-pages";

/** Per-archive caps: measured compressed sizes are 0.7-23.4 MB; PBP inflates to 263 MB. */
export const archiveLimits: Record<
  MedicareFamily,
  { maxBytes: number; maxUncompressedBytes: number; maxMembers: number }
> = {
  landscape: {
    maxBytes: 32 * 1024 ** 2,
    maxUncompressedBytes: 256 * 1024 ** 2,
    maxMembers: 16,
  },
  pbp: {
    maxBytes: 64 * 1024 ** 2,
    maxUncompressedBytes: 512 * 1024 ** 2,
    maxMembers: 400,
  },
  stars: {
    maxBytes: 16 * 1024 ** 2,
    maxUncompressedBytes: 64 * 1024 ** 2,
    maxMembers: 64,
  },
  crosswalk: {
    maxBytes: 16 * 1024 ** 2,
    maxUncompressedBytes: 32 * 1024 ** 2,
    maxMembers: 16,
  },
  service_area: {
    maxBytes: 16 * 1024 ** 2,
    maxUncompressedBytes: 128 * 1024 ** 2,
    maxMembers: 16,
  },
};

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Listing page that links the archive for a contract (or rating) year. */
export function discoveryPage(family: MedicareFamily, year: number): string {
  switch (family) {
    case "landscape":
      return "https://www.cms.gov/medicare/coverage/prescription-drug-coverage";
    case "pbp":
      return `${enrollment}/benefits-data/pbp-benefits-${year}`;
    case "stars":
      return "https://www.cms.gov/medicare/health-drug-plans/part-c-d-performance-data";
    case "crosswalk":
      return `${enrollment}/plan-crosswalks/${year}-part-cd-plan-crosswalk`;
    case "service_area":
      throw new Error(
        "Service-area listings paginate with query strings; name the report month",
      );
  }
}

export interface Archive {
  family: MedicareFamily;
  year: number;
  url: string;
  /** Release label as published in the file name (e.g. 202609, 2026-10). */
  label: string;
}

function archiveUrl(path: string): string | null {
  const url = new URL(path.replace(/&amp;/g, "&"), `https://${host}/`);
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/files\/zip\/[a-z0-9-]+\.zip$/.test(url.pathname)
  )
    return null;
  return url.href;
}

/** Picks the archive for `year` from a listing page; the newest revision wins. */
export function discoverArchive(
  family: MedicareFamily,
  year: number,
  html: string,
): Archive {
  const found: Archive[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+\.zip)["']/gi)) {
    const url = archiveUrl(match[1]!);
    if (!url) continue;
    const name = url.slice(url.lastIndexOf("/") + 1);
    let label: string | undefined;
    if (family === "landscape") {
      const m = new RegExp(`^cy${year}-landscape-(\\d{6})\\.zip$`).exec(name);
      label = m?.[1];
    } else if (family === "pbp") {
      if (name === `pbp-benefits-${year}.zip`) label = String(year);
    } else if (family === "stars") {
      const m = new RegExp(
        `^${year}-star-ratings-data-tables(?:-([a-z]{3}-\\d{1,2}-\\d{4}))?\\.zip$`,
      ).exec(name);
      if (m) label = m[1] ?? String(year);
    } else if (family === "crosswalk") {
      if (name === `plan-crosswalk-${year}.zip`) label = String(year);
    }
    if (label) found.push({ family, year, url, label });
  }
  found.sort((a, b) => b.label.localeCompare(a.label));
  if (!found[0])
    throw new Error(`No ${family} archive for ${year} on the CMS listing page`);
  return found[0];
}

/** Monthly contract service-area archive, e.g. `pdp`, 2026-10. */
export function serviceAreaArchive(kind: "ma" | "pdp", month: string): Archive {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const index = m ? Number(m[2]) - 1 : -1;
  if (!m || index < 0 || index > 11)
    throw new Error("Service-area month must be YYYY-MM");
  return {
    family: "service_area",
    year: Number(m[1]),
    url: `https://${host}/files/zip/${kind}-contract-service-area-state-county-${months[index]}-${m[1]}.zip`,
    label: `${kind}-${month}`,
  };
}

/** Release date from a label: 202609 -> 2026-09-01, oct-8-2026 -> 2026-10-08, pdp-2026-10 -> 2026-10-01. */
export function labelDate(label: string, fallback: string): string {
  let m = /^(\d{4})(\d{2})$/.exec(label);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /(\d{4})-(\d{2})$/.exec(label);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /^([a-z]{3})-(\d{1,2})-(\d{4})$/.exec(label);
  if (m) {
    const month = months.findIndex((name) => name.startsWith(m![1]!)) + 1;
    if (month > 0)
      return `${m[3]}-${String(month).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return fallback;
}

/** Recovers family, year and label from a cached archive's URL. */
export function parseArchiveUrl(value: string): Archive | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname !== host || url.search) return null;
  const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  let m = /^cy(\d{4})-landscape-(\d{6})\.zip$/.exec(name);
  if (m)
    return {
      family: "landscape",
      year: Number(m[1]),
      url: url.href,
      label: m[2]!,
    };
  m = /^pbp-benefits-(\d{4})\.zip$/.exec(name);
  if (m)
    return { family: "pbp", year: Number(m[1]), url: url.href, label: m[1]! };
  m =
    /^(\d{4})-star-ratings-data-tables(?:-([a-z]{3}-\d{1,2}-\d{4}))?\.zip$/.exec(
      name,
    );
  if (m)
    return {
      family: "stars",
      year: Number(m[1]),
      url: url.href,
      label: m[2] ?? m[1]!,
    };
  m = /^plan-crosswalk-(\d{4})\.zip$/.exec(name);
  if (m)
    return {
      family: "crosswalk",
      year: Number(m[1]),
      url: url.href,
      label: m[1]!,
    };
  m =
    /^(ma|pdp)-contract-service-area-state-county-([a-z]+)-(\d{4})\.zip$/.exec(
      name,
    );
  if (m) {
    const index = months.indexOf(m[2]!);
    if (index >= 0)
      return {
        family: "service_area",
        year: Number(m[3]),
        url: url.href,
        label: `${m[1]}-${m[3]}-${String(index + 1).padStart(2, "0")}`,
      };
  }
  return null;
}
