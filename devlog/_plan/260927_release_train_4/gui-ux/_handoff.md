# GUI UX lane handoff — final (2026-09-28 KST)

The lane is closed for release train 4. #6058's routed-model capability editor landed through #6105 (merge `3401e1ee73`), and #6058 was closed with credit. Every other assigned PR and issue has an English disposition comment and stays open. The table is in `040_dispositions.md`.

For the next train:

- **#4932.** Start from the audited plan in `020_combo_sidecar.md`, including its four A findings. The next step is B on a fresh branch from `dev`.
- **#5617.** Decide the precedence and the migration and rollback between global and provider visibility before any UI work, then wait for #6106 to settle `Providers.tsx`.
- **Registry enrichment.** Caching it per provider in `listManagementModelRows` was declined on #6105 as a trivial-priority refactor. Revisit it if `/api/models` latency shows up on large rosters.

For QA, use `.tmp/gui-ux/qa-server.ts` (direct `startServer`, refuses non-isolated homes) with `.tmp/gui-ux/qa-setup.sh`, and Playwright-core in `/private/tmp/t4-gui-ux-pw` driving the system Chrome. `.tmp/gui-ux/real-home-sentinel.sh` hashes the real-home client configs before and after a run; they were unchanged through this lane's QA.

The Codexclaw FSM for coordinator session `01a0e37e-639d-7693-a2bc-5e4df49fa656` closed `wp1` at D. `wp2` was stopped at A by the scope change, with no B, C or D recorded.
