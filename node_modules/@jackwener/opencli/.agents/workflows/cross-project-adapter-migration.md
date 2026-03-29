---
description: Migrate commands from an external CLI project into opencli adapters
---

// turbo-all

## Steps

1. Clone the source CLI project for analysis:
```bash
git clone <source_repo_url> /tmp/<source-cli>
```

2. Analyze source project: list all commands, auth method, API endpoints, and output fields.

3. Check existing opencli adapters for the target site:
```bash
ls src/clis/<site>/
opencli list | grep <site>
```

4. Generate a comparison matrix table (source commands vs opencli existing). Mark each as: ✅ **New** / ✅ **Enhance** / ❌ **Skip**. Ask user to confirm which commands to migrate.

5. Implement YAML Read adapters first (highest ROI, 10-20 lines each). Place files in `src/clis/<site>/<name>.yaml`.

6. Implement TS Read adapters for complex cases (GraphQL, pagination, signing). Place files in `src/clis/<site>/<name>.ts`.

7. Implement TS Write adapters using `Strategy.UI` or `Strategy.COOKIE`. Place files in `src/clis/<site>/<name>.ts`.

8. Verify build:
```bash
npx tsc --noEmit
```

9. Verify all commands are registered:
```bash
opencli list | grep <site>
```

10. Run each new command to verify it works:
```bash
opencli <site> <command> --limit 3 -f json
```

11. Update README.md with new command examples in the appropriate platform section.

12. Update SKILL.md Commands Reference with new commands.

13. Commit and push:
```bash
git add -A
git commit -m "feat(<site>): migrate <N> commands from <source-cli>"
git push
```
