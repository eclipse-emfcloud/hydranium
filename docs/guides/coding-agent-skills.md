# Work with coding-agent skills

Install project-local instructions when you use a coding agent to develop your
language. Hydranium's
[profiling skill](../../skills/hydranium-profiling/SKILL.md)
interprets performance captures. The upstream Langium skill covers grammar and
runtime work; it is maintained and updated separately.

1. Run the interactive `init` wizard. After scaffolding succeeds, it offers to
   install skills and asks which agents should discover them. You can skip or
   cancel this step without losing the scaffold. Downloads use the external
   `skills` installer and need network access. For a scripted scaffold, opt in
   explicitly:

   ```bash
   npx @hydranium/cli init ./my-lang --name MyLang \
     --skills hydranium-profiling,langium --agents codex,claude-code
   ```

   Dependency installation remains a separate `--install` choice. For an
   existing project, set `SKILLS_INSTALLER` to the
   [pinned installer](../adopting/requirements.md#coding-agent-skill-installer),
   then run these from its root:

   ```bash
   npx "$SKILLS_INSTALLER" add eclipse-emfcloud/hydranium \
     --skill hydranium-profiling --agent codex claude-code --copy
   npx "$SKILLS_INSTALLER" add eclipse-langium/langium-ai \
     --skill langium --agent codex claude-code --copy
   ```

   Select only the agents you use. Explicit skill names avoid installing
   contributor-only instructions from either repository. `--copy` gives you
   real files that survive Windows clones without symlink support. In an npm
   workspace, the wizard installs skills at the workspace root, even when the
   scaffold itself is nested. It preserves unrelated skill installations.
   A failed download prints a retry command and leaves the scaffold in place.

2. Commit the installed skill directories and `skills-lock.json`. The files
   remain readable offline; the lock records their source and content hash.
   Confirm that your selected agent lists the skill. A successful download
   alone does not prove that a running agent has refreshed its skill catalogue.
   For Hydranium workspace locking, use
   [document layers](../concepts/document-layers.md): the upstream Langium
   skill's workspace-lock section describes older behavior.

3. Install your project dependencies, then check compatibility:

   ```bash
   npx hydranium-cli check-skills --from server
   ```

   The check reads installed packages from `server`, not from a globally
   installed CLI. For a nested workspace, name the actual server directory.
   By default it selects Hydranium skills and checks both shared and
   Claude-specific copies; an outdated copy cannot be hidden by a newer
   shared one.

   `compatible` means declared package requirements are satisfied.
   `incompatible` means an installed package does not declare the contracts
   required by the skill.
   `unverified` means evidence is missing, including uninstalled dependencies,
   missing or malformed metadata, or an unsupported metadata schema. Both
   incompatible and unverified results exit non-zero. Langium remains
   unverified when explicitly selected with `--skill langium`; it is excluded
   from the default check. Installation is still available.

   To gate only the Hydranium skill in CI:

   ```bash
   npx hydranium-cli check-skills --from server --skill hydranium-profiling
   ```

4. Update skills independently when you want newer guidance, review the diff,
   and rerun the compatibility check:

   ```bash
   npx "$SKILLS_INSTALLER" update hydranium-profiling
   npx hydranium-cli check-skills --from server --skill hydranium-profiling
   ```

   Update Langium separately with `npx "$SKILLS_INSTALLER" update langium`.
   The external updater does not enforce Hydranium compatibility. If a check
   fails, keep a previously verified skill revision or review the required
   framework upgrade;
   do not widen metadata locally just to make the check pass. A lock hash proves
   provenance, not compatibility, and compatible metadata does not prove that
   every instruction is correct.
