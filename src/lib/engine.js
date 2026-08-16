// The pure decision core. NOT IMPLEMENTED YET — on purpose.
//
// The tests are the specification and they are written first. This file exists
// so they run and fail on their assertions rather than on an import, which is
// what makes the red count a progress bar instead of a stack trace.
//
// Contract (docs/architecture.md §14):
//   decide(input) -> { action: 'leave',  rung, reason, wouldHave? }
//                  | { action: 'reopen', cookieStoreId, container, ruleId, rung, suppressedHints }
//                  | { action: 'ask',    choices, preselect, ruleId, rung }
//
// No browser APIs. No Date.now(). No randomness. Fully synchronous. The clock
// arrives as input.now, which is what turns every race in the failure catalogue
// into an ordinary table-driven test case.

export const VERSION = '0.0.0-unimplemented';

// eslint-disable-next-line no-unused-vars
export function decide(input) {
  throw new Error('engine.decide: not implemented — see docs/architecture.md');
}
