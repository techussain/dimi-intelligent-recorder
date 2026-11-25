/**
 * Post-stop finalization of recorded files.
 *
 * MediaRecorder writes "live" WebM: no Duration element and no Cues, so every
 * seek has to scan the file and the duration is unknown until read to the end.
 * After a take stops we:
 *   1. remux each file (packet copy, no re-encode) into a new OPFS file with a
 *      proper duration + cues, and point the source at it (the raw file
 *      is kept: an autosaved project may still reference it);
 *   2. read the real media duration and correct the clip / source length,
 *      which were estimated from the wall clock while recording (the clip
 *      keeps its end; see anchorRecordedClip);
 *   3. in the desktop app, save a copy of the final file into the
 *      recordings folder on disk and remember its path (`diskPath`).
 *
 * Any failure leaves the original recording untouched and in use.
 */
import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny'
import { useEditor } from '../timeline/store'
import { loadStoredProject, updateStoredProject } from '../persistence/project'
import { deletePath, readFile } from '../storage/opfs'
import { trashMedia } from '../storage/mediaGc'
import {
  extOf,
  isDiskMediaAvailable,
  recordingRelPath,
  saveToDisk,
  sourceFileLabel,
} from '../storage/diskMedia'
import type { ID, Project } from '../timeline/types'
import { clipEndSec } from '../timeline/selectors'
import { anchorRecordedClip } from '../timeline/recordedClip'

export interface RecordedFile {
  sourceId: ID
  /** Clip created for this recording (null if no chunk ever landed). */
  clipId: ID | null
  opfsPath: string
  /** sourceOut the clip was finalized with (wall-clock estimate). */
  estimatedDurationSec: number
  /**
   * Recovered after a crash: the clip was saved at the last checkpoint, so
   * the footage it lacks is at the end (see anchorRecordedClip).
   */
  interrupted?: boolean | undefined
}

/** Duration of a media file in seconds (largest end timestamp over tracks). */
async function readDuration(file: Blob): Promise<number> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    return await input.computeDuration()
  } finally {
    input.dispose()
  }
}

async function openWritable(path: string): Promise<FileSystemWritableFileStream> {
  const segs = path.replace(/^\/+|\/+$/g, '').split('/')
  const name = segs.pop() ?? ''
  let dir = await navigator.storage.getDirectory()
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true })
  const handle = await dir.getFileHandle(name, { create: true })
  return await handle.createWritable()
}

/**
 * Copy every packet of `src` into a new Matroska/WebM file at `destPath`.
 * Returns false (and writes nothing usable) if a track can't be copied as-is.
 */
async function remux(src: Blob, destPath: string): Promise<boolean> {
  const input = new Input({ source: new BlobSource(src), formats: ALL_FORMATS })
  let writable: FileSystemWritableFileStream | null = null
  try {
    const tracks = await input.getTracks()
    if (tracks.length === 0) return false
    const codecs = tracks.map((t) => t.codec)
    // WebM only allows VP8/VP9/AV1/Opus/Vorbis; H.264 recordings go into
    // plain Matroska (same demuxer in Chromium and mediabunny).
    const webm = new WebMOutputFormat()
    const format = codecs.every((c) => c && webm.getSupportedCodecs().includes(c))
      ? webm
      : new MkvOutputFormat()
    if (!codecs.every((c) => c && format.getSupportedCodecs().includes(c))) return false

    writable = await openWritable(destPath)
    const output = new Output({
      format,
      target: new StreamTarget(
        writable as unknown as WritableStream<StreamTargetChunk>,
        { chunked: true },
      ),
    })
    const pumps: Array<() => Promise<void>> = []
    for (const track of tracks) {
      if (track.isVideoTrack() && track.codec) {
        const source = new EncodedVideoPacketSource(track.codec)
        output.addVideoTrack(source)
        pumps.push(async () => {
          const cfg = await track.getDecoderConfig()
          const meta = cfg ? { decoderConfig: cfg } : {}
          for await (const packet of new EncodedPacketSink(track).packets())
            await source.add(packet, meta)
          source.close()
        })
      } else if (track.isAudioTrack() && track.codec) {
        const source = new EncodedAudioPacketSource(track.codec)
        output.addAudioTrack(source)
        pumps.push(async () => {
          const cfg = await track.getDecoderConfig()
          const meta = cfg ? { decoderConfig: cfg } : {}
          for await (const packet of new EncodedPacketSink(track).packets())
            await source.add(packet, meta)
          source.close()
        })
      }
    }
    await output.start()
    await Promise.all(pumps.map((p) => p()))
    // finalize() writes duration + cues and closes (commits) the writable.
    await output.finalize()
    writable = null
    return true
  } finally {
    input.dispose()
    // Only reached on failure: discard the partial temp file.
    if (writable) await writable.abort().catch(() => {})
  }
}

