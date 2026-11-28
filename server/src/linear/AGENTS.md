# Linear integration

The app connects a workspace and turns qualifying team issue events into work items.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/linear-protocol-check.ts` checks OAuth, GraphQL and webhook parsing against the stand-in, with no server or actors.
- `cd server && LINEAR_ONLY=OAuth npx tsx ../scripts/linear-check.ts` checks the connection and ticket.
- `cd server && LINEAR_ONLY=setup npx tsx ../scripts/linear-check.ts` checks disconnected intake.

`LINEAR_ONLY` takes comma-separated, case-sensitive prefixes of the `check(` names in `scripts/linear-check.ts`, such as `setup`, `OAuth`, `mapping`, `label`, `writeback` or `Quick labels`.
Both checks form the `linear` group in `scripts/ci-groups.json`; Linear itself is played by `scripts/linear-standin.ts`.

## Module map

- `./app.ts` is the OAuth and GraphQL client: token exchange and revoke, identity, teams, issue reads and item writebacks (`writeIssue`), `LinearError` and `redactLinear`.
- `./connect.ts` serves `/linear/callback`: consumes the OAuth state, exchanges the code with PKCE, refuses a person's token and seals the connection ticket. A state whose nonce starts `link.` is a person signing in as themselves to link their Linear user: their token is read once (`person`), revoked, and sealed into a `#link-return=linear.` ticket that the web app redeems with `linkAccount` as soon as it lands. The web app starts that sign-in right after a connection too, because the connection's token is the app's and names nobody.
- `./webhook.ts` serves `/linear/webhook`: size limit, HMAC over the raw bytes, signed-timestamp freshness, then `classify` and `dispatch`.
- [User integration](../actors/user-linear.ts) stores the owner's connection and team mappings, and exports `dispatchLinearDelivery` and the connect store that `server/src/index.ts` wires to the routes.

## Key types

- `LinearDelivery` (`./webhook.ts`) holds only lookup IDs and the transition (label gained, assignee); never issue content.
- `LinearWrite` (`./app.ts`) enumerates the writebacks an item makes: comments for opened, handed over, merged, failed or cancelled, attachments, owner questions and status moves.
- `LinearConnectFailure` (`./connect.ts`) is the reason the web app is sent back with: `state`, `used`, `denied`, `code`, `scope`, `not_app`, `unreachable` or `failed`.
- `LinearError` (`./app.ts`) carries the HTTP status and a redacted message.

## Invariants and pitfalls

- The OAuth token acts as Linear's app user (`actor=app`); `identity` in `./app.ts` refuses a token whose `viewer` is a person and `./connect.ts` reports `not_app`. So the code never knows who wrote an issue: treat issue text as third-party input even when the delivery names who added the label.
- Classify updates using `updatedFrom`, the previous field values. An update without them, or an unrelated edit to an already labelled issue, must not file another item.
- Trigger labels are `windlass` and the Quick labels in the Linear record's `quickLabels` (`server/src/sources/registry.ts`), matched case-insensitively after trimming.
- Verify the MAC over the original bytes before decoding, then reject timestamps more than `MAX_TIMESTAMP_SKEW_MS` from now.
- A dispatch that throws or times out answers non-2xx, and Linear's redelivery under the same `Linear-Delivery` ID is the only retry. Keep dispatch idempotent per delivery ID.
- Pass lookup IDs through admission. The owner's intake re-reads the issue and checks the current mapping and qualification before filing.
- The item is the delivery actor's: `decide` resolves `actorId` to their linked uid (`resolveFiler`) and files in that account through `internalTrackerIntake`, with `filer` on the origin. An unlinked actor files nothing and gets one comment per issue asking them to link.
- The mapping and filing cases in `scripts/linear-check.ts` depend on state created by earlier cases. Use the standalone filters above locally and leave the sequence to CI.
- Pass known tokens to `redactLinear` before logging or returning any Linear error text.

## See also

[Workspace actor](../actors/linear-workspace.ts) locates the team owner. [Shared intake](../actors/issue-intake.ts) files the item with GitHub's intake rules and daily cap.
