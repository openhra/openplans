import type { SpufChannel } from "./spuf.js";

/**
 * Dispensing-fee ranges from the Part D pharmacy networks file. The file has one row per plan and
 * pharmacy; only the lowest and highest fee per plan, channel, area, fee type and days supply are
 * kept, never the pharmacy rows. A fee of `.` or blank is missing and is counted, never read as 0.
 */

export const feeDaysSupplies = [30, 60, 90] as const;
export type FeeDaysSupply = (typeof feeDaysSupplies)[number];
export const feeTypes = ["brand", "generic", "selected"] as const;
export type FeeType = (typeof feeTypes)[number];

/**
 * Header spellings per fee type. The 2026 record layout names the selected-drug fee
 * `SELECTED_DRUG_DISPENSING_FEE_*`; the published data files spell it `SELECTED_DISPENSING_FEE_*`.
 * Either is accepted; a header with both or neither is rejected.
 */
export const feeColumnAliases: Record<
  FeeType,
  (days: FeeDaysSupply) => string[]
> = {
  brand: (days) => [`BRAND_DISPENSING_FEE_${days}`],
  generic: (days) => [`GENERIC_DISPENSING_FEE_${days}`],
  selected: (days) => [
    `SELECTED_DISPENSING_FEE_${days}`,
    `SELECTED_DRUG_DISPENSING_FEE_${days}`,
  ],
};
export const feeFlagColumns = [
  "PREFERRED_STATUS_RETAIL",
  "PREFERRED_STATUS_MAIL",
  "PHARMACY_RETAIL",
  "PHARMACY_MAIL",
  "IN_AREA_FLAG",
  "FLOOR_PRICE",
] as const;

/** Column name per fee type and days supply in one header. */
export type FeeColumns = Record<FeeType, Record<FeeDaysSupply, string>>;

export function resolveFeeColumns(header: readonly string[]): FeeColumns {
  const present = new Set(header);
  const out = {} as FeeColumns;
  for (const type of feeTypes) {
    out[type] = {} as Record<FeeDaysSupply, string>;
    for (const days of feeDaysSupplies) {
      const found = feeColumnAliases[type](days).filter((name) =>
        present.has(name),
      );
      if (found.length !== 1)
        throw new Error(
          `Part D dispensing_fee header lacks one ${type} fee column for ${days} days`,
        );
      out[type][days] = found[0]!;
    }
  }
  return out;
}

/** Ten-thousandths of a dollar from a 9(8.4) cell; null for `.` or blank. */
export function parseFeeAmount(value: string, name: string): number | null {
  if (value === "." || value === "") return null;
  const match = /^(\d{1,8})?(?:\.(\d{1,4}))?$/.exec(value);
  if (!match || (match[1] === undefined && match[2] === undefined))
    throw new Error(`Part D ${name} is not a 9(8.4) amount`);
  return (
    Number(match[1] ?? "0") * 10_000 + Number((match[2] ?? "").padEnd(4, "0"))
  );
}

/** numeric(12,4) text for a ten-thousandths amount. */
export function formatFeeAmount(tenThousandths: number): string {
  const whole = Math.floor(tenThousandths / 10_000);
  return `${whole}.${String(tenThousandths % 10_000).padStart(4, "0")}`;
}

function strictYn(value: string | undefined, name: string): boolean {
  if (value === "Y") return true;
  if (value === "N") return false;
  throw new Error(`Part D ${name} is not Y/N`);
}

/** Channels a pharmacy row serves: retail and mail flags with their own preferred status. */
export function pharmacyChannels(
  values: Record<string, string>,
): SpufChannel[] {
  const out: SpufChannel[] = [];
  if (strictYn(values.PHARMACY_RETAIL, "PHARMACY_RETAIL"))
    out.push(
      strictYn(values.PREFERRED_STATUS_RETAIL, "PREFERRED_STATUS_RETAIL")
        ? "preferred_retail"
        : "standard_retail",
    );
  if (strictYn(values.PHARMACY_MAIL, "PHARMACY_MAIL"))
    out.push(
      strictYn(values.PREFERRED_STATUS_MAIL, "PREFERRED_STATUS_MAIL")
        ? "preferred_mail"
        : "standard_mail",
    );
  return out;
}

export function inAreaFlag(value: string | undefined): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error("Part D IN_AREA_FLAG is not 0/1");
}

export interface FeeRange {
  channel: SpufChannel;
  in_area: boolean;
  fee_type: FeeType;
  days_supply: FeeDaysSupply;
  pharmacies: number;
  fees_readable: number;
  fees_missing: number;
  min_fee: number | null;
  max_fee: number | null;
  max_floor_price: number | null;
  floors_missing: number;
}

/**
 * Accumulates one plan's ranges. Memory grows with the number of (channel, area, type, days)
 * groups, at most 72 per plan, not with the number of pharmacies.
 */
export class PlanFeeRanges {
  private readonly groups = new Map<string, FeeRange>();
  pharmacyRows = 0;

  add(values: Record<string, string>, columns: FeeColumns): void {
    this.pharmacyRows++;
    const inArea = inAreaFlag(values.IN_AREA_FLAG);
    const floor = parseFeeAmount(values.FLOOR_PRICE ?? "", "FLOOR_PRICE");
    const channels = pharmacyChannels(values);
    for (const type of feeTypes)
      for (const days of feeDaysSupplies) {
        const column = columns[type][days];
        const fee = parseFeeAmount(values[column] ?? "", column);
        for (const channel of channels) {
          const id = `${channel}|${inArea}|${type}|${days}`;
          let group = this.groups.get(id);
          if (!group) {
            group = {
              channel,
              in_area: inArea,
              fee_type: type,
              days_supply: days,
              pharmacies: 0,
              fees_readable: 0,
              fees_missing: 0,
              min_fee: null,
              max_fee: null,
              max_floor_price: null,
              floors_missing: 0,
            };
            this.groups.set(id, group);
          }
          group.pharmacies++;
          if (fee === null) group.fees_missing++;
          else {
            group.fees_readable++;
            group.min_fee =
              group.min_fee === null ? fee : Math.min(group.min_fee, fee);
            group.max_fee =
              group.max_fee === null ? fee : Math.max(group.max_fee, fee);
          }
          if (floor === null) group.floors_missing++;
          else
            group.max_floor_price =
              group.max_floor_price === null
                ? floor
                : Math.max(group.max_floor_price, floor);
        }
      }
  }

  ranges(): FeeRange[] {
    return [...this.groups.values()];
  }
}
