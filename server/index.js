import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import { generateSimliSessionToken } from "simli-client";
import { spawn } from "child_process";
import WebSocket from "ws";

dotenv.config();

const app = express();

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "50mb" }));

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.post("/api/simli-token", async (req, res) => {
  try {
    const token = await generateSimliSessionToken({
      apiKey: process.env.SIMLI_API_KEY,
      config: {
        faceId: process.env.SIMLI_FACE_ID,
        handleSilence: false,
        maxSessionLength: 600,
        maxIdleTime: 180,
      },
    });

    res.json(token);
  } catch (err) {
    console.error("SIMLI TOKEN ERROR:", err);
    res.status(500).json({ error: "Failed to create Simli token" });
  }
});

async function getElevenLabsSignedUrl() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
    {
      method: "GET",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Failed to get ElevenLabs signed URL");
  }

  return data.signed_url;
}

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    console.log("Received message:", message);

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const signedUrl = await getElevenLabsSignedUrl();
    console.log("Got signed URL:", signedUrl);

    const audioData = await new Promise((resolve, reject) => {
      const ws = new WebSocket(signedUrl);

      let resolved = false;
      let userMessageSent = false;
      let audioChunks = [];
      let audioFinishTimer = null;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;

          try {
            ws.close();
          } catch {}

          reject(new Error("ElevenLabs timeout: no audio received"));
        }
      }, 30000);

      function finish() {
        if (resolved) return;

        resolved = true;
        clearTimeout(timeout);

        if (audioFinishTimer) {
          clearTimeout(audioFinishTimer);
          audioFinishTimer = null;
        }

        try {
          ws.close();
        } catch {}

        resolve({
          chunks: audioChunks,
          chunkMs: 10,
          sampleRate: 16000,
          channels: 1,
          format: "pcm16",
        });
      }

      ws.on("open", () => {
        console.log("WebSocket opened, sending initiation");

        ws.send(
          JSON.stringify({
            type: "conversation_initiation_client_data",
          }),
        );
      });

      ws.on("message", (raw) => {
        let event;

        try {
          event = JSON.parse(raw.toString());
        } catch {
          console.log("RAW EVENT:", raw.toString());
          return;
        }

        console.log("ELEVENLABS EVENT TYPE:", event.type);

        if (event.type === "conversation_initiation_metadata") {
          if (!userMessageSent) {
            userMessageSent = true;

            console.log("Sending user_message after metadata:", message);

            ws.send(
              JSON.stringify({
                type: "user_message",
                text: message,
              }),
            );
          }

          return;
        }

        if (event.type === "ping") {
          ws.send(
            JSON.stringify({
              type: "pong",
              event_id: event.ping_event?.event_id,
            }),
          );

          return;
        }

        if (event.audio_event?.audio_base_64) {
          console.log("Received ElevenLabs audio chunk");

          audioChunks.push(event.audio_event.audio_base_64);

          if (audioFinishTimer) {
            clearTimeout(audioFinishTimer);
          }

          audioFinishTimer = setTimeout(() => {
            if (audioChunks.length > 0 && !resolved) {
              console.log("No more audio chunks, finishing response");
              finish();
            }
          }, 1200);

          return;
        }

        if (event.type === "agent_response_complete") {
          console.log("Agent response complete");

          if (audioChunks.length > 0) {
            finish();
          }

          return;
        }
      });

      ws.on("close", (code, reason) => {
        console.log("ElevenLabs WebSocket closed");
        console.log("Close code:", code);
        console.log("Close reason:", reason.toString());

        if (!resolved && audioChunks.length > 0) {
          finish();
          return;
        }

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);

          reject(
            new Error(`ElevenLabs socket closed before audio. Code: ${code}`),
          );
        }
      });

      ws.on("error", (err) => {
        console.error("ELEVENLABS WS ERROR:", err);

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    res.json(audioData);
  } catch (err) {
    console.error("ELEVENLABS AGENT ERROR:", err);

    res.status(500).json({
      error: err.message || "ElevenLabs agent failed",
    });
  }
});
function convertMp3ToPCM16(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "48000",
      "pipe:1",
    ]);

    const chunks = [];
    const errors = [];

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (err) => {
      errors.push(err);
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(Buffer.concat(errors).toString()));
      }

      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.write(mp3Buffer);
    ffmpeg.stdin.end();
  });
}

function splitPCMIntoChunks(pcmBuffer, chunkMs = 10, sampleRate = 48000) {
  const bytesPerSample = 2;
  const samplesPerChunk = Math.floor((sampleRate * chunkMs) / 1000);
  const bytesPerChunk = samplesPerChunk * bytesPerSample;

  const chunks = [];

  for (let i = 0; i < pcmBuffer.length; i += bytesPerChunk) {
    chunks.push(pcmBuffer.slice(i, i + bytesPerChunk).toString("base64"));
  }

  return chunks;
}

app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const audioStream = await elevenlabs.textToSpeech.convert(
      process.env.ELEVENLABS_VOICE_ID,
      {
        text,
        model_id: "eleven_turbo_v2",
        output_format: "mp3_44100_128",
      },
    );

    const mp3Chunks = [];

    for await (const chunk of audioStream) {
      mp3Chunks.push(chunk);
    }

    const mp3Buffer = Buffer.concat(mp3Chunks);

    const pcmBuffer = await convertMp3ToPCM16(mp3Buffer);

    const pcmChunks = splitPCMIntoChunks(pcmBuffer, 10, 48000);

    res.json({
      format: "pcm16",
      sampleRate: 48000,
      channels: 1,
      chunkMs: 10,
      chunks: pcmChunks,
    });
  } catch (err) {
    console.error("ELEVENLABS TTS ERROR:", err);
    res.status(500).json({ error: "ElevenLabs TTS failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
