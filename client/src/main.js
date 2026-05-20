import { SimliClient, LogLevel } from "simli-client";

console.log("MAIN JS LOADED");

let simliClient = null;
let recognition = null;
let isProcessing = false;

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");

const startBtn = document.getElementById("startBtn");
const talkBtn = document.getElementById("talkBtn");
const stopBtn = document.getElementById("stopBtn");

const statusEl = document.getElementById("status");

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

async function startSession() {
  try {
    setStatus("getting Simli token");

    const sessionToken = await getSessionToken();

    simliClient = new SimliClient(
      sessionToken,
      videoEl,
      audioEl,
      null,
      LogLevel.DEBUG,
      "livekit",
    );

    simliClient.on("start", () => {
      setStatus("Simli connected");
    });

    simliClient.on("error", (err) => {
      console.error("SIMLI ERROR:", err);
      setStatus("Simli error");
    });

    await simliClient.start();

    setStatus("session started");
    setStatus("greeting user");

    const greetingAudio = await askElevenLabsAgent(
      "Greet the user briefly. Only say: Hey! How can i help you?",
    );

    await sendAudioToSimli(greetingAudio);

    setStatus("ready to talk");
  } catch (err) {
    console.error("START ERROR:", err);
    setStatus("start failed");
  }
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

  return agentData;
}

async function sendAudioToSimli(audioData) {
  setStatus("avatar speaking");

  if (!audioData.chunks || !Array.isArray(audioData.chunks)) {
    throw new Error("No audio chunks received from ElevenLabs agent");
  }

  for (const base64Chunk of audioData.chunks) {
    const pcmChunk = base64ToInt16Array(base64Chunk);

    simliClient.sendAudioData(pcmChunk);

    await sleep(audioData.chunkMs || 10);
  }

  setStatus("response completed");
}

async function startTalking() {
  try {
    if (!simliClient) {
      alert("Start Simli session first");
      return;
    }

    if (isProcessing) {
      console.log("Already processing");
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech recognition not supported in this browser");
      return;
    }

    recognition = new SpeechRecognition();

    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    let speechTimeout = null;
    let gotResult = false;

    recognition.onstart = () => {
      setStatus("listening...");

      speechTimeout = setTimeout(() => {
        if (!gotResult && !isProcessing) {
          console.log("No speech detected, stopping recognition");

          try {
            recognition.stop();
          } catch {}

          setStatus("no speech detected");
        }
      }, 7000);
    };

    recognition.onspeechend = () => {
      console.log("User stopped speaking");

      try {
        recognition.stop();
      } catch {}
    };

    recognition.onaudioend = () => {
      console.log("Audio ended");
    };

    recognition.onerror = (err) => {
      console.error("SPEECH ERROR:", err);

      if (speechTimeout) {
        clearTimeout(speechTimeout);
        speechTimeout = null;
      }

      setStatus("speech failed");
      isProcessing = false;
    };

    recognition.onend = () => {
      console.log("Recognition ended");

      if (speechTimeout) {
        clearTimeout(speechTimeout);
        speechTimeout = null;
      }

      if (!isProcessing && !gotResult) {
        setStatus("click talk to speak");
      }
    };

    recognition.onresult = async (event) => {
      try {
        gotResult = true;
        isProcessing = true;

        if (speechTimeout) {
          clearTimeout(speechTimeout);
          speechTimeout = null;
        }

        try {
          recognition.stop();
        } catch {}

        const transcript = event.results[0][0].transcript;

        console.log("USER SAID:", transcript);

        setStatus("asking ElevenLabs agent");

        // const audioData = await askElevenLabsAgent(transcript);
        const audioData = await askElevenLabsAgent(
          `Do not greet again. Answer only this user message naturally: ${transcript}`,
        );

        console.log("ELEVENLABS AGENT AUDIO:", audioData);

        setStatus("sending ElevenLabs audio to avatar");

        await sendAudioToSimli(audioData);

        isProcessing = false;
      } catch (err) {
        console.error("CONVERSATION ERROR:", err);
        setStatus("conversation failed");
        isProcessing = false;
      }
    };

    recognition.start();
  } catch (err) {
    console.error("TALK ERROR:", err);
    setStatus("talk failed");
    isProcessing = false;
  }
}

async function stopSession() {
  try {
    if (recognition) {
      recognition.stop();
      recognition = null;
    }

    if (simliClient) {
      await simliClient.stop();
      simliClient = null;
    }

    videoEl.srcObject = null;
    audioEl.srcObject = null;

    isProcessing = false;

    setStatus("session stopped");
  } catch (err) {
    console.error("STOP ERROR:", err);
    setStatus("stop failed");
  }
}

startBtn.addEventListener("click", startSession);
talkBtn.addEventListener("click", startTalking);
stopBtn.addEventListener("click", stopSession);
