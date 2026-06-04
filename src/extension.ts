import * as fs from "fs/promises";
import * as path from "path";
import {
  initialize,
  AudioClip,
  AudioTrack,
  Clip,
  ClipSlot,
  type ActivationContext,
  type Handle,
  type ApiVersion,
} from "@ableton/extensions-sdk";

// Convenience alias — pin to the current API version throughout
type V = "1.0.0";
import dialogHtml from "./dialog.html";
import decodeAiff from "@audio/decode-aiff";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wav = require("node-wav") as {
  decode: (buf: Buffer) => { sampleRate: number; channelData: Float32Array[] };
  encode: (channelData: Float32Array[], opts: { sampleRate: number; float: boolean; bitDepth: number }) => ArrayBuffer;
};

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface SlicerSettings {
  grid: "1/4" | "1/8" | "1/16" | "1/32";
  snap: "exact" | "grid" | "quantize";
  sensitivity: number; // 1–100
  cancelled: boolean;
}

interface DialogData {
  peaks: number[];
  onsetStrength: number[];
  hopMs: number;
  durationSeconds: number;
  clipDurationBeats: number;
  clipName: string;
  clipCount: number;
}

interface ClipJob {
  clip: AudioClip<V>;
  track: AudioTrack<V>;
  clipSlot: ClipSlot<V> | undefined; // defined = Session View, undefined = Arrangement
}

// ─────────────────────────────────────────────
// Grid resolution → beats (quarter notes = 1 beat)
// ─────────────────────────────────────────────

const GRID_BEATS: Record<string, number> = {
  "1/4": 1,
  "1/8": 0.5,
  "1/16": 0.25,
  "1/32": 0.125,
};

// ─────────────────────────────────────────────
// Audio file decoder — WAV via node-wav, everything else via audio-decode
// ─────────────────────────────────────────────

async function decodeAudioFile(filePath: string): Promise<{ sampleRate: number; channelData: Float32Array[] }> {
  const buffer = await fs.readFile(filePath);

  // Try WAV first
  try {
    const result = wav.decode(buffer);
    if (result?.channelData?.length > 0) return result;
  } catch {
    // fall through
  }

  // Try AIFF (common on macOS Ableton projects)
  try {
    const result = await decodeAiff(buffer);
    if (result?.channelData?.length > 0) {
      return {
        sampleRate: result.sampleRate,
        channelData: result.channelData as Float32Array[],
      };
    }
  } catch {
    // fall through
  }

  const ext = path.extname(filePath).toLowerCase();
  throw new Error(`Unsupported audio format: ${ext || "(unknown)"} — only WAV and AIFF are supported`);
}

// ─────────────────────────────────────────────
// Transient detection — half-wave rectified first-difference of RMS energy.
// Robust to compressed/dense audio where the ratio approach breaks down.
// sensitivity 1–5: higher = lower threshold = more slices
// ─────────────────────────────────────────────

