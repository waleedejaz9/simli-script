import { SimliClient, LogLevel } from "simli-client";

console.log("MAIN JS LOADED");
let isGreetingTurn = false;
let simliClient = null;
let avatarWs = null;
let mediaRecorder = null;
let recordedChunks = [];
let micStream = null;
let audioContext = null;
let analyser = null;
let micSource = null;
let vadInterval = null;
let silenceInterval = null;
let isPythonConnected = false;
let appConfig = null;

let isSessionActive = false;
let isSimliConnected = false;
let isUserSpeaking = false;
let isRecordingTurn = false;
let isProcessingTurn = false;

let speechStartedAt = 0;
let silenceStartedAt = 0;

const VOLUME_THRESHOLD = 0.025;
const MIN_SPEECH_MS = 400;
const SILENCE_END_MS = 1300;
const VAD_CHECK_MS = 100;

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

function seedLocalAuth() {
  localStorage.setItem("authTimestamp", "1779086949149");

  localStorage.setItem(
    "authToken",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwidHlwZSI6ImFjY2VzcyIsImV4cCI6MTc3OTMwMTU4NiwiaWF0IjoxNzc5MzAwOTg2fQ.tjIVSyCr95qb8dWR14Qy_uJLKSGAB9FEyo5BtPqYPcQ"
  );

  localStorage.setItem(
    "authUser",
    JSON.stringify({
      email: "test@localhost.com",
      user_id: "test",
      api_key:
        "5f69d08b59cee2840f29bd6e68de44db13f1ff892589c82eb8fcacbf626f0061",
    })
  );

  localStorage.setItem("isAdmin", "true");
  localStorage.setItem("isAuthenticated", "true");

  localStorage.setItem(
    "refreshToken",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwidHlwZSI6InJlZnJlc2giLCJleHAiOjE3Nzk0NzM3ODYsImlhdCI6MTc3OTMwMDk4Nn0.Ud4MjA9f_NYkjPCWaDEYVp-PsgPzIBjYXioxuoWFIRA"
  );

  localStorage.setItem(
    "tekkdev_session_id",
    "7f164a67-e364-4952-9c63-6b09e017b0ee"
  );

  localStorage.setItem("user_id", "test");

  console.log("AUTH SEEDED");
}

// Uncomment only for local temporary testing.
// seedLocalAuth();

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

  // Important: removes hidden newline that caused %0A in URL
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
  return `${wsBase}/ws/avatar/voice_stream?${params.toString()}`;
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

async function loadConfig() {
  const res = await fetch("http://localhost:3000/api/config");
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to load config");
  }

  return data;
}

