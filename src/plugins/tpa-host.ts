import type { TpaReceiptHost } from "@openplans/plugin-sdk";
import { prepareIchraReceipt } from "../receipts/ichra.js";
import { restrictCacheLevel } from "./request-scope.js";

export const tpaReceiptHost: TpaReceiptHost = Object.freeze<TpaReceiptHost>({
  async prepare(input, includeInput, scope) {
    restrictCacheLevel("request");
    return prepareIchraReceipt(scope.db, input, includeInput, scope.signal);
  },
});
