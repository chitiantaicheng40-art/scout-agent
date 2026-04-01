require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ルート確認
app.get("/", (req, res) => {
  res.status(200).send("scout-agent is running");
});

// ヘルスチェック
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "scout-agent",
    timestamp: new Date().toISOString(),
  });
});

// AI評価
async function evaluateScoutCandidate(candidate, job) {
  const prompt = `
あなたは一流の採用エージェントです。
目的は、候補者にスカウトを送るべきかを実務目線で厳しく判断することです。

【ルール】
- 推測で断定しない
- Must条件を重視
- 結果は必ずJSONで返す
- scout_message は候補者に合わせて自然で具体的に書く
- テンプレ感の強い文章は禁止
- 日本語で返す

【求人情報】
${JSON.stringify(job, null, 2)}

【候補者情報】
${JSON.stringify(candidate, null, 2)}

以下のJSON形式で返してください。

{
  "match_score": 0,
  "must_fit": "高 or 中 or 低",
  "want_fit": "高 or 中 or 低",
  "send_recommendation": true,
  "why_send": ["理由1", "理由2"],
  "appeal_points": ["訴求1", "訴求2"],
  "scout_message": "候補者向けのスカウト文"
}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      {
        role: "system",
        content:
          "あなたはトップクラスのリクルーティングアドバイザーです。営業、SaaS、人材業界、企画職の採用判断に強いです。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}

// DB保存
async function saveScoutResult(result, candidate, job) {
  const payload = {
    candidate_id: candidate.id || null,
    candidate_name: candidate.name || null,
    candidate_profile: candidate || {},
    job_id: job.id || null,
    match_score: result.match_score ?? null,
    must_fit: result.must_fit || null,
    want_fit: result.want_fit || null,
    send_recommendation: result.send_recommendation ?? false,
    why_send: result.why_send || [],
    appeal_points: result.appeal_points || [],
    scout_message: result.scout_message || "",
  };

  const { data, error } = await supabase
    .from("scout_candidates")
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// 評価API
app.post("/evaluate-scout", async (req, res) => {
  try {
    const { candidate, job } = req.body;

    if (!candidate || !job) {
      return res.status(400).json({
        ok: false,
        error: "candidate と job は必須です。",
      });
    }

    const result = await evaluateScoutCandidate(candidate, job);
    const saved = await saveScoutResult(result, candidate, job);

    return res.status(200).json({
      ok: true,
      result,
      saved_id: saved.id,
    });
  } catch (error) {
    console.error("evaluate-scout error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

// 保存済み一覧確認
app.get("/scout-results", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("scout_candidates")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      ok: true,
      items: data,
    });
  } catch (error) {
    console.error("scout-results error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
