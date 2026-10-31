# Review agent work: screenshots, a whole suite again, proof you can't open

**Screenshots cost far more to read than text.** When a check writes a text report of what its screenshots show, or its log says what each one is, read that first. Then open only the images it flags and those of the screens the change touches, never a whole set: the rest are for people to browse.

**Run a whole suite again** only when there's no run record, it is for other code, something in it looks wrong (a flaky check, a pass that doesn't fit the change), or the change is to shared test infrastructure, and say which in your verdict.

**Proof you can't open** (a cited log or run folder that isn't there) isn't a failed round on that alone: ask the builder for it (`hive_request_builder`), and judge it once it's there.
