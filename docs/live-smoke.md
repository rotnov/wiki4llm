# Opt-in synthetic live acceptance

Run only with explicit authorization for the designated test project and normal
project ingestion credentials. This procedure uploads synthetic public text and
may incur provider storage charges. Use a new empty vector store and a new local
state directory. Keep receipts outside the public repository.

1. Create a temporary Git repository with a committed `README.md` containing a
   unique synthetic phrase. Configure its root, stable repository identity,
   project, existing empty store, credential environment-variable name and state.
2. Run `plan` without the key present. Confirm one addition and zero remote requests.
3. Provide the key through the approved environment mechanism and run `index --apply`.
   Verify completion and that the published file ID belongs to the intended project
   and configured store. Search for the synthetic phrase using the read-only gate
   credential and reject IDs absent from the manifest.
4. Run `update --apply` unchanged. Confirm the file ID, generation and publication ID
   remain identical and no additional Files object appears.
5. Change one file, commit it, and run `update --apply`. Confirm only that file ID
   changes and only its owned previous ID is cleaned up after publication.
6. Rename the file with Git, commit, and update. Confirm the old logical path disappears
   and the new path has an active entry. Delete it, commit, update, and confirm an empty
   collection. Verify unrelated remote objects remain untouched.
7. Save publication IDs, file/store IDs, provider request receipts, test commands and
   explicit live outcomes without credentials. Remove the synthetic repository/state
   only after remote cleanup is verified; preserve state if any outcome is uncertain.

Failure and ambiguous-outcome cases are covered deterministically in the local
suite. Do not manufacture uncertain live writes by blindly retrying them.
