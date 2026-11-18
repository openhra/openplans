/**
 * The calculation, evidence and print modules load on the first request or tool call. Setup
 * only builds schemas and registrations, so enabling the plugin adds no work to API startup.
 */
export const allowanceAnswers = () => import("./answers.js");
