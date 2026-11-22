# Session notes (chief)

While agents work: syscall shield committed; snapshot/restore committed.

Watch list:
- CdromUnit: cdrom.ts delivered with type errors mid-iteration (doubleInt,
  wantComplete, seeking fields) — wait for their green report, do NOT fix
  their file unless they stall; integration is mine after delivery.
- Others: awaiting first deliveries.

Integration checklist per delivery:
1. tsc clean whole-tree
2. bun test 60+ green
3. Wire into machine.ts / UI (single owner: chief)
4. Cross-module test
5. Commit + push (CI gate)
