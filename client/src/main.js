import { LogLevel, SimliClient } from "simli-client";

console.log("MAIN JS LOADED");

/*
  OPTIMUM HYBRID FLOW
  -------------------
  Browser SpeechRecognition = detects if user is speaking + unclear speech check only
  MediaRecorder = captures real user audio as WebM/Opus
  Backend = decode audio → STT → LLM → TTS → PCM chunks
  Simli = only receives timed PCM chunks
*/

let simliClient = null;
let avatarWs = null;
let mediaRecorder = null;
let recordedChunks = [];
let micStream = null;
let recognition = null;
let activeAudioTurnId = null;
let expectedAudioSeq = 0;
let pendingAudioChunks = new Map();
let backendAudioEnded = false;

let isReconnectingPythonWs = false;
let reconnectAttempts = 0;
const MAX_WS_RECONNECT_ATTEMPTS = 3;

let isAvatarSpeaking = false;

let silenceInterval = null;
let listenRestartTimer = null;
let finalSpeechTimer = null;
let backendTurnTimeoutTimer = null;

let appConfig = null;

let isSessionActive = false;
let isSimliConnected = false;
let isPythonConnected = false;
let isProcessingTurn = false;
let isRecordingTurn = false;
let isListening = false;
let isGreetingTurn = false;

let pendingTranscript = "";
let gotAnySpeech = false;
let currentBackendTurn = null;
let backendAudioChunksInTurn = 0;

const EXPRESS_BASE = "http://localhost:3000";

const HUMAN_PAUSE_MS = 2300;
const MIN_TRANSCRIPT_CHARS = 4;
const BACKEND_TURN_TIMEOUT_MS = 30000;

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

async function reconnectPythonWsAndResume() {
  if (!isSessionActive) return;
  if (isReconnectingPythonWs) return;

  isReconnectingPythonWs = true;
  reconnectAttempts += 1;

  try {
    if (reconnectAttempts > MAX_WS_RECONNECT_ATTEMPTS) {
      setStatus("backend reconnect failed");
      isReconnectingPythonWs = false;
      return;
    }

    setStatus("reconnecting backend");

    if (avatarWs) {
      try {
        avatarWs.onopen = null;
        avatarWs.onmessage = null;
        avatarWs.onerror = null;
        avatarWs.onclose = null;
        avatarWs.close();
      } catch {}

      avatarWs = null;
    }

    await sleep(1000);

    await connectPythonAvatarWs();

    reconnectAttempts = 0;
    isReconnectingPythonWs = false;

    isProcessingTurn = false;
    isAvatarSpeaking = false;
    isGreetingTurn = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;
    resetAudioTurnState();

    setStatus("listening");
    scheduleListening(500);
  } catch (err) {
    console.error("PYTHON WS RECONNECT FAILED:", err);

    isPythonConnected = false;
    isReconnectingPythonWs = false;

    setTimeout(() => {
      reconnectPythonWsAndResume();
    }, 1500);
  }
}

function speakBrowserFallback(text) {
  try {
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1;

    utterance.onstart = () => {
      isAvatarSpeaking = true;
      isProcessingTurn = true;
      stopListening();
      setStatus("speaking fallback");
    };

    utterance.onend = () => {
      isAvatarSpeaking = false;
      isProcessingTurn = false;
      setStatus("listening");

      reconnectPythonWsAndResume();
    };

    utterance.onerror = () => {
      isAvatarSpeaking = false;
      isProcessingTurn = false;
      reconnectPythonWsAndResume();
    };

    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.error("BROWSER FALLBACK SPEECH ERROR:", err);
    isAvatarSpeaking = false;
    isProcessingTurn = false;
    reconnectPythonWsAndResume();
  }
}

