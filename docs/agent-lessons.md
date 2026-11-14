# Agent lessons

Repo-specific conventions learned from review findings. Read before changing anything; the ticket and CLAUDE.md win over this file.

- Stamp "when X happened" with a read's time only if the read before it saw X not yet true. The first read to find X already true (a sale that opened weeks before the first check) cannot say when, so leave it null: a guessed time must not look measured. (added 2026-11-11; last cited 2026-11-11)
- When cutting text to fit an external size limit, never split a UTF-16 surrogate pair (an emoji): drop the dangling half before appending the ellipsis, because a lone surrogate serialises to an invalid JSON escape the receiver may reject. (added 2026-11-14; last cited 2026-11-14)
