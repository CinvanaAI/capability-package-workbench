# Security posture

The executor is bounded by authorization evidence, a fixed action-kind dispatch table, a temporary working directory, structured inputs, and recorded outputs/failures. It is **not an operating-system sandbox**.

Published Python package source is executed in a child Python process after package publication and authorization. Only run packages you trust. Do not use this prototype to execute untrusted code, and do not interpret “bounded” as protection from malicious Python source.

The public snapshot contains synthetic bootstrap packages only. It excludes local data roots, credentials, logs, and generated artifacts. The test uses a temporary data root and removes it afterward.
