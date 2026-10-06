/**
 * Plays: recipes that find the people who need a product now, each from one source of
 * buying intent, each finding with a one-sentence reason and the page that shows it.
 *
 * Only the public surface is exported here. The helpers in ./shared.ts and
 * ./extractCustomers.ts stay inside this folder.
 */
export * from "./types.js";
export { emptyTrace, mergeTrace, playDedupeKey, mailSafeReason } from "./util.js";
export { findCompetitorCustomers } from "./competitorCustomers.js";
export { findHiringCompanies } from "./hiring.js";
export { findFundedCompanies } from "./funding.js";
export { findPublicAsks, type AskSource } from "./publicAsks.js";
export { findPeopleForFinding } from "./people.js";
export { engagersFromRows, type Engagement, type EngagerRow } from "./engagers.js";
export { planPlays, type PlayPlan } from "./plan.js";
