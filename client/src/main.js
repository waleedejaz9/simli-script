import { SimliClient, LogLevel } from "simli-client";

console.log("MAIN JS LOADED");

let simliClient = null;
let recognition = null;

let isProcessing = false;
let isListening = false;
let isSessionActive = false;
let isSimliConnected = false;

let silenceInterval = null;
let restartListenTimer = null;
let isAvatarSpeaking = false;
let isInterrupted = false;
let micStream = null;

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const interruptBtn = document.getElementById("interruptBtn");

const statusEl = document.getElementById("status");

async function enableNoiseCancellation() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    console.log("Noise cancellation enabled");
  } catch (err) {
    console.error("Noise cancellation failed:", err);
  }
}

function setStatus(text) {
  console.log(text);
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

function startSimliKeepAlive() {
  if (silenceInterval) return;

  silenceInterval = setInterval(() => {
    if (!simliClient || !isSimliConnected || !isSessionActive) return;
    if (isProcessing) return;

    try {
      const silence = new Int16Array(160);
      simliClient.sendAudioData(silence);
    } catch (err) {
      console.error("SIMLI KEEP ALIVE ERROR:", err);
      isSimliConnected = false;
      setStatus("Simli disconnected");
    }
  }, 100);
}

function stopSimliKeepAlive() {
  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }
}