function setStatus(text) {
  console.log("STATUS:", text);

  if (statusEl) {
    statusEl.innerText = `Status: ${text}`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStoredValue(key) {
  return String(
    localStorage.getItem(key) ||
      sessionStorage.getItem(key) ||
      ""
  ).trim();
}

function stripBearerPrefix(value) {
  const raw = String(value || "").trim();

  if (!raw) return "";

  const token = raw.toLowerCase().startsWith("bearer ")
    ? raw.slice(7).trim()
    : raw;

  return token.replace(/\s+/g, "");
}

function getAuthData() {
  let authUser = null;

  try {
    authUser = JSON.parse(getStoredValue("authUser") || "null");
  } catch {
    authUser = null;
  }

  const token = stripBearerPrefix(getStoredValue("authToken"));

  return {
    token,
    sessionId: getStoredValue("tekkdev_session_id"),
    userId: getStoredValue("user_id") || authUser?.user_id || "test",
    apiKey: authUser?.api_key || null,
  };
}

function getVoiceId() {
  return (
    localStorage.getItem("voice_id") ||
    localStorage.getItem("avatar_voice_id") ||
    localStorage.getItem("selectedVoiceId") ||
    localStorage.getItem("elevenlabs_voice_id") ||
    appConfig?.defaultVoiceId ||
    ""
  );
}

function normalizeWsBase(base) {
  return String(base || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/^http:\/\//i, "ws://")
    .replace(/^https:\/\//i, "wss://");
}

function buildAvatarWsUrl(avatarId) {
  const auth = getAuthData();
  const wsBase = normalizeWsBase(appConfig.pythonWsBase);

  const params = new URLSearchParams();
  params.set("avatar_id", avatarId);

  if (auth.token) params.set("token", auth.token);
  if (auth.sessionId) params.set("session_id", auth.sessionId);
  if (auth.userId) params.set("user_id", auth.userId);

  return `${wsBase}/ws/voice/stream?${params.toString()}`;
}

function hideTokenInUrl(url) {
  const auth = getAuthData();

  if (!auth.token) return url;

  return String(url).replaceAll(auth.token, "JWT_HIDDEN");
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Int16Array(bytes.buffer);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",")
        ? result.split(",")[1]
        : result;

      resolve(base64);
    };

    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getSpeechRecognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

async function loadConfig() {
  const res = await fetch(`${EXPRESS_BASE}/api/config`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to load config");
  }

  return data;
}

async function getSimliToken() {
  const res = await fetch(`${EXPRESS_BASE}/api/simli-token`, {
    method: "POST",
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to get Simli token");
  }

  return data.session_token;
}

function startSimliKeepAlive() {
  if (silenceInterval) return;

  silenceInterval = setInterval(() => {
    if (!simliClient || !isSimliConnected || !isSessionActive) return;
    if (isProcessingTurn || isAvatarSpeaking) return;

    try {
        const silence = new Uint8Array(640);
        simliClient.sendAudioData(silence);
    } catch (err) {
      console.error("SIMLI KEEP ALIVE ERROR:", err);
    }
  }, 100);
}

function stopSimliKeepAlive() {
  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }
}

function clearBackendTurnTimeout() {
  if (backendTurnTimeoutTimer) {
    clearTimeout(backendTurnTimeoutTimer);
    backendTurnTimeoutTimer = null;
  }
}

function clearListenRestartTimer() {
  if (listenRestartTimer) {
    clearTimeout(listenRestartTimer);
    listenRestartTimer = null;
  }
}

function clearFinalSpeechTimer() {
  if (finalSpeechTimer) {
    clearTimeout(finalSpeechTimer);
    finalSpeechTimer = null;
  }
}

function sendPcmToSimli(pcm) {
  if (!isSessionActive) return;
  if (!simliClient || !isSimliConnected) return;
  if (!pcm || pcm.length === 0) return;

  isProcessingTurn = true;
  isAvatarSpeaking = true;

  stopListening();
  setStatus("avatar speaking");

  try {
    simliClient.sendAudioData(pcm);
  } catch (err) {
    console.error("SIMLI SEND AUDIO ERROR:", err);
  }
}

function resetAudioTurnState() {
  activeAudioTurnId = null;
  expectedAudioSeq = 0;
  pendingAudioChunks.clear();
  backendAudioEnded = false;
}

function acceptBackendAudioChunk(msg) {
  if (msg.sample_rate && Number(msg.sample_rate) !== 16000) {
    console.warn("Invalid sample rate for Simli:", msg.sample_rate);
    return;
  }

  if (!msg.pcm_b64) {
    console.warn("Missing pcm_b64 in audio chunk:", msg);
    return;
  }

  const pcm = base64ToInt16Array(msg.pcm_b64);

  backendAudioChunksInTurn += 1;
  isProcessingTurn = true;
  isAvatarSpeaking = true;

  setStatus("avatar speaking");

  sendPcmToSimli(pcm);
}

function flushPendingAudioChunks() {
  while (pendingAudioChunks.has(expectedAudioSeq)) {
    const pcm = pendingAudioChunks.get(expectedAudioSeq);
    pendingAudioChunks.delete(expectedAudioSeq);

    sendPcmToSimli(pcm);
    backendAudioChunksInTurn += 1;
    expectedAudioSeq += 1;
  }
}

async function connectSimli() {
  const sessionToken = await getSimliToken();

  simliClient = new SimliClient(
    sessionToken,
    videoEl,
    audioEl,
    null,
    LogLevel.ERROR,
    "livekit"
  );

  let startedResolve;
  let startedReject;

  const startedPromise = new Promise((resolve, reject) => {
    startedResolve = resolve;
    startedReject = reject;
  });

  simliClient.on("start", () => {
    isSimliConnected = true;
    setStatus("Simli connected");
    startSimliKeepAlive();
    startedResolve();
  });

  simliClient.on("error", (err) => {
    console.error("SIMLI ERROR:", err);
    isSimliConnected = false;
    setStatus("Simli error");
    startedReject(err);
  });
simliClient.on("speaking", () => {
  isAvatarSpeaking = true;
  isProcessingTurn = true;
  stopListening();
  setStatus("avatar speaking");
});

simliClient.on("silent", () => {
  if (!backendAudioEnded && backendAudioChunksInTurn > 0) {
    return;
  }

  isAvatarSpeaking = false;
  isProcessingTurn = false;
  isGreetingTurn = false;
  currentBackendTurn = null;
  backendAudioChunksInTurn = 0;

  resetAudioTurnState();

  if (isSessionActive) {
    setStatus("listening");
    scheduleListening(150);
  }
});
  await simliClient.start();

  await Promise.race([
    startedPromise,
    sleep(20000).then(() => {
      if (!isSimliConnected) {
        throw new Error("Timed out waiting for Simli start event");
      }
    }),
  ]);
}

function connectPythonAvatarWs() {
  return new Promise((resolve, reject) => {
    const avatarId = appConfig.defaultAvatarId || "ai_engineer";
    const auth = getAuthData();

    if (!auth.token) {
      reject(new Error("Missing authToken in localStorage/sessionStorage"));
      return;
    }

    const wsUrl = buildAvatarWsUrl(avatarId);

    console.log("CONNECTING PYTHON WS:", hideTokenInUrl(wsUrl));

    avatarWs = new WebSocket(wsUrl);
    avatarWs.binaryType = "arraybuffer";

    let resolved = false;

    avatarWs.onopen = () => {
      console.log("PYTHON WS CONNECTED");

      isPythonConnected = true;
      resolved = true;

      resolve();
    };

    avatarWs.onmessage = async (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          if (!simliClient || !isSimliConnected) return;

          backendAudioChunksInTurn += 1;

          sendPcmToSimli(new Uint8Array(event.data));
          return;
        }

        const msg = JSON.parse(event.data);
        console.log("PYTHON WS EVENT:", msg.type, msg);

        if (msg.type === "status") {
          if (msg.stage) setStatus(msg.stage);
          return;
        }

        if (msg.type === "transcript") {
          const heardText = msg.text || msg.transcript || "";

          console.log("BACKEND TRANSCRIPT:", heardText);

          if (isGreetingTurn) {
            setStatus("greeting user");
            return;
          }

          if (heardText.trim()) {
            setStatus(`heard: ${heardText}`);
          }

          return;
        }

        if (
          msg.type === "llm_text_delta" ||
          msg.type === "assistant_delta" ||
          msg.type === "thinking"
        ) {
          setStatus("thinking");
          return;
        }

        if (msg.type === "llm_text_final" || msg.type === "assistant_final") {
          if (msg.text && msg.text.trim()) {
            console.log("ASSISTANT TEXT:", msg.text);
          }
          return;
        }

        if (
          msg.type === "audio_chunk" ||
          msg.type === "tts_audio_chunk" ||
          msg.type === "avatar_audio_chunk"
        ) {
          acceptBackendAudioChunk(msg);
  return;
        }

        if (
          msg.type === "audio_end" ||
          msg.type === "turn_complete" ||
          msg.type === "done" ||
          msg.type === "tts_audio_end" ||
          msg.type === "avatar_audio_end"
        ) {
          await handleBackendAudioEnd(msg);
          return;
        }

        if (msg.type === "error") {
          console.error("PYTHON BACKEND ERROR:", msg);

          isProcessingTurn = false;
          isGreetingTurn = false;
          isAvatarSpeaking = false;
          currentBackendTurn = null;
          backendAudioChunksInTurn = 0;
          clearBackendTurnTimeout();

          setStatus(msg.message || msg.error || "backend error");

          if (isSessionActive) {
            scheduleListening(1200);
          }

          return;
        }
      } catch (err) {
        console.error("WS MESSAGE ERROR:", err, event.data);
      }
    };

    avatarWs.onerror = (err) => {
      console.error("PYTHON WS ERROR:", err);
      isPythonConnected = false;

      if (!resolved) reject(err);
    };

   avatarWs.onclose = (event) => {
  console.log("PYTHON WS CLOSED");
  console.log("Close code:", event.code);
  console.log("Close reason:", event.reason);

  isPythonConnected = false;

  if (!resolved) {
    reject(new Error(`Python WS closed before open: ${event.code}`));
    return;
  }

  if (!isSessionActive) return;

  clearBackendTurnTimeout();

  isProcessingTurn = false;
  isGreetingTurn = false;
  isAvatarSpeaking = false;
  currentBackendTurn = null;
  backendAudioChunksInTurn = 0;
  resetAudioTurnState();

  setStatus(`backend disconnected: ${event.code}`);

  if (event.code === 1006) {
    speakBrowserFallback(
      "Sorry, I had trouble processing that. Please ask again."
    );
    return;
  }

  reconnectPythonWsAndResume();
};
  });
}

async function handleBackendAudioEnd(msg = {}) {
  clearBackendTurnTimeout();

  backendAudioEnded = true;
  flushPendingAudioChunks();

  const chunksFromBackend =
    Number(msg.chunks_sent || msg.chunks || msg.audio_chunks || 0) ||
    backendAudioChunksInTurn;

  console.log("BACKEND AUDIO END:", {
    currentBackendTurn,
    activeAudioTurnId,
    expectedAudioSeq,
    chunksFromBackend,
    pendingChunks: pendingAudioChunks.size,
    msg,
  });

  if (chunksFromBackend <= 0) {
    isProcessingTurn = false;
    isGreetingTurn = false;
    isAvatarSpeaking = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;
    resetAudioTurnState();

    setStatus("backend returned no audio");
    await sendBackendTextAsSpeech(
  "I couldn't find enough information about that. Please ask something else.",
  "fallback"
);
    scheduleListening(500);
    return;
  }

  setStatus("avatar finishing");
}

async function setupMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  setStatus("mic ready");
}

