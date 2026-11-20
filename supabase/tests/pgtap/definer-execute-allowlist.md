# SECURITY DEFINER EXECUTE allow-list

The SQL allow-list in `045a_definer_execute_allowlist.sql` covers effective
`EXECUTE` for `anon` and `authenticated` on SECURITY DEFINER functions in
`public` and `api`. `PUBLIC` and inherited grants count even when the caller
has no schema `USAGE`. Each row records an exact function signature, the allowed
roles, a reason and the function owner.

Bundles that add a definer function callable by `anon` or `authenticated` must
add an explicit `GRANT EXECUTE` to each intended caller role and an allow-list
entry with a reason. Revoke any broader grant. A PR that revokes EXECUTE from
any listed role must remove that role from the entry in the same PR or CI
fails with the signature and role. Delete the entry when removing its last
role. CI also fails on entries for functions that were dropped or are no
longer SECURITY DEFINER.

Reasons prefixed with `audit-static:` come from the static audit model.
Pre-existing entries track grants pending remediation or follow-up review.

## Limits

- Approval is keyed by signature. `CREATE OR REPLACE` keeps the approval even
  when the function body changes.
- The owner column is informational. The guard does not verify it.
- Procedures (`prokind = 'p'`) are outside the guard's scope.

## pgTAP mutations

Hosted pgTAP checks the real catalog first. In the same transaction it
creates a throwaway definer with EXECUTE for `authenticated`, then verifies
that the unlisted-grant check returns that grant and the stale-role check
returns `anon` when both roles are listed. With only `authenticated` listed,
both checks must return no rows. The transaction rolls back the function,
its grants and the temporary allow-list.

On a disposable database, insert a synthetic SECURITY DEFINER function in
`public` or `api` inside the test transaction just before the assertion. Revoke
`EXECUTE` from `PUBLIC`, `anon` and `authenticated`, then grant it to one
caller role. Expect a failure naming the signature and role. Add an entry for
that signature and role and expect a pass. Grant the other role and expect a
failure naming the additional role. An entry for a different overload must
also fail. With a valid entry, drop the function, switch it to SECURITY INVOKER
or revoke EXECUTE from one listed role while another retains it in separate
runs. Expect the stale check to name the signature, role and why the entry
is stale. Use a temporary copy of the test for mutations and roll back.
