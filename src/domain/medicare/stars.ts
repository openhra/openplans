export type StarStatus =
  "rated" | "too_new" | "not_enough_data" | "not_applicable" | "unknown";
export interface StarCell {
  status: StarStatus;
  stars: number | null;
}

/** Star cells are half-star numbers or one of the published status phrases. */
export function parseStars(value: string | undefined): StarCell {
  const text = (value ?? "").trim();
  if (/^[1-5](?:\.[05])?$/.test(text))
    return { status: "rated", stars: Number(text) };
  if (/^plan too new to be measured$/i.test(text))
    return { status: "too_new", stars: null };
  if (/^not enough data available$/i.test(text))
    return { status: "not_enough_data", stars: null };
  if (/^not applicable$/i.test(text))
    return { status: "not_applicable", stars: null };
  return { status: "unknown", stars: null };
}
