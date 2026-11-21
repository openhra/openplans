/** The one place the sender module is loaded from, and only when `send` runs. */
export const loadSender = () => import("./send.js");