function startTurnRecording() {
  if (isRecordingTurn) return;
  if (!micStream) return;
  if (!avatarWs || avatarWs.readyState !== WebSocket.OPEN) return;

  recordedChunks = [];

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  mediaRecorder = new MediaRecorder(micStream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    try {
      isRecordingTurn = false;

      if (!recordedChunks || recordedChunks.length === 0) {
        console.warn("No recorded audio chunks found");
        isProcessingTurn = false;
        scheduleListening(800);
        return;
      }

      const audioBlob = new Blob(recordedChunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });

      recordedChunks = [];

      if (!audioBlob.size) {
        console.warn("Audio blob is empty");
        isProcessingTurn = false;
        scheduleListening(800);
        return;
      }

      const base64Audio = await blobToBase64(audioBlob);

      if (!base64Audio) {
        console.warn("Base64 audio is empty");
        isProcessingTurn = false;
        scheduleListening(800);
        return;
      }

      const auth = getAuthData();
      const voiceId = getVoiceId();

      currentBackendTurn = "user";
      backendAudioChunksInTurn = 0;

    const payload = {
  type: "user_audio",
  audio_base64: base64Audio,
  mime_type: mediaRecorder.mimeType || "audio/webm",
  format: "webm_opus",
  session_id: auth.sessionId,
  user_id: auth.userId,
  avatar_id: appConfig?.defaultAvatarId || "ai_engineer",
  voice_id: voiceId,
  control_transcript: pendingTranscript.trim(),
};

      avatarWs.send(JSON.stringify(payload));

      console.log("WEBM AUDIO SENT TO BACKEND:", {
        type: payload.type,
        mime_type: payload.mime_type,
        format: payload.format,
        audioLength: payload.audio_base64.length,
        session_id: payload.session_id,
        user_id: payload.user_id,
        avatar_id: payload.avatar_id,
        voice_id: payload.voice_id,
        control_transcript: payload.control_transcript,
      });

      setStatus("processing your voice");
      startBackendTurnTimeout();
    } catch (err) {
      console.error("FINAL AUDIO SEND ERROR:", err);
      isProcessingTurn = false;
      scheduleListening(1000);
    }
  };

  mediaRecorder.start(250);

  isRecordingTurn = true;
  setStatus("hearing you");
}

