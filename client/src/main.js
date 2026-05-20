import { SimliClient, LogLevel } from "simli-client";

console.log("MAIN JS LOADED");

let simliClient = null;
let avatarWs = null;
let mediaRecorder = null;
let micStream = null;
let audioContext = null;
let analyser = null;
let micSource = null;
let vadInterval = null;
let silenceInterval = null;

let appConfig = null;

let isSessionActive = false;
let isSimliConnected = false;
let isUserSpeaking = false;
let isRecordingTurn = false;
let isProcessingTurn = false;

let recordedChunks = [];
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

function setStatus(text) {
  console.log("STATUS:", text);
  statusEl.innerText = `Status: ${text}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Int16Array(bytes.buffer);
}

async function blobToBase64(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
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

    const wsUrl =
      `${appConfig.pythonWsBase}/ws/avatar/voice_stream` +
      `?avatar_id=${encodeURIComponent(avatarId)}`;

    avatarWs = new WebSocket(wsUrl);

    avatarWs.onopen = () => {
      console.log("PYTHON WS CONNECTED");

      avatarWs.send(
        JSON.stringify({
          type: "start",
          avatar_id: avatarId,
          input_format: "webm",
          output_format: "pcm16",
        })
      );

      resolve();
    };

    avatarWs.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        console.log("PYTHON WS EVENT:", msg.type, msg);

        if (msg.type === "transcript") {
          if (!msg.text || msg.text.trim().length < 3) {
            setStatus("not heard properly");
            sendTextToBackend(
              "Briefly say: Sorry, I didn't hear that properly. Please say it again."
            );
            return;
          }

          setStatus(`heard: ${msg.text}`);
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
            msg.audio ||
            msg.audio_base64 ||
            msg.data ||
            msg.chunk;

          if (!base64) return;

          if (!simliClient || !isSimliConnected) {
            console.warn("SIMLI NOT CONNECTED");
            return;
          }

          isProcessingTurn = true;
          setStatus("avatar speaking");

          const pcm = base64ToInt16Array(base64);
          simliClient.sendAudioData(pcm);

          return;
        }

        if (
          msg.type === "audio_end" ||
          msg.type === "turn_complete" ||
          msg.type === "done"
        ) {
          await sleep(1000);
          isProcessingTurn = false;
          setStatus("listening");
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
      reject(err);
    };

    avatarWs.onclose = () => {
      console.log("PYTHON WS CLOSED");

      if (isSessionActive) {
        setStatus("backend disconnected");
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

  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;

    recordedChunks.push(event.data);

    const base64Audio = await blobToBase64(event.data);

    if (avatarWs && avatarWs.readyState === WebSocket.OPEN) {
      avatarWs.send(
        JSON.stringify({
          type: "audio_chunk",
          audio: base64Audio,
          mime_type: mimeType,
        })
      );
    }
  };

  mediaRecorder.onstop = () => {
    if (avatarWs && avatarWs.readyState === WebSocket.OPEN) {
      avatarWs.send(
        JSON.stringify({
          type: "audio_end",
        })
      );
    }

    isRecordingTurn = false;
    isUserSpeaking = false;
    isProcessingTurn = true;

    setStatus("processing your voice");
  };

  mediaRecorder.start(250);

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

function sendTextToBackend(text) {
  if (!avatarWs || avatarWs.readyState !== WebSocket.OPEN) return;

  avatarWs.send(
    JSON.stringify({
      type: "text",
      text,
      avatar_id: appConfig.defaultAvatarId || "ai_engineer",
    })
  );

  isProcessingTurn = true;
}

async function sendGreeting() {
  sendTextToBackend("Only say: Hey! How can I help you today?");
}

async function startSession() {
  try {
    if (isSessionActive) return;

    startBtn.disabled = true;
    stopBtn.disabled = false;

    isSessionActive = true;

    setStatus("loading config");
    appConfig = await loadConfig();

    setStatus("connecting Simli");
    await connectSimli();

    setStatus("connecting backend");
    await connectPythonAvatarWs();

    setStatus("getting microphone");
    await setupMicAndVad();

    await sleep(500);

    setStatus("greeting user");
    await sendGreeting();

    startVadLoop();
  } catch (err) {
    console.error("START ERROR:", err);

    isSessionActive = false;
    isProcessingTurn = false;
    isRecordingTurn = false;

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
        avatarWs.send(JSON.stringify({ type: "stop" }));
      } catch {}

      avatarWs.close();
      avatarWs = null;
    }

    if (simliClient) {
      await simliClient.stop();
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

    videoEl.srcObject = null;
    audioEl.srcObject = null;

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