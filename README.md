# Beat Slicer

An [Ableton Live Extension](https://www.ableton.com/en/live/extensions/) that automatically slices audio clips at detected transients. Right-click any audio clip in Arrangement View to slice it into individual hits.

## Features

- Transient detection with adjustable sensitivity (1–100)
- Grid snapping: exact transient positions, nearest grid line, or quantized
- Grid resolution: 1/4, 1/8, 1/16, 1/32 note
- Waveform preview with onset strength overlay in the settings dialog
- Works with unsaved and saved projects
- Arrangement View only (Session View clips require a different permission model)

## Install

1. Download the latest `beat-slicer.ablx` from the [Releases](../../releases) page
2. Drag it into Ableton Live — the extension installs automatically

Then right-click any audio clip in Arrangement View and select **Beat Slicer → Slice**.

Requires Ableton Live 12.1+ with Extensions support.

## Build from source

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- Ableton Extensions SDK (download from [Ableton](https://www.ableton.com/en/live/extensions/))

### Setup

Place the Extensions SDK alongside this repo so the directory structure looks like:

```
AbletonExtensions/
  extensions-sdk/    ← SDK from Ableton
  beat-slicer/       ← this repo
```

Then install dependencies and build:

```bash
cd beat-slicer
npm install
npm run build
```

### Dev mode

Run directly in Live without packaging (requires Developer Mode enabled in Live's settings):

```bash
node ../extensions-sdk/runner.cjs \
  --live "/Applications/Ableton Live 12.app" \
  --extension .
```

All `console.log` output and errors appear in the terminal.

### Package for distribution

```bash
npm run build:prod
node ../extensions-sdk/package.cjs . -o beat-slicer.ablx
```

## How it works

1. `renderPreFxAudio` renders the clip to a temporary WAV file via the Extension Host (bypasses the Node.js filesystem permission sandbox)
2. Onset strength is computed using an RMS-based spectral flux approach
3. Transient peaks are picked above an adaptive threshold
4. The original clip is deleted and replaced with individual audio clips written to the project's temp directory, one per slice
5. If the project is saved, slices are imported into the project folder via `importIntoProject`; otherwise they stay in the temp directory and Live references them by path

## Contributing

Pull requests are welcome. The extension is a single TypeScript file ([src/extension.ts](src/extension.ts)) plus a self-contained HTML dialog ([src/dialog.html](src/dialog.html)).

## License

MIT — see [LICENSE](LICENSE)
