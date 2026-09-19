# Origin and extraction boundary

This subsystem was extracted from the owner-governed Skeleton rebuild so its package model could be reviewed independently of the full desktop product.

The package, record, storage, coordination, environment, and executor implementations are preserved from that system. Machine-specific paths in one historical bootstrap package were replaced with `SKELETON_OUTPUT_ROOT` and `SKELETON_TARGET_REPO`, both defaulting to local generic paths. The test and public documentation were added for this standalone snapshot.

No runtime data, generated artifact store, provider credential, unpublished private package, audit prompt, or adjacent project is included.
