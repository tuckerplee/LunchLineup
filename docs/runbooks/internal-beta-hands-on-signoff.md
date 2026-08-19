# Internal Beta Hands-On Interaction Signoff

Use this checklist only after the exact candidate workflow has produced both `internal-beta-candidate-proof-<sha>` and `internal-beta-interaction-proof-<sha>`. Automated proof is launch-blocking but does not replace unfamiliar-human signoff.

## Evidence boundary

- Automated evidence: Playwright runs against the exact release images and candidate SHA. Its JSON receipt rejects missing, failed, retried, skipped, or `fixme` critical cases. The retained artifact contains the receipt, JUnit/JSON/HTML reports, and trace, video, and screenshot files for every critical interaction.
- Human evidence: at least three evaluators who did not implement the feature independently complete the script below. Human comfort, comprehension, and hesitation notes are judgment evidence; they never turn a failed or missing automated case green.
- Stop immediately if the SHA shown in the two workflow artifact names differs, either artifact is missing, or any evaluator is coached through an interaction after starting.

## Setup

Record the candidate SHA, workflow-run URL, evaluator name/role, browser/device, start time, end time, and result in the session notes. Give each evaluator a freshly reset disposable beta tenant with two staff members, one location, separately purchased test credits, and no open time card. Do not use production or VM107 for this checklist.

## Unfamiliar-evaluator script

Each evaluator performs the same script without implementation guidance:

1. Open Calendar. Click a shift, make a tiny accidental movement, cancel an in-progress move with Escape, and drop once outside the schedule. Confirm none changes the saved employee or time.
2. Move one shift to the named second employee and exactly one hour later. Before release, read the proposed employee and time aloud. After release, confirm Saved and Undo independently if either control is offered.
3. Complete the same move without dragging by keyboard or the Move dialog. Simulate one rejected save and confirm only that shift returns to its original employee/time.
4. On a touch device, scroll the schedule starting on the shift body. Confirm scrolling does not move it. Activate the dedicated move handle and confirm the Move dialog opens.
5. Create or inspect a 10:00 PM-6:00 AM overnight shift. Open Lunch & Breaks and confirm the same employee, disabled 22:00 start, disabled Next day end, and disabled 06:00 end before saving setup. Read the exact setup record and separately purchased usage-credit cost, accept its confirmation, then confirm there are no inert Timeline, Staff, or Conflicts controls.
6. Open Time Cards, choose Team Time, and confirm the team location is disabled and no clock-in is available. Deliberately choose a team member, confirm clock-in is still disabled, then deliberately choose a location and read the now-explicit person/location action aloud without submitting it.

## Signoff record

Use three independent rows at minimum:

| Evaluator | Role/background | Device/browser | Candidate SHA | Pass/fail | Confusing or hesitant moments | Artifact/session note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |

Launch requires all evaluators to finish without a safety error, accidental mutation, hidden cost, or operator intervention. Product-language feedback may become follow-up work; any data-integrity, cancellation, touch, billing-disclosure, or explicit-selection failure blocks the beta.