async function getSessionToken() {
  const res = await fetch("http://localhost:3000/api/simli-token", {
    method: "POST",
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to get Simli token");
  }

  return data.session_token;
}

async function askElevenLabsAgent(message) {
  const agentRes = await fetch("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  const agentData = await agentRes.json();

  if (!agentRes.ok) {
    throw new Error(agentData.error || "ElevenLabs agent failed");
  }

  if (
    !agentData ||
    !agentData.chunks ||
    !Array.isArray(agentData.chunks) ||
    agentData.chunks.length === 0
  ) {
    throw new Error("No audio returned from ElevenLabs");
  }

  return agentData;
}

async function sendAudioToSimli(audioData) {
  if (!simliClient || !isSimliConnected) {
    throw new Error("Simli is not connected");
  }

  isProcessing = true;
  setStatus("avatar speaking");

  for (const base64Chunk of audioData.chunks) {
    if (!isSessionActive) break;

    const pcmChunk = base64ToInt16Array(base64Chunk);
    simliClient.sendAudioData(pcmChunk);

    await sleep(audioData.chunkMs || 10);
  }

  await sleep(1500);

  isProcessing = false;
  setStatus("ready");
}

async function avatarSay(text) {
  try {
    const audioData = await askElevenLabsAgent(text);
    await sendAudioToSimli(audioData);
  } catch (err) {
    console.error("AVATAR SAY ERROR:", err);
    isProcessing = false;
    setStatus("avatar response failed");
  }
}

function clearRestartTimer() {
  if (restartListenTimer) {
    clearTimeout(restartListenTimer);
    restartListenTimer = null;
  }
}

function scheduleListening(delay = 3000) {
  clearRestartTimer();

  if (!isSessionActive || isProcessing) return;

  restartListenTimer = setTimeout(() => {
    startListening();
  }, delay);
}

function stopRecognition() {
  if (recognition) {
    try {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onspeechend = null;
      recognition.stop();
    } catch {}

    recognition = null;
  }

  isListening = false;
}

function startListening() {
  if (!isSessionActive) return;
  if (isProcessing) return;
  if (isListening) return;

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert("Speech recognition is not supported in this browser");
    return;
  }

  recognition = new SpeechRecognition();

  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let gotResult = false;
  let gotInterimSpeech = false;
  let noSpeechTimer = null;
  let finalAnswerTimer = null;
  let pendingFinalTranscript = "";
recognition.onresult = async (event) => {
  try {
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

    if (interimTranscript.trim()) {
      gotInterimSpeech = true;
      setStatus("hearing you");

      if (finalAnswerTimer) {
        clearTimeout(finalAnswerTimer);
        finalAnswerTimer = null;
      }
    }

    if (!finalTranscript.trim()) return;

    pendingFinalTranscript += ` ${finalTranscript.trim()}`;
    gotResult = true;

    if (noSpeechTimer) {
      clearTimeout(noSpeechTimer);
      noSpeechTimer = null;
    }

    setStatus("heard you, waiting");

    if (finalAnswerTimer) {
      clearTimeout(finalAnswerTimer);
    }

    finalAnswerTimer = setTimeout(async () => {
      const transcript = pendingFinalTranscript.trim();

      console.log("USER SAID:", transcript);

      stopRecognition();

      const cleanedTranscript = transcript
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .trim();

      const words = cleanedTranscript.split(/\s+/).filter(Boolean);

      if (!cleanedTranscript || cleanedTranscript.length < 4 || words.length < 1) {
        await avatarSay(
          "Briefly say: Sorry, I didn't understand that. Please say it again."
        );

        scheduleListening(1000);
        return;
      }

      setStatus("thinking");

      await avatarSay(
        `Do not greet again. Answer only this user message naturally: ${transcript}`
      );

      scheduleListening(1000);
    }, 1800);
  } catch (err) {
    console.error("CONVERSATION ERROR:", err);

    await avatarSay(
      "Briefly say: Sorry, I had trouble answering that. Please try again."
    );

    scheduleListening(1000);
  }
};

  recognition.onspeechstart = () => {
    gotInterimSpeech = true;

    if (noSpeechTimer) {
      clearTimeout(noSpeechTimer);
      noSpeechTimer = null;
    }

    setStatus("hearing you");
  };

  recognition.onspeechend = () => {
    try {
      recognition.stop();
    } catch {}
  };

  recognition.onerror = async (err) => {
    console.error("SPEECH ERROR:", err);

    if (noSpeechTimer) clearTimeout(noSpeechTimer);

    isListening = false;
    recognition = null;

    if (!isSessionActive) return;

    if (err.error === "no-speech") {
      setStatus("no speech, listening again");
      scheduleListening(1000);
      return;
    }

    if (err.error === "audio-capture" || err.error === "not-allowed") {
      await avatarSay(
        "Briefly say: I cannot hear your microphone properly. Please check your mic permission."
      );
      scheduleListening(1000);
      return;
    }

    scheduleListening(1000);
  };

  recognition.onend = async () => {
    if (noSpeechTimer) clearTimeout(noSpeechTimer);

    isListening = false;
    recognition = null;

    if (!isSessionActive || isProcessing) return;

    if (gotInterimSpeech && !gotResult) {
      await avatarSay(
        "Briefly say: Sorry, I didn't understand that. Please say it again."
      );
      scheduleListening(1000);
      return;
    }

    if (!gotResult) {
      scheduleListening(800);
    }
  };

 recognition.onresult = async (event) => {
  try {
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

    if (interimTranscript.trim()) {
      gotInterimSpeech = true;
      setStatus("hearing you");
    }

    if (!finalTranscript.trim()) return;

    gotResult = true;

    if (noSpeechTimer) {
      clearTimeout(noSpeechTimer);
      noSpeechTimer = null;
    }

    const transcript = finalTranscript.trim();

    console.log("USER SAID:", transcript);

    stopRecognition();

    const cleanedTranscript = transcript
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .trim();

    const words = cleanedTranscript.split(/\s+/).filter(Boolean);

    if (!cleanedTranscript || cleanedTranscript.length < 4 || words.length < 1) {
      await avatarSay(
        "Briefly say: Sorry, I didn't understand that. Please say it again."
      );

      scheduleListening(1000);
      return;
    }

    setStatus("thinking");

    await avatarSay(
      `Do not greet again. Answer only this user message naturally: ${transcript}`
    );

    scheduleListening(1000);
  } catch (err) {
    console.error("CONVERSATION ERROR:", err);

    await avatarSay(
      "Briefly say: Sorry, I had trouble answering that. Please try again."
    );

    scheduleListening(1000);
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

async function startSession() {
  try {
    if (isSessionActive) return;

    startBtn.disabled = true;
    stopBtn.disabled = false;

    isSessionActive = true;
setStatus("getting microphone");

await enableNoiseCancellation();

setStatus("getting Simli token");

const sessionToken = await getSessionToken();

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

    setStatus("greeting user");

    await avatarSay("Only say: Hey! How can I help you today?");

    scheduleListening();
  } catch (err) {
    console.error("START ERROR:", err);

    isSessionActive = false;
    isSimliConnected = false;
    isProcessing = false;

    startBtn.disabled = false;
    stopBtn.disabled = true;

    setStatus("start failed");
  }
}

async function stopSession() {
  try {
    isSessionActive = false;
    isProcessing = false;
    isListening = false;

    clearRestartTimer();
    stopRecognition();
    stopSimliKeepAlive();

    if (simliClient) {
      await simliClient.stop();
      simliClient = null;
    }

    videoEl.srcObject = null;
    audioEl.srcObject = null;

    isSimliConnected = false;

    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
    setStatus("session stopped");
  } catch (err) {
    console.error("STOP ERROR:", err);
    setStatus("stop failed");
  }
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);

stopBtn.disabled = true;