/** The open project's store, if `projectId` is the open project. */
function openStore(projectId: ID) {
  const store = useEditor.getState()
  return store.project.id === projectId ? store : null
}

/**
 * Apply a change to the take's project wherever it lives now: the open
 * project in the store (`open`), or — if the user switched projects since
 * the take stopped — its autosaved copy (`stored`, returns true if changed).
 * Checks again after the stored write, in case the project was opened
 * meanwhile (otherwise its next autosave would overwrite the change).
 */
async function applyToTake(
  projectId: ID,
  open: (store: ReturnType<typeof useEditor.getState>) => void,
  stored: (project: Project) => boolean,
): Promise<void> {
  const now = openStore(projectId)
  if (now) {
    open(now)
    return
  }
  await updateStoredProject(projectId, stored)
  const reopened = openStore(projectId)
  if (reopened) open(reopened)
}

/** The take's project: the open one, else its autosaved copy. */
async function takeProject(projectId: ID): Promise<Project | null> {
  return openStore(projectId)?.project ?? (await loadStoredProject(projectId))
}

/** Finalize one recorded file. Resolves true if the remux was applied. */
async function finalizeOne(rec: RecordedFile, projectId: ID): Promise<boolean> {
  const raw = await readFile(rec.opfsPath)
  if (raw.size === 0) return false

  const finalPath = rec.opfsPath.replace(/(\.[^./]+)?$/, '.final$1')
  let remuxed = false
  let duration = 0
  try {
    if (await remux(raw, finalPath)) {
      // Verify the new file before switching over to it.
      duration = await readDuration(await readFile(finalPath))
      remuxed = duration > 0
    }
  } catch (err) {
    console.warn('[finalizeRecording] remux failed, keeping original', err)
  }
  if (!remuxed) {
    await deletePath(finalPath).catch(() => {})
    duration = await readDuration(raw)
  }

  const source = (await takeProject(projectId))?.sources.find(
    (x) => x.id === rec.sourceId,
  )
  // Source removed meanwhile (or the project deleted): nothing to update.
  if (!source) {
    if (remuxed) await deletePath(finalPath).catch(() => {})
    return false
  }
  // updateSource patches media fields without an undo step (and in history
  // snapshots too), so undo never revives the old path.
  if (remuxed && source.opfsPath === rec.opfsPath) {
    await applyToTake(
      projectId,
      (store) => {
        const cur = store.project.sources.find((x) => x.id === rec.sourceId)
        if (cur?.opfsPath === rec.opfsPath)
          store.updateSource(rec.sourceId, { opfsPath: finalPath })
      },
      (p) => {
        const s = p.sources.find((x) => x.id === rec.sourceId)
        if (s?.opfsPath !== rec.opfsPath) return false
        s.opfsPath = finalPath
        return true
      },
    )
    // The raw file is now unused by this project; hand it to the media GC,
    // which deletes it once no autosaved project still points at it.
    void trashMedia([rec.opfsPath]).catch(() => {})
  }

  if (duration > 0 && Number.isFinite(duration)) {
    await applyToTake(
      projectId,
      (store) => {
        store.updateSourceDuration(rec.sourceId, duration)
        const clip = rec.clipId
          ? store.project.clips.find((c) => c.id === rec.clipId)
          : undefined
        // Only correct a clip the user hasn't trimmed since the take stopped.
        // No undo step: this is a correction of the take, not an edit.
        if (clip && Math.abs(duration - clip.sourceOut) > 0.01) {
          store.reconcileRecordedClip(
            clip.id,
            rec.estimatedDurationSec,
            duration,
            !rec.interrupted,
          )
        }
      },
      (p) => {
        const s = p.sources.find((x) => x.id === rec.sourceId)
        if (!s) return false
        s.duration = duration
        const c = rec.clipId ? p.clips.find((x) => x.id === rec.clipId) : undefined
        if (
          c &&
          !c.isLive &&
          Math.abs(c.sourceOut - rec.estimatedDurationSec) <= 1e-6
        ) {
          anchorRecordedClip(c, rec.estimatedDurationSec, duration, !rec.interrupted)
          p.duration = Math.max(0, ...p.clips.map(clipEndSec))
        }
        return true
      },
    )
  }
  return remuxed
}

