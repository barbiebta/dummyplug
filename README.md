# dummyplug

Dummyplug turns a small set of reference images, videos, and audio files into one verbose MiniMax H3 prompt for one continuous camera take.

## Workflow

1. Add individual assets or load a folder.
2. Give each asset a canonical name, role, H3 use, source-of authority, and personal note.
3. Analyze an asset on command when visual evidence would help.
4. Check the references for the next generation.
5. Write a simple action and generate the six-part prompt.
6. Copy the prompt or export the selected media, prompt, attachment map, and metadata as a ZIP.

The product scope is intentionally limited to this path and always targets one uninterrupted shot.

## Durable asset metadata

Folder imports bind each asset to its browser file handle. Metadata is written beside the source as `<source-name>.json` when the browser grants folder write access. Individually selected files can use a chosen metadata folder or download their sidecar manually. The app uses only the `dummyplug.asset.v3` sidecar schema and a fresh single-shot browser database; it does not migrate previous Dummyplug workspaces.

Chrome or another Chromium browser is recommended for persistent file and folder handles.

## DaSiWa label mapping

- Every selected visual source is abstracted into a deterministic `<Subject N>`; assets with the same canonical name resolve to the same Subject.
- Images are numbered as `<Picture N>` by selected-list order, but only an asset explicitly marked **frame anchor / storyboard** receives a standalone Picture definition and retention line. Appearance, scene, costume, and style images are cited only inside their Subject.
- Videos are numbered as `<Video N>`, but only an explicitly structural, edit-source, or continuation-source video receives a standalone Video definition and retention line. Visible people, scenes, actions, and styles remain Subjects.
- Audio signals receive `<Audio N>` entries and are explicitly marked as reference or copy relationships.
- The generated prompt contains the six official REF2VA sections and exactly one `[Shot 1]` in `detailed_description`.

These rules follow the [DaSiWa MiniMax H3 Director guide](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes/blob/main/docs/minimax_h3_director.md) and MiniMax's linked full-reference rewrite format.

## Models

The settings panel exposes two independent model fields:

- Vision model: analyzes one asset according to its declared role.
- Prompt model: expands the simple request and durable asset records into exactly one six-part, single-shot H3 prompt.

OpenRouter is supported directly. A local OpenAI-compatible bridge can also be selected. Offline demo mode lets you exercise asset metadata without making model calls.

## Development

```powershell
npm install
npm run dev
```

Verification:

```powershell
npm run lint
npm test
```
