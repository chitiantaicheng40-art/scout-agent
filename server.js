require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const { registerAutoScoutRoutes } = require("./autoScoutRoutes");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

registerAutoScoutRoutes({ app, supabase });

app.get("/", (req, res) => {
  res.status(200).send("scout-agent is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "scout-agent",
    timestamp: new Date().toISOString(),
  });
});

function normalizeArrayJson(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function cleanResult(result = {}) {
  return {
    match_score: Number(result.match_score ?? 0),
    must_fit: result.must_fit || "中",
    want_fit: result.want_fit || "中",
    send_recommendation: Boolean(result.send_recommendation),
    why_send: normalizeArrayJson(result.why_send),
    appeal_points: normalizeArrayJson(result.appeal_points),
    scout_message: result.scout_message || "",
  };
}

async function evaluateScoutCandidate(candidate, job) {
  const prompt = `
あなたは一流の採用エージェントです。
目的は、候補者にスカウトを送るべきかを実務目線で厳しく判断することです。

【評価方針】
- Must条件を最重視
- 推測で断定しない
- 足りない情報は「確認必要」と表現する
- 送る理由は、採用担当者が納得できるレベルで具体的に書く
- scout_message は候補者向けに自然な日本語で書く
- テンプレ感の強い文章は禁止
- 過度に持ち上げすぎない
- JSONのみ返す

【候補者】
${JSON.stringify(candidate, null, 2)}

【求人】
${JSON.stringify(job, null, 2)}

以下のJSON形式で返してください。

{
  "match_score": 0,
  "must_fit": "高",
  "want_fit": "中",
  "send_recommendation": true,
  "why_send": ["理由1", "理由2"],
  "appeal_points": ["訴求1", "訴求2"],
  "scout_message": "候補者向けスカウト文"
}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      {
        role: "system",
        content:
          "あなたはトップクラスのリクルーティングアドバイザーです。営業、SaaS、人材業界、営業企画、RevOps、事業企画の採用判断に強いです。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    response_format: { type: "json_object" },
  });

  return cleanResult(JSON.parse(response.choices[0].message.content));
}

async function saveScoutResult(result, candidate, job) {
  const candidateId = candidate.id || null;
  const jobId = job.id || null;

  if (!candidateId || !jobId) {
    throw new Error("candidate.id と job.id は必須です。");
  }

  const { data: existing, error: findError } = await supabase
    .from("scout_candidates")
    .select("id, sent_status")
    .eq("candidate_id", candidateId)
    .eq("job_id", jobId)
    .maybeSingle();

  if (findError) throw findError;

  const payload = {
    candidate_id: candidateId,
    candidate_name: candidate.name || null,
    candidate_profile: candidate || {},
    job_id: jobId,
    match_score: result.match_score ?? null,
    must_fit: result.must_fit || null,
    want_fit: result.want_fit || null,
    send_recommendation: result.send_recommendation ?? false,
    why_send: result.why_send || [],
    appeal_points: result.appeal_points || [],
    scout_message: result.scout_message || "",
    sent_status: existing?.sent_status || "未送信",
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from("scout_candidates")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("scout_candidates")
    .insert(payload)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function evaluateAndSaveOne(candidate, job) {
  const result = await evaluateScoutCandidate(candidate, job);
  const saved = await saveScoutResult(result, candidate, job);

  return {
    candidate_id: candidate.id || null,
    candidate_name: candidate.name || null,
    result,
    saved_id: saved.id,
  };
}

app.post("/evaluate-scout", async (req, res) => {
  try {
    const { candidate, candidates, job } = req.body;

    if (!job) {
      return res.status(400).json({
        ok: false,
        error: "job は必須です。",
      });
    }

    if (Array.isArray(candidates)) {
      if (candidates.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "candidates が空です。",
        });
      }

      const items = [];
      for (const oneCandidate of candidates) {
        const item = await evaluateAndSaveOne(oneCandidate, job);
        items.push(item);
      }

      items.sort((a, b) => (b.result.match_score || 0) - (a.result.match_score || 0));

      return res.status(200).json({
        ok: true,
        mode: "bulk",
        total: items.length,
        items,
      });
    }

    if (!candidate) {
      return res.status(400).json({
        ok: false,
        error: "candidate または candidates は必須です。",
      });
    }

    const result = await evaluateScoutCandidate(candidate, job);
    const saved = await saveScoutResult(result, candidate, job);

    return res.status(200).json({
      ok: true,
      mode: "single",
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

app.get("/scout-results", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("scout_candidates")
      .select("*")
      .order("match_score", { ascending: false })
      .limit(100);

    if (error) throw error;

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

app.post("/update-sent-status", async (req, res) => {
  try {
    const { id, sent_status } = req.body;

    if (!id || !sent_status) {
      return res.status(400).json({
        ok: false,
        error: "id と sent_status は必須です。",
      });
    }

    const allowed = ["未送信", "送信済み", "返信あり", "面談設定", "見送り"];
    if (!allowed.includes(sent_status)) {
      return res.status(400).json({
        ok: false,
        error: "sent_status の値が不正です。",
      });
    }

    const { data, error } = await supabase
      .from("scout_candidates")
      .update({ sent_status })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    return res.status(200).json({
      ok: true,
      item: data,
    });
  } catch (error) {
    console.error("update-sent-status error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "internal server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
