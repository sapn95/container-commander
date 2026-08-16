# Decision records

One file per decision a reviewer would question. Each says what was chosen,
**why**, and what was rejected — the last part being what tells the next person
whether their idea was considered or simply missed.

|                                                                |                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [ADR-0001](0001-decide-once-at-entry.md)                       | Decide once, at entry, and never again                                    |
| [ADR-0002](0002-read-only-policy-via-managed-storage.md)       | Read-only policy via managed storage; no writable rule store              |
| [ADR-0003](0003-claims-outrank-rules.md)                       | Claims outrank every rule, including deterministic ones                   |
| [ADR-0004](0004-no-prompt-on-external-entries.md)              | Commander never prompts on external entries                               |
| [ADR-0005](0005-post-requests-are-never-reopened.md)           | POST requests are never reopened                                          |
| [ADR-0006](0006-races-are-removed-by-configuration.md)         | Races are removed by configuration, not won by ordering                   |
| [ADR-0007](0007-one-engine-pinned-to-the-installed-release.md) | The verifier runs the shipped engine, pinned to the installed release     |
| [ADR-0008](0008-bookmark-hints-are-the-weakest-tier.md)        | Bookmark hints are the weakest tier, and cannot open a side door          |
| [ADR-0009](0009-user-chosen-container-is-provenance.md)        | A hand-chosen container is provenance and is never overridden             |
| [ADR-0010](0010-unknown-is-leave-alone-not-a-question.md)      | Unknown is leave-alone, never a question                                  |
| [ADR-0011](0011-employer-neutral-public-repo.md)               | The public repo carries no employer identifiers, enforced by an allowlist |
