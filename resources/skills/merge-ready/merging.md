# Merge ready: merging, when it is yours

## Merging, when it is yours

What you merge must be what you checked, so merges into a base take turns through Hive's **merge slot**:
1. **Claim the slot** for the base with `hive_merge_slot` (`claim`, with the cards you are merging). Still in line: claim again, keeping your place. Without Hive's tools, go on: step 4 still protects the merge.
2. **Merge the base into the branch, note its commit** (`git rev-parse <base>`) **and run the checks** the combined change needs. Merge it into the branch, not the branch into the base with `--no-commit`: a failure is then fixed on the branch, and the base's checkout is never left mid-merge where others work. While you hold the slot nobody merges into the base through Hive, so one run is enough. The hold lasts 60 minutes: claim again to extend it.
3. **If something fails**, release the slot (`release`) before fixing it, and claim it again once ready.
4. **Just before merging, compare** the base's commit with the one you noted. If it moved anyway (a merge from outside Hive), merge the base in again, rerun the checks (all of them when the new commits touch shared code or test tooling) and compare again.
5. **Merge** in the checkout where the base is (`git -C <that checkout> merge --no-ff <branch>`). An `index.lock` there means another merge is under way: wait and try again; never delete it.
6. **Release the slot** once merged, and **report** the merge commit and the base commit your checks ran on: `hive_report_merge` for each card Hive told you to merge. A merge step you can't take within a rule (your CLI refused the commit, say) is `hive_cannot_within_rules` on the card (the rule, and why): it goes to the user.