function stopTurnRecording({ discard = false } = {}) {
  if (!mediaRecorder || !isRecordingTurn) return;

  if (discard) {
    recordedChunks = [];
  }

  try {
    mediaRecorder.stop();
  } catch (err) {
    console.error("MEDIA RECORDER STOP ERROR:", err);
    isRecordingTurn = false;
  }
}

function isValidControlTranscript(text) {
  const cleaned = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);

  return cleaned.length >= MIN_TRANSCRIPT_CHARS && words.length >= 1;
}

async function askUserToRepeat() {
  if (!isSessionActive) return;

  stopListening();

  await sendBackendTextAsSpeech(
    "Please say that again. I couldn’t understand clearly.",
    "repeat"
  );
}

function scheduleListening(delay = 800) {
  clearListenRestartTimer();

  if (!isSessionActive) return;
  if (isProcessingTurn) return;
  if (!isPythonConnected) return;
  if (isAvatarSpeaking) return;

  listenRestartTimer = setTimeout(() => {
    startListening();
  }, delay);
}

function stopListening() {
  clearFinalSpeechTimer();

  if (recognition) {
    try {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      recognition.stop();
    } catch {}

    recognition = null;
  }

  isListening = false;
}

function startListening() {
  if (!isSessionActive) return;
  if (isProcessingTurn) return;
  if (isListening) return;
  if (!isPythonConnected) return;
  if (isAvatarSpeaking) return;
  if (!avatarWs || avatarWs.readyState !== WebSocket.OPEN) return;

  const SpeechRecognition = getSpeechRecognitionClass();

  if (!SpeechRecognition) {
    setStatus("browser speech recognition not supported");
    return;
  }

  pendingTranscript = "";
  gotAnySpeech = false;

  recognition = new SpeechRecognition();

  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    setStatus("listening");
  };

  recognition.onspeechstart = () => {
    gotAnySpeech = true;
    clearFinalSpeechTimer();

    if (!isRecordingTurn) {
      startTurnRecording();
    }

    setStatus("hearing you");
  };

  recognition.onresult = (event) => {
    let finalTranscript = "";
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim() || "";

      if (result.isFinal) {
        finalTranscript += ` ${text}`;
      } else {
        interimTranscript += ` ${text}`;
      }
    }

    const spokenText = `${finalTranscript} ${interimTranscript}`.trim();

    if (spokenText) {
      gotAnySpeech = true;

      if (!isRecordingTurn) {
        startTurnRecording();
      }

      if (finalTranscript.trim()) {
        pendingTranscript = finalTranscript.trim();
      }

      setStatus("hearing you");

      clearFinalSpeechTimer();

      finalSpeechTimer = setTimeout(() => {
        finishUserTurn();
      }, HUMAN_PAUSE_MS);
    }
  };

  recognition.onspeechend = () => {
    clearFinalSpeechTimer();

    finalSpeechTimer = setTimeout(() => {
      finishUserTurn();
    }, HUMAN_PAUSE_MS);
  };

  recognition.onerror = async (err) => {
    console.error("SPEECH RECOGNITION ERROR:", err);

    const errorName = err?.error || "";

    isListening = false;
    recognition = null;

    if (!isSessionActive || isProcessingTurn || isAvatarSpeaking) return;

    if (errorName === "no-speech") {
      if (isRecordingTurn) {
        stopTurnRecording({ discard: true });
      }

      scheduleListening(800);
      return;
    }

    if (errorName === "audio-capture" || errorName === "not-allowed") {
      await sendBackendTextAsSpeech(
        "I cannot hear your microphone properly. Please check your mic permission.",
        "repeat"
      );
      return;
    }

    scheduleListening(1000);
  };

  recognition.onend = () => {
    isListening = false;
    recognition = null;

    if (!isSessionActive || isProcessingTurn || isAvatarSpeaking) return;

    if (!gotAnySpeech && !isRecordingTurn) {
      scheduleListening(500);
    }
  };

  try {
    recognition.start();
  } catch (err) {
    console.error("RECOGNITION START ERROR:", err);
    isListening = false;
    recognition = null;
    scheduleListening(1000);
  }
}