function detectTransients(channelData: Float32Array[], sampleRate: number, sensitivityLevel: number): number[] {
  // Mix to mono
  const numSamples = channelData[0]!.length;
  const mono = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    let sum = 0;
    for (const ch of channelData) sum += ch[i]!;
    mono[i] = sum / channelData.length;
  }

  // Prefix sum of squares for O(1) RMS queries
  const prefix = new Float64Array(numSamples + 1);
  for (let i = 0; i < numSamples; i++) {
    prefix[i + 1] = prefix[i]! + mono[i]! * mono[i]!;
  }

  const windowRms = (start: number, end: number): number => {
    const s = Math.max(0, start);
    const e = Math.min(numSamples, end);
    if (e <= s) return 0;
    return Math.sqrt((prefix[e]! - prefix[s]!) / (e - s));
  };

  // Short/long RMS ratio: fires on genuine attacks, stays ~1 during hit body/resonance.
  // Short window = current energy, long window = recent background.
  const shortSamples = Math.round(0.010 * sampleRate); // 10ms attack window
  const longSamples  = Math.round(0.080 * sampleRate); // 80ms background reference
  const hopSamples   = Math.round(0.005 * sampleRate); // 5ms hop
  const numFrames    = Math.max(0, Math.floor((numSamples - shortSamples) / hopSamples) + 1);

  // Skip the first warmupFrames: the background window is empty during this period,
  // producing spuriously large ratios that inflate peakOnset and bury real transients.
  const warmupFrames = Math.ceil(longSamples / hopSamples);
  const onsetStrength: number[] = [];
  for (let f = 0; f < numFrames; f++) {
    if (f < warmupFrames) {
      onsetStrength.push(0);
      continue;
    }
    const sStart = f * hopSamples;
    const shortRms = windowRms(sStart, sStart + shortSamples);
    const longRms  = windowRms(sStart - longSamples, sStart);
    onsetStrength.push(Math.max(0, shortRms / longRms - 1.0));
  }

  // Peak-based threshold: sensitivity truly controls fraction of the loudest onset.
  // At sensitivity 1: threshold ≈ peak → only the strongest hit detected.
  // At sensitivity 100: threshold → 0 → all onsets detected.
  let peakOnset = 1e-10;
  for (const v of onsetStrength) if (v > peakOnset) peakOnset = v;

  const t = (sensitivityLevel - 1) / 99;
  const threshold = peakOnset * Math.max(Math.pow(1 - t, 2), 0.02);

  // 50ms minimum gap between onsets
  const minGapFrames = Math.ceil(0.050 / 0.005); // 10 frames at 5ms hop
  const transientSamples: number[] = [];
  let lastPeakFrame = -minGapFrames;

  for (let i = 1; i < onsetStrength.length - 1; i++) {
    const val = onsetStrength[i]!;
    if (
      val > threshold &&
      val >= (onsetStrength[i - 1] ?? 0) &&
      val >= (onsetStrength[i + 1] ?? 0) &&
      i - lastPeakFrame > minGapFrames
    ) {
      transientSamples.push(i * hopSamples);
      lastPeakFrame = i;
    }
  }

  return transientSamples.map((s) => s / sampleRate);
}

// ─────────────────────────────────────────────
// Prepare waveform data for dialog preview
// ─────────────────────────────────────────────

