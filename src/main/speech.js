'use strict';

const path = require('node:path');
const { app } = require('electron');

const MODEL = 'onnx-community/whisper-tiny';
// Pin the reviewed Hugging Face snapshot so a change to the model's `main` branch cannot
// silently change what Capri downloads on a later first launch.
const MODEL_REVISION = 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7';
const LANGUAGE_NAMES = Object.freeze({
  'fr-FR': 'french',
  'en-US': 'english',
  'es-ES': 'spanish',
  'pt-BR': 'portuguese',
  'ru-RU': 'russian',
});

let pipelinePromise = null;
const progressListeners = new Set();

async function getTranscriber(onProgress) {
  if (onProgress) progressListeners.add(onProgress);
  try {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        env.cacheDir = path.join(app.getPath('userData'), 'speech-models');
        return pipeline('automatic-speech-recognition', MODEL, {
          revision: MODEL_REVISION,
          dtype: 'q8',
          progress_callback: (progress) => {
            for (const listener of progressListeners) listener(progress);
          },
        });
      })();
      pipelinePromise.catch(() => { pipelinePromise = null; });
    }
    return await pipelinePromise;
  } finally {
    if (onProgress) progressListeners.delete(onProgress);
  }
}

async function transcribe(audio, language) {
  const transcriber = await getTranscriber();
  const result = await transcriber(audio, { language: LANGUAGE_NAMES[language], task: 'transcribe' });
  return typeof result?.text === 'string' ? result.text.trim().slice(0, 1000) : '';
}

module.exports = { getTranscriber, transcribe, LANGUAGE_NAMES };