async function getSimliToken() {
  const res = await fetch("http://localhost:3000/api/simli-token", {
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
    if (isProcessingTurn) return;

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

async function connectSimli() {
  const sessionToken = await getSimliToken();

  simliClient = new SimliClient(
    sessionToken,
    videoEl,
    audioEl,
    null,
    LogLevel.DEBUG,
    "livekit"
  );

  simliClient.on("start", () => {
    isSimliConnected = true;
    setStatus("Simli connected");
    startSimliKeepAlive();
  });

  simliClient.on("error", (err) => {
    console.error("SIMLI ERROR:", err);
    isSimliConnected = false;
    setStatus("Simli error");
  });

  await simliClient.start();
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

          isProcessingTurn = true;
          setStatus("avatar speaking");

          simliClient.sendAudioData(new Int16Array(event.data));
          return;
        }

        const msg = JSON.parse(event.data);
        console.log("PYTHON WS EVENT:", msg.type, msg);

   if (msg.type === "transcript") {
  const heardText = msg.text || msg.transcript || "";

  console.log("TRANSCRIPT:", heardText);

  // Do not validate greeting as user speech
  if (isGreetingTurn) {
    setStatus("greeting user");
    return;
  }

  if (!heardText || heardText.trim().length < 3) {
    setStatus("not heard properly");
    sendTextToBackend("Sorry, I didn't hear that properly. Please say it again.");
    return;
  }

  setStatus(`heard: ${heardText}`);
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

  if (!simliClient || !isSimliConnected) {
    console.warn("SIMLI NOT READY FOR AUDIO");
    return;
  }

  isProcessingTurn = true;
  setStatus("avatar speaking");

  const pcm = base64ToInt16Array(base64);

  console.log("SENDING PCM TO SIMLI:", pcm.length);

  simliClient.sendAudioData(pcm);

  return;
}

if (
  msg.type === "audio_end" ||
  msg.type === "turn_complete" ||
  msg.type === "done" ||
  msg.type === "tts_audio_end" ||
  msg.type === "avatar_audio_end"
) {

  if (isGreetingTurn) {
    isGreetingTurn = false;
  }

  await sleep(700);

  isProcessingTurn = false;

  if (isSessionActive) {
    setStatus("listening");
  }

  return;
}

        if (msg.type === "error") {
          console.error("PYTHON BACKEND ERROR:", msg);
          isProcessingTurn = false;
          setStatus(msg.message || "backend error");
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

async function setupMicAndVad() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  micSource = audioContext.createMediaStreamSource(micStream);
  micSource.connect(analyser);

  setStatus("mic ready");
}

function getMicVolume() {
  if (!analyser) return 0;

  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);

  let sum = 0;

  for (let i = 0; i < data.length; i++) {
    const value = (data[i] - 128) / 128;
    sum += value * value;
  }

  return Math.sqrt(sum / data.length);
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

mediaRecorder.onstop = async () => {
  try {
    if (!recordedChunks || recordedChunks.length === 0) {
      console.warn("No recorded audio chunks found");
      return;
    }

    const auth = getAuthData();

    const audioBlob = new Blob(recordedChunks, {
      type: mediaRecorder.mimeType || "audio/webm",
    });

    recordedChunks = [];

    if (!audioBlob.size) {
      console.warn("Audio blob is empty");
      return;
    }

    const base64Audio = await blobToBase64(audioBlob);

    if (!base64Audio) {
      console.warn("Base64 audio is empty");
      return;
    }

    avatarWs.send(
      JSON.stringify({
        type: "audio",
        audio_b64: base64Audio,
        audio_base64: base64Audio,
        audio: base64Audio,
        mime_type: mediaRecorder.mimeType || "audio/webm",
        format: "webm",
        session_id: auth.sessionId,
        user_id: auth.userId,
      })
    );

    console.log("FINAL AUDIO SENT:", {
      blobSize: audioBlob.size,
      mimeType: mediaRecorder.mimeType,
      base64Length: base64Audio.length,
    });
  } catch (err) {
    console.error("FINAL AUDIO SEND ERROR:", err);
  }
};

  mediaRecorder.start();

  isRecordingTurn = true;
  isUserSpeaking = true;
  speechStartedAt = Date.now();
  silenceStartedAt = 0;

  setStatus("hearing you");
}

function stopTurnRecording() {
  if (!mediaRecorder || !isRecordingTurn) return;

  try {
    mediaRecorder.stop();
  } catch (err) {
    console.error("MEDIA RECORDER STOP ERROR:", err);
  }
}

function startVadLoop() {
  if (vadInterval) return;

  vadInterval = setInterval(() => {
    if (!isSessionActive) return;
    if (isProcessingTurn) return;
    if (!isPythonConnected) return;
    if (!avatarWs || avatarWs.readyState !== WebSocket.OPEN) return;

    const volume = getMicVolume();
    const now = Date.now();

    if (volume >= VOLUME_THRESHOLD) {
      silenceStartedAt = 0;

      if (!isRecordingTurn) {
        startTurnRecording();
      }

      return;
    }

    if (isRecordingTurn) {
      const speechDuration = now - speechStartedAt;

      if (speechDuration < MIN_SPEECH_MS) return;

      if (!silenceStartedAt) {
        silenceStartedAt = now;
        return;
      }

      const silenceDuration = now - silenceStartedAt;

      if (silenceDuration >= SILENCE_END_MS) {
        stopTurnRecording();
      }
    }
  }, VAD_CHECK_MS);
}

function stopVadLoop() {
  if (vadInterval) {
    clearInterval(vadInterval);
    vadInterval = null;
  }
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

async function sendTextToBackend(text, options = {}) {
  const { processing = true } = options;

  const isOpen = await waitForPythonWsOpen();

  if (!isOpen) {
    console.warn("Cannot send text. Python WS not open.");
    setStatus("backend not connected");
    return false;
  }

  const auth = getAuthData();

avatarWs.send(
  JSON.stringify({
    type: "text",
    text,
    session_id: auth.sessionId,
    user_id: auth.userId,
  })
);

  isProcessingTurn = processing;
  return true;
}

async function sendGreeting() {
  isGreetingTurn = true;

  return sendTextToBackend(
    "Hey! How can I help you today?",
    {
      processing: true,
    }
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
    isUserSpeaking = false;

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
    await setupMicAndVad();

    await sleep(500);

    setStatus("greeting user");

    const greetingSent = await sendGreeting();

    if (!greetingSent) {
      isProcessingTurn = false;
      setStatus("listening");
    }

    startVadLoop();

    setTimeout(() => {
      if (!isSessionActive) return;

      if (isProcessingTurn) {
        console.warn("Greeting timeout. Moving to listening anyway.");
        isProcessingTurn = false;
        setStatus("listening");
      }
    }, 12000);
  } catch (err) {
    console.error("START ERROR:", err);

    isSessionActive = false;
    isProcessingTurn = false;
    isRecordingTurn = false;
    isUserSpeaking = false;
    isPythonConnected = false;

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
    isUserSpeaking = false;
    isPythonConnected = false;

    stopVadLoop();
    stopSimliKeepAlive();

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    mediaRecorder = null;

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

    if (micSource) {
      try {
        micSource.disconnect();
      } catch {}

      micSource = null;
    }

    if (audioContext) {
      try {
        await audioContext.close();
      } catch {}

      audioContext = null;
    }

    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }

    analyser = null;

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