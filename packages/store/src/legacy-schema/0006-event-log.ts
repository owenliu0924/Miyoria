// Legacy migration 6 (was `0006_event_log.sql`). Never edit it: its checksum is recorded.
//
// One exception, before any V5 database existed outside tests: step 3 of docs/design/v5-data.md
// §8 took out `log_events` and `log_event_rollups`. The event log is core's `events` and
// `event_rollups` now (`events/schema.ts`); nothing reads or writes the V3 tables. The version
// stays, so the legacy numbering does not move.

export const m0006 = `-- The V3 EventLog (log_events, log_event_rollups) moved to core's events table (V5 step 3).
`;