/**
 * Finalize every file of a take, one after another (each remux reads and
 * writes the whole file; running them in parallel only thrashes the disk).
 * `projectId` is the project the take was recorded into: the results go
 * there even if another project has been opened since. Never throws.
 */
export async function finalizeRecordedFiles(
  files: RecordedFile[],
  projectId: ID,
): Promise<void> {
  // One timestamp for the whole take, so its files sort together on disk.
  const takeDate = await takeStart(files, projectId)
  for (const f of files) {
    try {
      await finalizeOne(f, projectId)
    } catch (err) {
      console.warn('[finalizeRecording] could not finalize', f.opfsPath, err)
    }
    try {
      await saveRecordingToDisk(f, takeDate, projectId)
    } catch (err) {
      console.warn('[finalizeRecording] could not save to disk', f.opfsPath, err)
    }
  }
}

async function takeStart(files: RecordedFile[], projectId: ID): Promise<Date> {
  const ids = new Set(files.map((f) => f.sourceId))
  const project = await takeProject(projectId).catch(() => null)
  const times = (project?.sources ?? [])
    .filter((s) => ids.has(s.id))
    .map((s) => s.createdAt)
  return new Date(times.length > 0 ? Math.min(...times) : Date.now())
}

/**
 * Copy the source's current (final, or raw if the remux failed) file into the
 * recordings folder and set its diskPath. Desktop app only.
 */
async function saveRecordingToDisk(
  rec: RecordedFile,
  date: Date,
  projectId: ID,
): Promise<void> {
  if (!isDiskMediaAvailable()) return
  const project = await takeProject(projectId)
  const source = project?.sources.find((x) => x.id === rec.sourceId)
  // Removed meanwhile (or the project deleted), or already saved.
  if (!project || !source?.opfsPath || source.diskPath) return
  const opfsPath = source.opfsPath
  const rel = recordingRelPath(
    project.name,
    sourceFileLabel(source, project),
    date,
    extOf(opfsPath),
  )
  const diskPath = await saveToDisk(opfsPath, rel, { what: 'recording' })
  if (!diskPath) return
  await applyToTake(
    projectId,
    (store) => {
      const still = store.project.sources.find((x) => x.id === rec.sourceId)
      if (still && still.opfsPath === opfsPath)
        store.updateSource(rec.sourceId, { diskPath })
    },
    (p) => {
      const s = p.sources.find((x) => x.id === rec.sourceId)
      if (!s || s.opfsPath !== opfsPath) return false
      s.diskPath = diskPath
      return true
    },
  )
}
