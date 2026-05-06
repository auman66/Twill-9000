# exports/

Working folder for batch outputs. The contents of this directory are
git-ignored (see `.gitignore`) so generated media never gets committed.

Suggested layout — one subfolder per batch job:

```
exports/
  intros/
    welcome-intro_1738098765432.zip
    welcome-intro_1738098765432.mp3
    …
    convert-all_1738098770000.sh
    batch_manifest_1738098770000.json
  outros/
  promos/
```

See the top-level `README.md` for the batch workflow.
