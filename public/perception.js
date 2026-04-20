// Constant-cheap perception loop — runs LFM2.5-VL-450M via Transformers.js
// + WebGPU against a robot's camera feed, every ~2 seconds, and stashes
// the scene description on the entry. Pip can read the latest observation
// via the get_robot_scene tool (pip-tools.js), so she can reason about
// what the robot sees without the user typing anything.
//
// Pattern mirrors ~/Github/jonasneves/catwatcher/app.js — same model, same
// AutoModelForImageTextToText / AutoProcessor sequence, same drawImage
// → getImageData → RawImage capture. Prompt is tuned for indoor-robot
// scenes instead of cats.
//
// Known limits of this VLM (from duke-ai/validation experimentation):
//   - Cannot precisely localize objects (~0% recall@0.3 for bbox detection).
//     Usable for "I see X" semantics, NOT for "turn 12° left to track X".
//   - Hallucinates colors. Don't trust "brown" on a gray thing.
//   - Directive prompts > question prompts. "Describe …" not "Is there …".
//
// Cost envelope:
//   ~770 MB first-time download (q4 quantization), ~1-2 GB VRAM at run,
//   ~1-1.5 s per inference on a modern WebGPU desktop. Zero API spend.
//   The loop only runs while the user explicitly toggles "Watch" on a
//   robot — no idle GPU drain.
import { state } from "./state.js";

const MODEL_ID = "LiquidAI/LFM2.5-VL-450M-ONNX";
const DTYPE = { vision_encoder: "fp16", embed_tokens: "fp16", decoder_model_merged: "q4" };
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers";
const POLL_MS = 2000;
const MAX_NEW_TOKENS = 128;
const DEFAULT_PROMPT = "Describe what you see in this image in one or two short sentences. Focus on objects, obstacles, people, and environment features a small indoor robot would care about. Be specific. Don't ask questions.";

let _tf = null;
let _model = null;
let _processor = null;
let _loadingPromise = null;

export function isSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

export function isModelLoaded() { return !!_model; }

async function ensureModel(onProgress) {
  if (_model) return;
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = (async () => {
    _tf = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    _model = await _tf.AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
      device: "webgpu",
      dtype: DTYPE,
      progress_callback: onProgress,
    });
    _processor = await _tf.AutoProcessor.from_pretrained(MODEL_ID);
  })();
  try { await _loadingPromise; }
  catch (err) { _loadingPromise = null; throw err; }
}

// Find the camera element this entry is rendering. Either:
//   <img class="robot-camera">     (ESP32 MJPEG — CORS set by firmware)
//   <video data-*-id="${id}">      (Pi WebRTC — MediaStream, always readable)
// One card has at most one of either, so a naive selector within entry.node
// is correct.
function findCameraElement(entry) {
  const node = entry.node;
  if (!node) return null;
  return node.querySelector("img.robot-camera") || node.querySelector("video[data-camera-id], video");
}

function captureFrame(entry, maxDim = 512) {
  const source = findCameraElement(entry);
  if (!source) return null;
  let w = source.naturalWidth || source.videoWidth;
  let h = source.naturalHeight || source.videoHeight;
  if (!w || !h) return null;
  // VLM runs plenty fast at 512 max dim; downscale keeps GPU work modest.
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  try {
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    // Tainted canvas → firmware didn't serve CORS + the <img> is missing
    // crossOrigin="anonymous". Surface null; caller logs once.
    return null;
  }
}

async function runInference(entry, prompt) {
  const frame = captureFrame(entry);
  if (!frame) return null;
  const image = new _tf.RawImage(frame.data, frame.width, frame.height, 4);
  const messages = [{
    role: "user",
    content: [{ type: "image" }, { type: "text", text: prompt }],
  }];
  const chatPrompt = _processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await _processor(image, chatPrompt, { add_special_tokens: false });
  const outputs = await _model.generate({ ...inputs, do_sample: false, max_new_tokens: MAX_NEW_TOKENS });
  const decoded = _processor.batch_decode(
    outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
    { skip_special_tokens: true },
  );
  return decoded[0]?.trim() || null;
}

// id → { timer, running, onScene, onError }
const _loops = new Map();

export function isWatching(id) { return _loops.has(id); }

export function getLatestScene(id) {
  const entry = state.devices.get(id);
  return entry?.vlmScene || null;
}

export async function startWatching(entry, opts = {}) {
  const { onProgress, onScene, onError, prompt = DEFAULT_PROMPT } = opts;
  if (!isSupported()) throw new Error("WebGPU not available in this browser");
  if (_loops.has(entry.id)) return;
  const loop = { timer: null, running: false, stopped: false, onScene, onError };
  _loops.set(entry.id, loop);
  try { await ensureModel(onProgress); }
  catch (err) { _loops.delete(entry.id); throw err; }

  const tick = async () => {
    if (loop.stopped) return;
    if (loop.running) { loop.timer = setTimeout(tick, POLL_MS); return; }
    loop.running = true;
    try {
      const text = await runInference(entry, prompt);
      if (text) {
        entry.vlmScene = { text, at: Date.now() };
        loop.onScene?.(text);
      }
    } catch (err) {
      loop.onError?.(err);
    } finally {
      loop.running = false;
    }
    if (!loop.stopped) loop.timer = setTimeout(tick, POLL_MS);
  };
  tick();
}

export function stopWatching(id) {
  const loop = _loops.get(id);
  if (!loop) return;
  loop.stopped = true;
  if (loop.timer) clearTimeout(loop.timer);
  _loops.delete(id);
}
