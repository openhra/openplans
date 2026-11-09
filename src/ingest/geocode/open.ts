import type { Address } from "./address.js";
import type { County } from "./counties.js";
import { countyAt, insideBounds } from "./counties.js";
import { normalizeAddress } from "./normalize.js";
import { geocoderJson } from "./operator.js";
import type { Geocoder } from "./operator.js";

export const openAttribution = "© OpenStreetMap contributors";
export const openLicence = "ODbL-1.0";
export const openImportProfile = "nominatim-address-v1";
export interface OpenDataset {
  sha256: string;
  index_sha256: string;
  import_profile: typeof openImportProfile;
  data_date: string;
  state: "TX" | "FL" | "NC";
}
export interface OpenPoint extends OpenDataset {
  latitude: number;
  longitude: number;
  county_fips: string;
  bounds_snapshot_id: string;
  source: "open_geocoder";
  licence: typeof openLicence;
  attribution: typeof openAttribution;
  as_of: string;
  osm_type: string;
  osm_id: string;
  precision: "osm_address";
  matched_address: { house_number: string; road: string; postcode: string };
}
export interface OpenGeocoder extends Geocoder<OpenPoint> {
  dataset: OpenDataset;
}
export function assertOpenAttribution(readme: string): void {
  if (
    !readme.includes(openAttribution) ||
    !readme.includes(openLicence) ||
    !readme.includes("https://www.openstreetmap.org/copyright")
  )
    throw new Error("Open geocoder attribution missing from README");
}
export function validateOpenDataset(dataset: OpenDataset): void {
  if (
    !/^[a-f0-9]{64}$/.test(dataset.sha256) ||
    !/^[a-f0-9]{64}$/.test(dataset.index_sha256) ||
    dataset.import_profile !== openImportProfile ||
    !["TX", "FL", "NC"].includes(dataset.state) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dataset.data_date) ||
    !Number.isFinite(Date.parse(dataset.data_date)) ||
    new Date(dataset.data_date).toISOString().slice(0, 10) !== dataset.data_date
  )
    throw new Error("Invalid open geocoder dataset");
}
function nominatimUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/search"].includes(url.pathname)
  )
    throw new Error("Open geocoder requires a loopback Nominatim URL");
  return url;
}
export async function assertOpenServerDate(
  url: string,
  dataTimestamp: string,
): Promise<void> {
  const statusUrl = nominatimUrl(url);
  statusUrl.pathname = "/status";
  statusUrl.search = "format=json";
  const status = (await geocoderJson(statusUrl)) as Record<
    string,
    unknown
  > | null;
  if (
    !status ||
    status.status !== 0 ||
    typeof status.data_updated !== "string" ||
    !Number.isFinite(Date.parse(dataTimestamp)) ||
    Date.parse(status.data_updated) !== Date.parse(dataTimestamp)
  )
    throw new Error("Open geocoder server dataset date differs");
}
export function validateOpenIndexDate(
  objectTimestamp: string,
  replicationTimestamp: string,
  dataDate: string,
): void {
  const object = Date.parse(objectTimestamp),
    replication = Date.parse(replicationTimestamp);
  if (
    !Number.isFinite(object) ||
    !Number.isFinite(replication) ||
    object > replication ||
    new Date(replication).toISOString().slice(0, 10) !== dataDate
  )
    throw new Error("Invalid open geocoder index date");
}

/** Only an operator's loopback Nominatim instance. No public service fallback. */
export function openGeocoder(
  counties: County[],
  dataset: OpenDataset,
  env: NodeJS.ProcessEnv = process.env,
): OpenGeocoder | null {
  if (!env.OPENPLANS_OPEN_GEOCODER_URL) return null;
  validateOpenDataset(dataset);
  const base = nominatimUrl(env.OPENPLANS_OPEN_GEOCODER_URL);
  base.pathname = "/search";
  return {
    dataset,
    async geocode(address: Address): Promise<OpenPoint | null> {
      if (address.state !== dataset.state) return null;
      const clean = normalizeAddress(address);
      if (!clean.geocodable) return null;
      const request = clean.request,
        house = request.line_1?.match(/^(\d[\dA-Z./ -]*?)\s+(?=[A-Z])/i)?.[1];
      if (!house || !request.city || !request.zip5) return null;
      const url = new URL(base);
      url.search = new URLSearchParams({
        format: "jsonv2",
        street: request.line_1!,
        city: request.city,
        state: { TX: "Texas", FL: "Florida", NC: "North Carolina" }[
          dataset.state
        ],
        postalcode: request.zip5,
        country: "United States",
        countrycodes: "us",
        addressdetails: "1",
        limit: "2",
        dedupe: "1",
      }).toString();
      const json = await geocoderJson(url);
      if (!Array.isArray(json)) throw new Error("Invalid Nominatim response");
      const points: OpenPoint[] = [];
      for (const row of json) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>,
          a = r.address as Record<string, unknown> | undefined;
        // Nominatim can return a street, ZIP or city when no house matches. Those are not recovered addresses.
        if (
          r.place_rank !== 30 ||
          !a ||
          String(a.house_number ?? "").toUpperCase() !== house.toUpperCase() ||
          typeof a.road !== "string" ||
          normalizeAddress({
            ...request,
            line_1: `${house} ${a.road}`,
            line_2: null,
          }).request.line_1 !== request.line_1 ||
          a.country_code !== "us" ||
          a["ISO3166-2-lvl4"] !== `US-${dataset.state}` ||
          String(a.postcode ?? "").slice(0, 5) !== request.zip5 ||
          !["node", "way", "relation"].includes(String(r.osm_type)) ||
          !/^\d+$/.test(String(r.osm_id)) ||
          typeof r.lat !== "string" ||
          !r.lat.trim() ||
          typeof r.lon !== "string" ||
          !r.lon.trim()
        )
          continue;
        const latitude = Number(r.lat),
          longitude = Number(r.lon),
          county = countyAt(latitude, longitude, counties);
        if (!county || !insideBounds(latitude, longitude, county)) continue;
        // Use the publisher's county name as an independent claim, then verify its polygon.
        const countyName = String(a.county ?? "")
          .replace(/\s+county$/i, "")
          .toUpperCase();
        if (
          !countyName ||
          countyName !== county.name.replace(/\s+county$/i, "").toUpperCase()
        )
          continue;
        points.push({
          ...dataset,
          latitude,
          longitude,
          county_fips: county.county_fips,
          bounds_snapshot_id: county.snapshot_id,
          source: "open_geocoder",
          licence: openLicence,
          attribution: openAttribution,
          as_of: new Date().toISOString().slice(0, 10),
          osm_type: String(r.osm_type),
          osm_id: String(r.osm_id),
          precision: "osm_address",
          matched_address: {
            house_number: String(a.house_number),
            road: a.road,
            postcode: String(a.postcode),
          },
        });
      }
      // Ties remain unknown. Multiple nearby buildings can share the same address.
      return points.length === 1 ? points[0]! : null;
    },
  };
}
