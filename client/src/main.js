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

let simliAudioQueue = [];
let isPlayingSimliQueue = false;
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
      const silence = new Int16Array(160);
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

function queueSimliAudio(pcm, durationMs = 60) {
  simliAudioQueue.push({ pcm, durationMs });

  if (!isPlayingSimliQueue) {
    playSimliQueue();
  }
}

async function playSimliQueue() {
  isPlayingSimliQueue = true;
  isAvatarSpeaking = true;

  stopListening();

  while (simliAudioQueue.length > 0 && isSessionActive) {
    const item = simliAudioQueue.shift();

    if (simliClient && isSimliConnected) {
      simliClient.sendAudioData(item.pcm);
    }

    await sleep(item.durationMs || 60);
  }

  isPlayingSimliQueue = false;
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
          isProcessingTurn = true;
          setStatus("avatar speaking");

          queueSimliAudio(new Int16Array(event.data), 60);
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
          const base64 =
            msg.pcm_b64 ||
            msg.audio ||
            msg.audio_base64 ||
            msg.data ||
            msg.chunk;

          if (!base64) {
            console.warn("NO AUDIO BASE64 FOUND:", msg);
            return;
          }

          const pcm = base64ToInt16Array(base64);

          backendAudioChunksInTurn += 1;
          isProcessingTurn = true;
          setStatus("avatar speaking");

          queueSimliAudio(pcm, msg.duration_ms || 60);
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

      if (isSessionActive) {
        setStatus(`backend disconnected: ${event.code}`);
      }
    };
  });
}

async function handleBackendAudioEnd(msg = {}) {
  clearBackendTurnTimeout();

  const chunksFromBackend =
    Number(msg.chunks_sent || msg.chunks || msg.audio_chunks || 0) ||
    backendAudioChunksInTurn;

  console.log("BACKEND AUDIO END:", {
    currentBackendTurn,
    chunksFromBackend,
    msg,
  });

  if (chunksFromBackend <= 0) {
    isProcessingTurn = false;
    isGreetingTurn = false;
    isAvatarSpeaking = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;

    setStatus("backend returned no audio");
    scheduleListening(800);
    return;
  }

  while (isPlayingSimliQueue || simliAudioQueue.length > 0) {
    await sleep(100);
  }

  await sleep(300);

  isAvatarSpeaking = false;
  isProcessingTurn = false;
  isGreetingTurn = false;
  currentBackendTurn = null;
  backendAudioChunksInTurn = 0;

  if (isSessionActive) {
    setStatus("listening");
    scheduleListening(300);
  }
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
        voiceId: voiceId,
        avatar_voice_id: voiceId,
        tts_voice_id: voiceId,
        elevenlabs_voice_id: voiceId,

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
    simliAudioQueue = [];
    isPlayingSimliQueue = false;

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
    isPlayingSimliQueue = false;
    simliAudioQueue = [];
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
    isPlayingSimliQueue = false;
    currentBackendTurn = null;
    backendAudioChunksInTurn = 0;
    simliAudioQueue = [];

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