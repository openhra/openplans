/**
 * Newest-first ordering for `qhp_index` rows (one row per issuer registry row per discovery run).
 *
 * Every "which discovery is the newest" selection must use this clause. `discovered_at` alone is not
 * a total order: two rows can carry the same timestamp (a coarse clock, or rows written in one
 * transaction), and the winner would then depend on physical row order. `qhp_index_id` is the
 * tie-break. It is unique, so the order is total and the same on every run and platform.
 *
 * The id is not chronological (it is `<discovery uuid>:<registry row>`, and test ids may be any text),
 * so a tie is resolved deterministically, not "correctly". Writers that need a specific row to win
 * must give it a strictly later `discovered_at`; a tie never decides between two real discovery runs
 * in production because they are minutes apart.
 */
export const QHP_INDEX_NEWEST_FIRST = "discovered_at DESC,qhp_index_id DESC";
