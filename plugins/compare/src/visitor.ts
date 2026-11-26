import { escapeHtml } from "./print.js";
import { marketQuery } from "./input.js";

/** Browser forms use numbered rows; JSON clients keep the canonical members array. */
export function marketForm(body: Record<string, unknown>) {
  const query = Object.fromEntries(
    Object.entries(body).map(([key, value]) => {
      if (typeof value !== "string") throw new Error("invalid_input");
      return [key, value] as const;
    }),
  );
  const members = [];
  for (let row = 1; row <= 10; row++) {
    const age = query[`age_${row}`];
    const relationship = query[`relationship_${row}`];
    delete query[`age_${row}`];
    delete query[`relationship_${row}`];
    if (age === undefined && relationship === undefined) continue;
    if (age === "") continue;
    if (!age || !/^\d+$/.test(age)) throw new Error("invalid_input");
    members.push({ age: Number(age), relationship });
  }
  if (members.length) {
    if (query.members !== undefined) throw new Error("invalid_input");
    query.members = JSON.stringify(members);
  }
  for (const field of ["zip", "county"])
    if (query[field] === "") delete query[field];
  return marketQuery(query);
}

const locationFields = `<label>ZIP <input name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" required></label>
<label>County FIPS, if the ZIP spans counties <input name="county" inputmode="numeric" pattern="[0-9]{5}" maxlength="5"></label>
<label>Plan year <input name="year" type="number" min="2014" max="9999" required></label>
<label>Metal <select name="metal"><option value="silver">Silver</option><option value="bronze">Bronze</option><option value="expanded bronze">Expanded Bronze</option><option value="gold">Gold</option></select></label>`;

export function visitorPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Individual offer prices</title><style>
body{font:1rem/1.5 system-ui,sans-serif;max-width:50rem;margin:auto;padding:1rem;color:#172b3a;background:#fff}label{display:block;margin:.7rem 0}input,select,button{font:inherit;max-width:100%;padding:.35rem}fieldset{margin:1rem 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.3rem}td input{width:5rem}button{cursor:pointer}a{color:#064c90}
</style></head><body><h1>Individual offer prices</h1><p>See the distribution of gross monthly premiums across individual medical plans offered on-exchange. Choose a year, location and metal, then enter one age or a household. All prices are non-tobacco and start January 1.</p>
<p>Check <a href="/v1/data-availability">loaded data and source gaps</a> first. Use the county lookup below when a ZIP spans counties. A missing or incomplete market stays unknown. A null price means unknown. Only a filed zero is $0. Available years and places depend on the admitted local catalog.</p>
<form method="get" action="/v1/zip-counties"><label>ZIP for county lookup <input name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" required></label><button type="submit">Look up counties</button></form><h2>One person</h2><form method="post" action="/compare/v1/print">${locationFields}<label>Exact age <input name="age" type="number" min="0" max="120" required></label><button type="submit">View printable distribution</button></form>
<h2>Household</h2><p>Enter each person's exact age and relationship to the subscriber. Leave unused age rows blank. These are individual policy prices for one household. Do not enter names, birth dates or employee records.</p><form method="post" action="/compare/v1/print">${locationFields}<table><caption>Household members, up to 10</caption><thead><tr><th>Member</th><th>Age</th><th>Relationship</th></tr></thead><tbody>${Array.from(
    { length: 10 },
    (_, i) => {
      const row = i + 1;
      return `<tr><td>${row}</td><td><input aria-label="Age for member ${row}" name="age_${row}" type="number" min="0" max="120"${i === 0 ? " required" : ""}></td><td><select aria-label="Relationship for member ${row}" name="relationship_${row}">${["subscriber", "spouse", "child", "other"].map((relationship) => `<option${relationship === (i === 0 ? "subscriber" : "child") ? " selected" : ""}>${relationship}</option>`).join("")}</select></td></tr>`;
    },
  ).join(
    "",
  )}</tbody></table><button type="submit">View printable household distribution</button></form>
<h2>What the sheet means</h2><p>Each eligible base plan counts once; enrollment does not weight the prices. The sheet shows exact median and mean ratios, nearest-rank quartiles, exclusions and source completeness. Fewer than four rated offers is a small sample. The evidence is paged, while statistics cover the whole market.</p><p>Group costs: unavailable from public evidence. This public form refuses private employer and group inputs, including renewals, contributions and employee records. Use only the ages and relationships requested here. Subsidies and group savings are not calculated. Gross premiums are not the subsidy benchmark. No result is a bindable quote.</p><p>On the result page, use your browser's Print command for Letter or A4. Source notes and generation stay with the sheet. Integrations can use <code>GET /compare/v1/market</code> or MCP <code>compare_market_costs</code>.</p></body></html>`;
}

function errorMessage(code: string): string {
  if (code === "invalid_input")
    return "Check the year, ZIP, county and ages. This public form refuses private employer and group inputs. Use only the fields shown on the form.";
  if (code === "generation_changed")
    return "The source data has changed. Restart the comparison to use current prices and sources together.";
  return "The comparison is unavailable. No price is available from this request. Try again later.";
}

/** Browser errors explain the next step without echoing submitted private fields. */
export function visitorError(code: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Comparison unavailable</title></head><body><h1>Comparison unavailable</h1><p>${errorMessage(code)}</p><p><a href="/compare/v1">Restart the comparison</a></p><p>Code: <code>${escapeHtml(code)}</code></p></body></html>`;
}