function finishUserTurn() {
  if (!isSessionActive) return;
  if (isProcessingTurn) return;

  clearFinalSpeechTimer();

  const transcriptForControl = pendingTranscript.trim();

  console.log("CONTROL TRANSCRIPT:", transcriptForControl);

  stopListening();

  isProcessingTurn = true;

  if (!isValidControlTranscript(transcriptForControl)) {
    if (isRecordingTurn) {
      stopTurnRecording({ discard: true });
    }

    askUserToRepeat();
    return;
  }

  if (isRecordingTurn) {
    stopTurnRecording();
    return;
  }

  askUserToRepeat();
}

async function waitForPythonWsOpen(timeoutMs = 7000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (avatarWs && avatarWs.readyState === WebSocket.OPEN) {
      return true;
    }

    await sleep(100);
  }

  return false;
}

function startBackendTurnTimeout() {
  clearBackendTurnTimeout();

  backendTurnTimeoutTimer = setTimeout(() => {
    if (!isSessionActive) return;
    if (!isProcessingTurn) return;

    console.warn("Backend turn timeout. Returning to listening.");

    isProcessingTurn = false;
    isGreetingTurn = false;
    isAvatarSpeaking = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;

    setStatus("listening");
    scheduleListening(500);
  }, BACKEND_TURN_TIMEOUT_MS);
}

