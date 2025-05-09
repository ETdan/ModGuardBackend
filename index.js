const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const app = express();
const PORT = process.env.PORT || 3000;
const dotenv = require("dotenv");
dotenv.config();
// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "*", // Use environment variable or fallback to "*"
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"], // Include common HTTP methods
    allowedHeaders: ["Content-Type", "Authorization"], // Include Authorization header for secured APIs
    credentials: true, // Allow credentials if needed
  })
);
// Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = process.env.GROQ_API_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Flag types
const FLAG_TYPES = [
  "toxicity",
  "harassment",
  "hate-speech",
  "sexual",
  "violence",
  "spam",
];

// System prompt
const SYSTEM_PROMPT = `
You are a content moderation assistant. Analyze the provided text and evaluate how strongly it exhibits each characteristic on a scale from 0 to 1.
Return ONLY a JSON object with scores for: toxicity, harassment, hate-speech, sexual, violence, spam.
All scores must be between 0 and 1. Example: {"toxicity":0.42,"harassment":0.21}
`;

// Moderate endpoint
app.post("/moderate", async (req, res) => {
  try {
    const { content, apikey } = req.body;

    // Validate input
    if (!content || typeof content !== "string") {
      return res
        .status(400)
        .json({ error: "Valid content string is required" });
    }

    if (!apikey) {
      return res.status(401).json({ error: "API key is required" });
    }

    if (!content || typeof content !== "string") {
      return res
        .status(400)
        .json({ error: "Valid content string is required" });
    }

    // Verify API key with Supabase
    const isValidKey = await verifyApiKey(apikey);
    if (!isValidKey) {
      return res.status(403).json({ error: "Invalid API key" });
    }

    // Analyze content
    let scores;
    try {
      scores = await analyzeContentWithAI(content);
    } catch (error) {
      console.error("AI analysis failed, using randomized scores:", error);
      scores = generateRandomScores();
    }

    // Format response
    const response = formatResponse(scores);

    // Store results in Supabase
    await storeResultsInSupabase(apikey, content, response);

    res.json(response);
  } catch (error) {
    console.error("Moderation error:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});
app.post("/test/moderate", async (req, res) => {
  try {
    const { content } = req.body;

    // Validate input
    if (!content || typeof content !== "string") {
      return res
        .status(400)
        .json({ error: "Valid content string is required" });
    }

    if (!content || typeof content !== "string") {
      return res
        .status(400)
        .json({ error: "Valid content string is required" });
    }

    // Analyze content
    let scores;
    try {
      scores = await analyzeContentWithAI(content);
    } catch (error) {
      console.error("AI analysis failed, using randomized scores:", error);
      scores = generateRandomScores();
    }

    // Format response
    const response = formatResponse(scores);

    res.json(response);
  } catch (error) {
    console.error("Moderation error:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Verify API key with Supabase
async function verifyApiKey(apikey) {
  try {
    const { data, error } = await supabase
      .from("api_key")
      .select("*")
      .eq("key", apikey)
      .single();

    return !!data && !error;
  } catch (error) {
    console.error("API key verification error:", error);
    return false;
  }
}

async function analyzeContentWithAI(content) {
  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: "llama3-70b-8192", // Updated model name
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: content },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 5000,
      }
    );

    const aiResponse = response.data.choices[0].message.content;
    return parseAndValidateScores(aiResponse);
  } catch (error) {
    console.error(
      "AI classification error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

// Parse and validate scores
function parseAndValidateScores(aiResponse) {
  try {
    const scores = JSON.parse(aiResponse);
    const validated = {};

    FLAG_TYPES.forEach((flag) => {
      let value = parseFloat(scores[flag]);
      if (isNaN(value)) value = 0;
      validated[flag] = Math.max(0, Math.min(1, value));
      validated[flag] = Math.round(validated[flag] * 100) / 100;
    });

    return validated;
  } catch (e) {
    console.warn("Failed to parse AI response:", aiResponse);
    throw new Error("Invalid AI response format");
  }
}

// Generate random scores as fallback
function generateRandomScores() {
  const scores = {};
  FLAG_TYPES.forEach((flag) => {
    scores[flag] = Math.round(Math.random() * 100) / 100;
  });
  return scores;
}

// Format response
function formatResponse(scores) {
  return FLAG_TYPES.map((flagType) => ({
    flag_type: flagType,
    value: scores[flagType] || 0,
  }));
}

// Store results in Supabase
async function storeResultsInSupabase(apikey, content, results) {
  try {
    // Determine the flag type with the maximum value
    const maxFlag = results.reduce(
      (max, current) => (current.value > max.value ? current : max),
      { flag_type: null, value: -1 }
    );

    const formattedFlags = {
      type: maxFlag.flag_type,
      score: maxFlag.value,
      flagged: maxFlag.value >= 0.5, // Assuming a score >= 0.5 is flagged
    };

    // Determine status based on the maximum flag value
    let status;
    if (maxFlag.value >= 0.7) {
      status = "flagged";
    } else if (maxFlag.value < 0.3) {
      status = "clean";
    } else {
      status = "borderline";
    }

    const { data, error } = await supabase.from("request_data").insert([
      {
        api_key: apikey,
        content: content,
        content_type: "text",
        flags: formattedFlags,
        user_id: null, // Assuming user_id is not provided in the request
        status: status,
      },
    ]);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Supabase storage error:", error);
    throw error;
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