async function prepareDialogData(jobs: ClipJob[], context: ReturnType<typeof initialize<V>>): Promise<DialogData | null> {
  if (jobs.length === 0) return null;
  try {
    const job = jobs[0]!;
    const { clip, track, clipSlot } = job;

    // Mirror processClip: session clips read the source file directly (WAV/AIFF),
    // arrangement clips render to WAV so any source format is supported.
    let audioPath: string;
    if (clipSlot) {
      audioPath = clip.filePath;
    } else {
      audioPath = await context.resources.renderPreFxAudio(track, clip.startTime, clip.endTime);
    }

    const { sampleRate, channelData } = await decodeAudioFile(audioPath);
    if (!channelData || channelData.length === 0) return null;

    const numSamples = channelData[0]!.length;

    // Mix to mono
    const mono = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (const ch of channelData) sum += ch[i]!;
      mono[i] = sum / channelData.length;
    }

    // Compute 428 waveform peak values (one per canvas pixel)
    const peaks: number[] = [];
    const segmentSize = numSamples / 428;
    for (let px = 0; px < 428; px++) {
      const start = Math.floor(px * segmentSize);
      const end = Math.min(Math.floor((px + 1) * segmentSize), numSamples);
      let peak = 0;
      for (let i = start; i < end; i++) {
        const abs = Math.abs(mono[i]!);
        if (abs > peak) peak = abs;
      }
      peaks.push(Math.round(peak * 1000) / 1000);
    }

    // Compute onset strength — must match detectTransients exactly
    const shortSamples2 = Math.round(0.010 * sampleRate);
    const longSamples2  = Math.round(0.080 * sampleRate);
    const hopSamples   = Math.round(0.005 * sampleRate);
    let hopMs = 5;
    const numFrames = Math.max(0, Math.floor((numSamples - shortSamples2) / hopSamples) + 1);

    // Prefix sum of squares for O(1) RMS queries
    const prefix = new Float64Array(numSamples + 1);
    for (let i = 0; i < numSamples; i++) {
      prefix[i + 1] = prefix[i]! + mono[i]! * mono[i]!;
    }

    const windowRms = (start: number, end: number): number => {
      const s = Math.max(0, start);
      const e = Math.min(numSamples, end);
      if (e <= s) return 0;
      return Math.sqrt((prefix[e]! - prefix[s]!) / (e - s));
    };

    const warmupFrames2 = Math.ceil(longSamples2 / hopSamples);
    let onsetStrength: number[] = [];
    for (let f = 0; f < numFrames; f++) {
      if (f < warmupFrames2) {
        onsetStrength.push(0);
        continue;
      }
      const sStart = f * hopSamples;
      const shortRms = windowRms(sStart, sStart + shortSamples2);
      const longRms  = windowRms(sStart - longSamples2, sStart);
      onsetStrength.push(Math.max(0, shortRms / longRms - 1.0));
    }

    // Round to 5 decimal places
    onsetStrength = onsetStrength.map(v => Math.round(v * 100000) / 100000);

    // Max-pool pairs to keep onset array ≤ 6000 frames
    while (onsetStrength.length > 6000) {
      const pooled: number[] = [];
      for (let i = 0; i < onsetStrength.length - 1; i += 2) {
        pooled.push(Math.max(onsetStrength[i]!, onsetStrength[i + 1]!));
      }
      if (onsetStrength.length % 2 === 1) {
        pooled.push(onsetStrength[onsetStrength.length - 1]!);
      }
      onsetStrength = pooled;
      hopMs *= 2;
    }

    const durationSeconds = numSamples / sampleRate;

    return {
      peaks,
      onsetStrength,
      hopMs,
      durationSeconds,
      clipDurationBeats: clip.duration,
      clipName: clip.name,
      clipCount: jobs.length,
    };
  } catch (err) {
    console.error("Beat Slicer: prepareDialogData failed:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// Snap a time (in beats) to the nearest grid division
// ─────────────────────────────────────────────

function snapToGrid(beatTime: number, gridBeats: number): number {
  return Math.round(beatTime / gridBeats) * gridBeats;
}

// ─────────────────────────────────────────────
// Find the parent track (and clip slot if Session View) for a clip
// ─────────────────────────────────────────────

function findClipParent(
  clip: AudioClip<V>,
  song: ReturnType<typeof initialize<V>>["application"]["song"]
): { track: AudioTrack<V>; clipSlot: ClipSlot<V> | undefined } | null {
  const clipId = clip.handle.id;
  for (const t of song.tracks) {
    // Session View
    const slot = t.clipSlots.find((cs) => cs.clip?.handle.id === clipId);
    if (slot) return { track: t as AudioTrack, clipSlot: slot };
    // Arrangement View
    if (t.arrangementClips.some((c) => c.handle.id === clipId)) {
      return { track: t as AudioTrack, clipSlot: undefined };
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Collect ClipJobs from various trigger types
// ─────────────────────────────────────────────

function collectFromTrack(
  track: AudioTrack<V>,
  song: ReturnType<typeof initialize<V>>["application"]["song"]
): ClipJob[] {
  const jobs: ClipJob[] = [];
  // Session clips
  for (const slot of track.clipSlots) {
    if (slot.clip instanceof AudioClip) {
      jobs.push({ clip: slot.clip, track, clipSlot: slot });
    }
  }
  // Arrangement clips
  for (const clip of track.arrangementClips) {
    if (clip instanceof AudioClip) {
      jobs.push({ clip, track, clipSlot: undefined });
    }
  }
  return jobs;
}


// ─────────────────────────────────────────────
// Process a single clip: detect transients, write slice WAVs, rebuild clips
// ─────────────────────────────────────────────

async function processClip(
  job: ClipJob,
  settings: SlicerSettings,
  tempDir: string,
  context: ReturnType<typeof initialize<V>>
): Promise<string> {  // returns a short status string for the progress dialog
  const { clip, track, clipSlot } = job;

  // Snapshot clip properties immediately — the handle may become invalid after deletion
  const clipName = clip.name;
  const clipArrangementStart = clip.startTime;

  // ── Read audio ──────────────────────────────
  let wavPath: string;
  if (clipSlot) {
    // Session View: read source file directly
    wavPath = clip.filePath;
    console.log(`Beat Slicer: session clip filePath = "${wavPath}"`);
  } else {
    // Arrangement View: render pre-fx audio from timeline
    console.log(`Beat Slicer: rendering arrangement clip "${clipName}" [${clip.startTime}–${clip.endTime}]`);
    try {
      wavPath = await context.resources.renderPreFxAudio(track, clip.startTime, clip.endTime);
      console.log(`Beat Slicer: rendered to "${wavPath}"`);
    } catch (err) {
      throw new Error(`renderPreFxAudio failed (${err === undefined ? "SDK returned no error — try saving the project first" : String(err)})`);
    }
  }

  const { sampleRate, channelData } = await decodeAudioFile(wavPath);

  if (!channelData || channelData.length === 0) return "skipped (empty audio)";

  // ── Detect transients ────────────────────────
  const transientSeconds = detectTransients(channelData, sampleRate, settings.sensitivity);

  // Always include position 0 as the first slice point
  const allSeconds = [0, ...transientSeconds.filter((t) => t > 0.01)];

  const transientCount = allSeconds.length - 1;
  if (transientCount === 0) {
    throw new Error(`No transients detected — try raising the sensitivity`);
  }

  console.log(`Beat Slicer: "${clip.name}" — ${transientCount} transient(s) at [${transientSeconds.map((t) => t.toFixed(3)).join(", ")}]s`);

  // ── Convert transient times to beats ────────
  const clipDurationBeats = clip.duration;
  const clipDurationSeconds = channelData[0]!.length / sampleRate;
  const secondsPerBeat = clipDurationSeconds / clipDurationBeats;

  const gridBeats = GRID_BEATS[settings.grid] ?? 0.25;
  const clipStartBeat = clipSlot ? 0 : clip.startTime; // in song timeline

  // ── Build slice entries ──────────────────────────────────────────────────
  // Each entry bundles the audio cut range with its placement position, so
  // indices between written WAVs and created clips are always in sync.

  interface SliceEntry {
    cutBeat: number;      // audio starts here (clip-relative beats)
    nextCutBeat: number;  // audio ends here
    placeBeat: number;    // placed at this beat in the arrangement
  }

  const exactBeatOffsets = allSeconds.map((s) => s / secondsPerBeat);

  // Determine where audio cuts happen
  let cutBeats: number[];
  if (settings.snap === "grid") {
    // Snap cut positions to grid and deduplicate
    cutBeats = [...new Set(exactBeatOffsets.map((b) => snapToGrid(b, gridBeats)))].sort((a, b) => a - b);
  } else {
    cutBeats = [...exactBeatOffsets];
  }

  let entries: SliceEntry[] = cutBeats.map((cutBeat, i) => ({
    cutBeat,
    nextCutBeat: cutBeats[i + 1] ?? clipDurationBeats,
    placeBeat: settings.snap === "quantize" ? snapToGrid(cutBeat, gridBeats) : cutBeat,
  }));

  // Quantize: merge consecutive entries that share the same placement beat.
  // Without this, high-sensitivity runs produce dozens of clips all placed at the
  // same grid position, which crashes the Extension Host.
  if (settings.snap === "quantize") {
    const merged: SliceEntry[] = [];
    for (const entry of entries) {
      const last = merged[merged.length - 1];
      if (last && last.placeBeat === entry.placeBeat) {
        last.nextCutBeat = entry.nextCutBeat; // extend audio region
      } else {
        merged.push({ ...entry });
      }
    }
    entries = merged;
  }

  // Remove zero-duration entries
  entries = entries.filter((e) => e.nextCutBeat - e.cutBeat > 0);

  // ── Write individual slice WAV files ─────────
  const safeName = clipName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const writtenSlices: Array<{ entry: SliceEntry; slicePath: string }> = [];

  for (const entry of entries) {
    const startSample = Math.floor(entry.cutBeat * secondsPerBeat * sampleRate);
    const endSample = Math.min(
      Math.floor(entry.nextCutBeat * secondsPerBeat * sampleRate),
      channelData[0]!.length
    );
    if (endSample <= startSample) continue;

    const sliceChannels = channelData.map((ch) => ch.slice(startSample, endSample));
    const encoded = wav.encode(sliceChannels, { sampleRate, float: true, bitDepth: 32 });
    const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const slicePath = path.join(tempDir, `${safeName}_${uid}.wav`);
    await fs.writeFile(slicePath, Buffer.from(encoded));
    writtenSlices.push({ entry, slicePath });
  }

  if (writtenSlices.length === 0) return "skipped (no valid slices)";

  // ── Pass slice paths directly to Live ───────────────────────────────────────
  // importIntoProject requires a saved project folder and fails on unsaved sets.
  // createAudioClip accepts any path Live can read, including the extension's
  // temp directory, so we pass the temp paths directly. When the user later saves
  // the project, Live will prompt to collect any external samples as normal.
  const importedSlices: Array<{ entry: SliceEntry; projectPath: string }> = [];
  for (const { entry, slicePath } of writtenSlices) {
    importedSlices.push({ entry, projectPath: slicePath });
  }

  // ── Replace original clip with slices ────────────────────────────
  // NOTE: We intentionally do NOT wrap these in withinTransaction — in SDK 1.0.0
  // nested transactions (outer withinTransaction + each SDK method's internal one)
  // cause the operations to fail with undefined rejections. Each SDK call manages
  // its own undo step, which means the user sees a few undo steps instead of one.

  const originalSlotIndex = clipSlot
    ? track.clipSlots.findIndex((cs) => cs.handle.id === clipSlot.handle.id)
    : -1;

  // Phase 1: delete original clip first (awaited), then create all slices in parallel.
  // The delete MUST resolve before any create fires — sending both simultaneously
  // lets the create arrive at Live while the slot still has a clip, crashing the host.
  let phase1Results: Array<AudioClip<V> | void>;

  if (clipSlot) {
    console.log(`Beat Slicer: deleting session clip "${clipName}"`);
    await clipSlot.deleteClip().catch(err => {
      throw new Error(`deleteClip failed (${err === undefined ? "SDK returned no error" : String(err)})`);
    });
    console.log(`Beat Slicer: delete done, creating ${importedSlices.length} slice(s)`);

    const createPromises: Promise<AudioClip<V> | void>[] = [];
    for (let i = 0; i < importedSlices.length; i++) {
      const { projectPath, entry } = importedSlices[i]!;
      if (i === 0) {
        console.log(`Beat Slicer: creating slice 0 in original slot, path="${projectPath}"`);
        createPromises.push(
          clipSlot.createAudioClip(projectPath, false).catch(err => {
            throw new Error(`createAudioClip slice 0 in slot failed (${err === undefined ? "SDK returned no error" : String(err)}, path="${projectPath}")`);
          })
        );
      } else {
        const targetSlot = track.clipSlots[originalSlotIndex + i];
        if (!targetSlot || targetSlot.clip) {
          const arrangStart = clipStartBeat + entry.placeBeat;
          console.log(`Beat Slicer: creating slice ${i} in arrangement at beat ${arrangStart}, path="${projectPath}"`);
          createPromises.push(
            track.createAudioClip(projectPath, arrangStart, undefined, false).catch(err => {
              throw new Error(`createAudioClip slice ${i} in arrangement at beat ${arrangStart} failed (${err === undefined ? "SDK returned no error" : String(err)})`);
            })
          );
        } else {
          console.log(`Beat Slicer: creating slice ${i} in slot ${originalSlotIndex + i}, path="${projectPath}"`);
          createPromises.push(
            targetSlot.createAudioClip(projectPath, false).catch(err => {
              throw new Error(`createAudioClip slice ${i} in slot ${originalSlotIndex + i} failed (${err === undefined ? "SDK returned no error" : String(err)})`);
            })
          );
        }
      }
    }
    phase1Results = await Promise.all(createPromises);
  } else {
    console.log(`Beat Slicer: deleting arrangement clip "${clipName}"`);
    await track.deleteClip(clip).catch(err => {
      throw new Error(`deleteClip failed (${err === undefined ? "SDK returned no error" : String(err)})`);
    });
    console.log(`Beat Slicer: delete done, creating ${importedSlices.length} slice(s)`);

    const createPromises = importedSlices.map(({ entry, projectPath }, i) => {
      const sliceStart = clipArrangementStart + entry.placeBeat;
      console.log(`Beat Slicer: creating arrangement slice ${i} at beat ${sliceStart}, path="${projectPath}"`);
      return track.createAudioClip(projectPath, sliceStart, undefined, false).catch(err => {
        throw new Error(`createAudioClip slice ${i} at beat ${sliceStart} failed (${err === undefined ? "SDK returned no error" : String(err)})`);
      });
    });
    phase1Results = await Promise.all(createPromises);
  }
  const newClips = phase1Results.filter((c): c is AudioClip => c instanceof AudioClip);

  // Phase 2: rename all slices — one undo step
  context.withinTransaction(() => {
    for (let i = 0; i < newClips.length; i++) {
      newClips[i]!.name = `${clipName} ${i + 1}`;
    }
  });

  for (const { slicePath } of writtenSlices) {
    try { await fs.unlink(slicePath); } catch { /* ignore */ }
  }

  const placed = importedSlices.length;
  console.log(`Beat Slicer: "${clipName}" — placed ${placed} slice(s)`);
  return `${transientCount} transient(s) → ${placed} slice(s)`;
}

// ─────────────────────────────────────────────
// Show settings dialog
// ─────────────────────────────────────────────

async function showDialog(context: ReturnType<typeof initialize<V>>, data?: DialogData | null): Promise<SlicerSettings | null> {
  const injected = dialogHtml.replace(
    "/*__WAVEFORM_DATA__*/null",
    data ? JSON.stringify(data) : "null"
  );
  const dialog = context.createModalDialog();
  const width  = 500;
  const height = data ? 360 : 280;
  const resultJson = await dialog.show(
    `data:text/html,${encodeURIComponent(injected)}`,
    width,
    height
  );
  try {
    const result = JSON.parse(resultJson) as SlicerSettings;
    if (result.cancelled) return null;
    return result;
  } catch {
    // Native window close or empty result — treat as cancel
    return null;
  }
}

// ─────────────────────────────────────────────
// Run the full pipeline: dialog → progress → done
// ─────────────────────────────────────────────

async function runSlicer(jobs: ClipJob[], context: ReturnType<typeof initialize<V>>): Promise<void> {
  if (jobs.length === 0) return;

  const dialogData = await prepareDialogData(jobs, context).catch(() => null);
  const settings = await showDialog(context, dialogData);
  if (!settings) return;

  const tempDir = context.environment.tempDirectory ?? "/tmp";
  const errors: string[] = [];

  await context.withinProgressDialog(
    "Beat Slicer",
    { progress: 0 },
    async (update, signal) => {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const pct = Math.round(((i + 1) / jobs.length) * 100);
        update(`Slicing: ${job.clip.name} (${i + 1} of ${jobs.length})`, pct);
        if (signal.aborted) break;
        try {
          const status = await processClip(job, settings, tempDir, context);
          update(`${job.clip.name}: ${status}`, pct);
        } catch (err) {
          const msg = err instanceof Error
            ? err.message
            : err === undefined
              ? "Clip operation failed — check runner.cjs output for details"
              : String(err);
          console.error(`Beat Slicer: failed on "${job.clip.name}":`, err);
          errors.push(`${job.clip.name}: ${msg}`);
          update(`${job.clip.name}: ${msg}`, pct);
        }
      }
      update(errors.length === 0 ? "Done" : `Done — ${errors.length} error(s)`, 100);
    }
  );

  if (errors.length > 0) {
    const items = errors
      .map((e) => `<p style="margin:0 0 8px;word-break:break-word">${e.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
      .join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#383838;color:#fff;font-family:'Lucida Grande',sans-serif;font-size:12px;padding:16px;display:flex;flex-direction:column;gap:12px}
      h3{font-size:13px;color:#FFA500}
      .msgs{color:#ccc;max-height:120px;overflow-y:auto}
      button{background:#FFA500;color:#000;border:none;border-radius:2px;padding:6px 16px;font-size:11px;cursor:pointer;align-self:flex-end}
    </style></head>
    <body oncontextmenu="return false">
      <h3>Beat Slicer</h3>
      <div class="msgs">${items}</div>
      <button onclick="(window.webkit?.messageHandlers?.live??window.chrome?.webview)?.postMessage({method:'close_and_send',params:['{}']})">OK</button>
    </body></html>`;
    const errDialog = context.createModalDialog();
    await errDialog.show(`data:text/html,${encodeURIComponent(html)}`, 360, 220);
  }
}

// ─────────────────────────────────────────────
// Activation entry point
// ─────────────────────────────────────────────

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const song = context.application.song;

  // ── 1. Single audio clip (Session or Arrangement) ──
  context.commands.registerCommand("beat-slicer.sliceClip", (arg: unknown) => {
    (async () => {
      const clip = context.objects.getObjectFromHandle(arg as Handle, Clip);
      if (!(clip instanceof AudioClip)) return;
      const parent = findClipParent(clip, song);
      if (!parent) return;
      await runSlicer([{ clip, ...parent }], context);
    })().catch((err) => console.error("Beat Slicer unhandled error:", err));
  });

  context.ui.registerContextMenuAction("AudioClip", "Slice", "beat-slicer.sliceClip");

  // ── 2. Single audio track (all clips on track) ──
  context.commands.registerCommand("beat-slicer.sliceTrack", (arg: unknown) => {
    (async () => {
      const track = context.objects.getObjectFromHandle(arg as Handle, AudioTrack);
      if (!(track instanceof AudioTrack)) return;
      const jobs = collectFromTrack(track, song);
      await runSlicer(jobs, context);
    })().catch((err) => console.error("Beat Slicer unhandled error:", err));
  });

  context.ui.registerContextMenuAction("AudioTrack", "Slice All Clips", "beat-slicer.sliceTrack");
}
