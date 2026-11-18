/**
 * The calculation, form and print modules load on the first request or tool call. Setup only
 * builds the MCP schemas and route registrations, so enabling the plugin adds no work to API
 * startup.
 */
export const compareAnswers = () => import("./answers.js");
