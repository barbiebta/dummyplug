# Unit05 compatibility fixture

`dummyplug-h3-job-v2.dummyjob.zip` is a complete deterministic v2 job built by
Dummyplug itself. It contains two valid 16×16 PNG references, one valid
one-second 16×16 H.264 MP4, declarative video trim metadata, three v4 asset
sidecars, a manually authored six-section prompt, and checksums for every
member.

Rebuild from the repository root:

```powershell
node --experimental-strip-types scripts/build-v2-compat-fixture.mjs
```

Expected archive SHA-256:

```text
3cd516c17882a607804bfb7b11e004786f0f672cde3dbef7087f6a54e548ec2b
```
