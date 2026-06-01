const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { AccessToken } = require("livekit-server-sdk");

require("dotenv").config();

const app = express();
app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });
let notesText = "";

app.get("/", (req, res) => res.send("Backend is running"));

// =====================
// PDF EXTRACTOR
// =====================

async function extractTextFromPDF(pdfPath) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const fontsPath = path.join(
    path.dirname(require.resolve("pdfjs-dist/package.json")),
    "standard_fonts/"
  );
  const standardFontDataUrl = "file:///" + fontsPath.replace(/\\/g, "/");
  const loadingTask = pdfjsLib.getDocument({ data, standardFontDataUrl, verbosity: 0 });
  const pdfDoc = await loadingTask.promise;
  let fullText = "";
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(" ") + "\n";
  }
  return fullText;
}

// =====================
// AI HELPER
// =====================

const MODELS = [
  "meta-llama/llama-3.1-8b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "openrouter/free",
];

async function getAIResponse(prompt, attempt = 0) {
  const model = MODELS[attempt] || "openrouter/free";
  console.log(`Using model: ${model}`);
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      },
      {
        timeout: 90000,
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "AI Study Assistant",
          "Content-Type": "application/json",
        },
      }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    const reason = err.response?.data?.error?.message || err.message;
    console.log(`Model ${model} failed: ${reason}`);
    if (attempt < MODELS.length - 1) {
      console.log("Retrying with next model...");
      return getAIResponse(prompt, attempt + 1);
    }
    throw new Error(`All models failed. Last error: ${reason}`);
  }
}

function trimText(text, maxChars = 4000) {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + "\n...[content trimmed]...\n" + text.slice(-half);
}

// =====================
// UPLOAD NOTES
// =====================

app.post("/upload-notes", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
    notesText = await extractTextFromPDF(req.file.path);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, message: "Notes uploaded successfully" });
  } catch (error) {
    console.error("UPLOAD ERROR:", error.message);
    res.status(500).json({ error: "Failed to upload notes" });
  }
});

// =====================
// SUMMARY
// =====================

app.post("/generate-summary", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
    console.log("Extracting PDF text...");
    const extracted = await extractTextFromPDF(req.file.path);
    notesText = extracted;
    fs.unlinkSync(req.file.path);
    const trimmed = trimText(extracted, 4000);
    console.log(`Sending ${trimmed.length} chars to AI...`);
    const summary = await getAIResponse(
      `Summarize these study notes in clear bullet points. Be concise:\n\n${trimmed}`
    );
    res.json({ summary });
  } catch (error) {
    console.error("SUMMARY ERROR:", error.message);
    res.status(500).json({ error: error.message || "Failed to generate summary" });
  }
});

// =====================
// QUIZ
// =====================

app.post("/generate-quiz", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file && !notesText) {
      return res.status(400).json({ error: "No PDF uploaded and no notes in memory" });
    }
    if (req.file) {
      notesText = await extractTextFromPDF(req.file.path);
      fs.unlinkSync(req.file.path);
    }
    const trimmed = trimText(notesText, 4000);
    console.log(`Generating quiz from ${trimmed.length} chars...`);
    const rawQuiz = await getAIResponse(`
You are a quiz generator. Create exactly 10 multiple choice questions based on the notes below.
Return ONLY a valid JSON array. No explanation, no markdown, no code blocks. Just raw JSON.

Format:
[
  {
    "question": "What is ...?",
    "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
    "answer": "A"
  }
]

Notes:
${trimmed}
`);
    const cleaned = rawQuiz.replace(/```json/gi, "").replace(/```/g, "").trim();
    let questions;
    try {
      questions = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed:", rawQuiz.slice(0, 300));
      return res.status(500).json({ error: "AI returned invalid format. Please try again." });
    }
    res.json({ questions });
  } catch (error) {
    console.error("QUIZ ERROR:", error.message);
    res.status(500).json({ error: error.message || "Failed to generate quiz" });
  }
});

// =====================
// CHAT WITH NOTES
// =====================

app.post("/chat-with-notes", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "No question provided" });

    let prompt = "";

    if (notesText) {
      const trimmed = trimText(notesText, 3000);
      prompt = `You are an AI study assistant. A student is asking you a question.
First check the notes below. If the answer is there, answer from the notes.
If the answer is NOT in the notes, answer from your own general knowledge and mention: "This wasn't in your notes, but here is what I know:".
Never say you cannot answer — always help the student.

NOTES:
${trimmed}

QUESTION: ${question}`;
    } else {
      prompt = `You are a helpful AI study assistant. Answer this student question clearly and concisely using your general knowledge:

QUESTION: ${question}`;
    }

    const answer = await getAIResponse(prompt);
    res.json({ answer });
  } catch (error) {
    console.error("CHAT ERROR:", error.message);
    res.status(500).json({ error: error.message || "Failed to answer question" });
  }
});

// =====================
// NOTES PREVIEW
// =====================

app.get("/notes", (req, res) => {
  res.json({ length: notesText.length, preview: notesText.slice(0, 500) });
});

// =====================
// LIVEKIT — Generate Token
// =====================

app.post("/livekit-token", async (req, res) => {
  try {
    const { username } = req.body;
    const roomName = "study-assistant-room";

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: username || "student" }
    );

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    res.json({ token, roomName, url: process.env.LIVEKIT_URL });
  } catch (error) {
    console.error("TOKEN ERROR:", error.message);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// =====================
// VOICE CHAT — Speech to AI to Speech
// (Browser sends transcript, server responds, browser speaks it)
// =====================

app.post("/voice-ask", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: "No transcript provided" });
    if (!notesText) return res.status(400).json({ error: "Upload a PDF first" });

    console.log("Voice question:", transcript);

    const trimmed = trimText(notesText, 3000);
    const answer = await getAIResponse(`
You are an AI study assistant speaking out loud. Keep your answer SHORT (2-3 sentences max) and clear.
First check the notes. If found, answer from notes.
If NOT in the notes, answer from your general knowledge and start with "This wasn't in your notes, but:".
Always give an answer — never refuse.

NOTES:
${trimmed}

QUESTION: ${transcript}
`);

    console.log("Voice answer:", answer);
    res.json({ answer });
  } catch (error) {
    console.error("VOICE ERROR:", error.message);
    res.status(500).json({ error: error.message || "Failed to process voice" });
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));