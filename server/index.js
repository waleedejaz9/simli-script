import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { generateSimliSessionToken } from "simli-client";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.send("Express bridge running");
});

app.get("/api/config", (req, res) => {
  res.json({
    pythonHttpBase: process.env.PYTHON_HTTP_BASE,
    pythonWsBase: process.env.PYTHON_WS_BASE,
    defaultAvatarId: process.env.DEFAULT_AVATAR_ID || "ai_engineer",
  });
});

app.post("/api/simli-token", async (req, res) => {
  try {
    if (!process.env.SIMLI_API_KEY) {
      return res.status(500).json({ error: "Missing SIMLI_API_KEY" });
    }

    if (!process.env.SIMLI_FACE_ID) {
      return res.status(500).json({ error: "Missing SIMLI_FACE_ID" });
    }

    const token = await generateSimliSessionToken({
      apiKey: process.env.SIMLI_API_KEY,
      config: {
        faceId: process.env.SIMLI_FACE_ID,
        handleSilence: true,
        maxSessionLength: 1800,
        maxIdleTime: 600,
      },
    });

    res.json(token);
  } catch (err) {
    console.error("SIMLI TOKEN ERROR:", err);
    res.status(500).json({ error: "Failed to create Simli token" });
  }
});

app.listen(PORT, () => {
  console.log(`Express bridge running on http://localhost:${PORT}`);
});