async function sendBackendTextAsSpeech(text, turn = "system") {
  const isOpen = await waitForPythonWsOpen();

  if (!isOpen) {
    setStatus("backend not connected");
    return false;
  }

  const auth = getAuthData();
  const voiceId = getVoiceId();

  const payload = {
    type: turn,
    greetingMessage: turn === "greeting",
    greetingText: text,
    text,

    session_id: auth.sessionId,
    user_id: auth.userId,
    avatar_id: appConfig?.defaultAvatarId || "ai_engineer",
    voice_id: voiceId,
  };

  currentBackendTurn = turn;
  backendAudioChunksInTurn = 0;
  isProcessingTurn = true;

  if (turn === "greeting") {
    isGreetingTurn = true;
  }

  avatarWs.send(JSON.stringify(payload));

  console.log("TEXT SPEECH SENT TO BACKEND:", {
    type: payload.type,
    greetingMessage: payload.greetingMessage,
    text: payload.text,
    session_id: payload.session_id,
    user_id: payload.user_id,
    avatar_id: payload.avatar_id,
    voice_id: payload.voice_id,
  });

  startBackendTurnTimeout();

  return true;
}

async function sendGreeting() {
  setStatus("greeting user");

  return sendBackendTextAsSpeech(
    "Hey! How can I help you today?",
    "greeting"
  );
}

