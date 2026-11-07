# Review agent work: what you run, screenshots, proof you can't open

**What you run**, said as such in your verdict:
- **Reused**, the default: a record naming this revision, the check's command or suite and any real CLI's version, every failure explained. `checksAtRevision` is only the card's checks there.
- **Missing**, so run it: no record covers it, or its command, test or CLI changed since. Missing never counts as a pass. `runYourself` too: run it, or pass with `accept` naming it if its run here passed.
- **A doubt you name** (a result that doesn't fit, a flaky-looking pass, test tooling changed): one focused rerun, any kind, and the verdict says "reran X because Y". No doubt, no rerun.

**Screenshots cost far more to read than text.** When a check writes a text report of what its screenshots show, or its log says what each one is, read that first. Then open only the images it flags and those of the screens the change touches, never a whole set: the rest are for people to browse.

**Proof you can't open** (a cited log or run folder that isn't there) isn't a failed round on that alone: ask the builder for it (`cw_request_builder`), and judge it once it's there.
