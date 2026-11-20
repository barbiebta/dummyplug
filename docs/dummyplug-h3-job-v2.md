# Dummyplug H3 job v2

`dummyplug.h3-job.v2` is the immutable handoff between Dummyplug and Unit05.
Dummyplug is the producer and remains responsible for H3 prompt validation.
Unit05 must reject a bundle that fails any archive, manifest, reference, or
checksum rule below before it copies media into ComfyUI.

The machine-readable schema is [`dummyplug-h3-job-v2.schema.json`](dummyplug-h3-job-v2.schema.json).
Rules that relate multiple fields, archive members, or H3 label order are
normative in this document even when JSON Schema cannot express them.

## Archive members

```text
manifest.json
prompt.txt
request.txt
reference-map.json
checksums.json
assets/
metadata/
```

- All member names are safe relative POSIX paths. Absolute paths, backslashes,
  drive letters, `.` segments, and `..` segments are forbidden.
- `checksums.json` is an object mapping every regular archive member except
  itself to the lowercase SHA-256 of its uncompressed bytes. Its key set must
  match the archive exactly.
- Every `manifest.references[].path` names one existing file directly inside
  `assets/`. The declared `sha256` and `size` must match its bytes.
- `prompt.txt` is non-empty UTF-8 and is the final authored six-section H3
  prompt. Unit05 does not rewrite it.
- `request.txt` is UTF-8 provenance. For a manual prompt it contains
  `Manually authored final H3 prompt.`
- `reference-map.json` contains Dummyplug's resolved Subjects and attachment
  snapshot. Unit05 may preserve it without interpreting it.
- `metadata/*.json` are project-owned asset sidecars. Unit05 preserves them as
  job evidence but they do not override the sealed manifest or prompt.
- No credential, authorization header, provider key, or absolute local source
  path may occur anywhere in the archive.

## Manifest semantics

- `schema` is exactly `dummyplug.h3-job.v2`.
- `job_id` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. It is the stable
  execution/delivery identifier and output filename prefix.
- `job_desc` is required human-readable text from 1 through 30 characters.
- `created_at` is an ISO-8601 timestamp. `title`, when present, is the project
  name and is not used as an execution identifier.
- `workflow` is exactly `{ "template": "dasiwa-ref2va", "version": 1 }`.
- `prompt_policy` records the authoring policy used when Dummyplug validated
  the prompt. Unit05 preserves it and does not reinterpret identity language.

## Generation rules

- `width` and `height` are integers from 64 through 8192, inclusive, and each
  is divisible by 16.
- `duration` is an integer number of seconds from 1 through 20, inclusive.
  Fractional duration is not part of v2 and must be rejected, not truncated.
- `fps` is a finite number from 1 through 120, inclusive.
- `seed` is a non-negative JavaScript-safe integer and is always resolved
  before sealing. Unit05 never randomizes it.
- `steps` is an integer from 1 through 200, inclusive.
- `sampler`, output container/codec, audio codec, and audio bitrate are
  non-empty strings passed to their corresponding Comfy nodes.
- `shift_video` and `shift_audio` are finite numbers.
- `ref_image_size` is `match` or `max`.
- `input_scaling` is one of `Off`, `Auto`, `Target`, `Fit`, `Fill and crop`,
  `Fit and pad`, or `Long side with divisible crop`.
- Output `quality` is an integer from 0 through 51, inclusive.

## Reference rules

- At least one reference is required. Array position is authoritative and
  `order` must equal that zero-based position. Paths and `asset_id` values are
  unique within the manifest.
- H3 labels are derived independently per kind while walking the array:
  images are `<Picture 1>`, `<Picture 2>`, and so on; videos are `<Video 1>`,
  `<Video 2>`, and so on; audio is `<Audio 1>`, `<Audio 2>`, and so on.
- `kind` is `image`, `video`, or `audio`; `mime_type` is non-empty; `size` is a
  non-negative safe integer; and `sha256` is 64 lowercase hexadecimal digits.
- Images and videos require positive integer `source_width` and
  `source_height`.
- Videos additionally require positive `source_duration`, `trim_start`, and
  `trim_end` satisfying
  `0 <= trim_start < trim_end <= source_duration`. The original video is
  bundled; trimming remains declarative.
- Non-video references must not contain `trim_start` or `trim_end`.

Unknown object fields may be preserved for forward-compatible metadata, but
they cannot weaken or replace any required v2 field.