async function startSession() {
  try {
    if (isSessionActive) return;

    startBtn.disabled = true;
    stopBtn.disabled = false;

    isSessionActive = true;
    isProcessingTurn = false;
    isRecordingTurn = false;
    isListening = false;
    isPythonConnected = false;
    isSimliConnected = false;
    isGreetingTurn = false;
    isAvatarSpeaking = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;

    setStatus("loading config");
    appConfig = await loadConfig();

    setStatus("connecting Simli");
    await connectSimli();

    setStatus("connecting backend");
    await connectPythonAvatarWs();

    if (!avatarWs || avatarWs.readyState !== WebSocket.OPEN) {
      throw new Error("Python backend disconnected before session could start");
    }

    setStatus("getting microphone");
    await setupMic();

    await sleep(500);

    const greetingSent = await sendGreeting();

    if (!greetingSent) {
      isProcessingTurn = false;
      isGreetingTurn = false;
      isAvatarSpeaking = false;
      setStatus("listening");
      scheduleListening(500);
    }
  } catch (err) {
    console.error("START ERROR:", err);

    isSessionActive = false;
    isProcessingTurn = false;
    isRecordingTurn = false;
    isListening = false;
    isPythonConnected = false;
    isSimliConnected = false;
    isAvatarSpeaking = false;

    startBtn.disabled = false;
    stopBtn.disabled = true;

    setStatus("start failed");
  }
}

async function stopSession() {
  try {
    isSessionActive = false;
    isProcessingTurn = false;
    isRecordingTurn = false;
    isListening = false;
    isPythonConnected = false;
    isGreetingTurn = false;
    isAvatarSpeaking = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;

    clearBackendTurnTimeout();
    clearListenRestartTimer();
    clearFinalSpeechTimer();

    stopListening();
    stopSimliKeepAlive();

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    mediaRecorder = null;
    recordedChunks = [];

    if (avatarWs) {
      try {
        if (avatarWs.readyState === WebSocket.OPEN) {
          avatarWs.send(JSON.stringify({ type: "stop" }));
        }
      } catch {}

      try {
        avatarWs.close();
      } catch {}

      avatarWs = null;
    }

    if (simliClient) {
      try {
        await simliClient.stop();
      } catch {}

      simliClient = null;
    }

    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }

    if (videoEl) videoEl.srcObject = null;
    if (audioEl) audioEl.srcObject = null;

    isSimliConnected = false;

    startBtn.disabled = false;
    stopBtn.disabled = true;

    setStatus("session stopped");
  } catch (err) {
    console.error("STOP ERROR:", err);
    setStatus("stop failed");
  }
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);

stopBtn.disabled = true;