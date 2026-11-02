---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

This skill is two skills run together for the whole session. Read both files now and follow them:

- `/home/efren/.pi/agent/skills/grilling/SKILL.md` — the interview loop (design tree, rounds, frontier, recommended answers).
- `/home/efren/.pi/agent/skills/domain-modeling/SKILL.md` — the writing loop (`GLOSSARY.md` and `docs/adr/`). Its format files live next to it: `/home/efren/.pi/agent/skills/domain-modeling/GLOSSARY-FORMAT.md` and `/home/efren/.pi/agent/skills/domain-modeling/ADR-FORMAT.md`.

Run the interview against the current repository. The file-writing half is the point of this skill: write each term to `GLOSSARY.md` the moment it resolves, and write an ADR only when all three gates hold. An interview that leaves no files behind is this skill failing, not a normal outcome.

Keep going until the frontier is empty and the user confirms the shared understanding. Then offer to hand the same conversation to a spec, without clearing it.
