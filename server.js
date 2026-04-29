require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { registerAutoScoutRoutes } = require("./autoScoutRoutes");

const app = express();

// 求人ID → 表示名
const JOB_MASTER = {
  job_001: {
    title: "改善提案や企画経験を活かせる営業企画 / RevOps",
    shortTitle: "営業企画 / RevOps",
  },
  job_002: {
    title: "既存顧客との関係構築を活かせるカスタマーサクセス企画",
    shortTitle: "カスタマーサクセス企画",
  },
  job_003: {
    title: "営業経験を活かして事業企画に挑戦できるポジション",
    shortTitle: "事業企画",
  },
};

function getJobInfo(jobId) {
  return (
    JOB_MASTER[jobId] || {
      title: jobId,
      shortTitle: jobId,
    }
  );
}

const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
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

function getCandidateEmail(candidate = {}) {
  return (
    candidate.candidate_email ||
    candidate.email ||
    candidate.mail ||
    candidate.email_address ||
    candidate.emailAddress ||
    candidate.contact_email ||
    ""
  );
}

function buildScoutSubject(candidate = {}, job = {}) {
  const name = candidate.name || candidate.candidate_name || "候補者様";

  const jobInfo = getJobInfo(job.job_id || job.id);

  const jobTitle =
    jobInfo.title ||
    job.title ||
    job.job_title ||
    job.job_id ||
    job.id ||
    "ポジション";

  const current = candidate.current_company || candidate.current_role || "";

  if (current) {
    return `${current}でのご経験を拝見し、${jobTitle}の件でご連絡しました`;
  }

  return `${name}様のご経験を拝見し、${jobTitle}の件でご連絡しました`;
}

function buildPersonalizedReason(candidate = {}, job = {}) {
  const text = JSON.stringify(candidate).toLowerCase();

  const jobTitle =
    job.title ||
    job.job_title ||
    job.job_id ||
    job.id ||
    "ポジション";

  if (
    job.job_id === "job_cs_planning" ||
    job.id === "job_cs_planning" ||
    job.job_id === "job_002"
  ) {
    if (text.includes("営業") || text.includes("sales")) {
      return `営業経験を活かしつつ、企画寄りにキャリアを広げたいご志向に、${jobTitle}が非常に近いと感じ、ご連絡いたしました。`;
    }

    return `顧客との関係構築経験を活かしながら、より上流の企画業務に関われる点で、${jobTitle}が合うと感じ、ご連絡いたしました。`;
  }

  if (
    job.job_id === "job_sales_planning" ||
    job.id === "job_sales_planning" ||
    job.job_id === "job_001"
  ) {
    return `これまでの営業経験や改善提案のご経験を、より仕組みづくりや営業企画に活かせると感じ、${jobTitle}の件でご連絡いたしました。`;
  }

  if (job.job_id === "job_revops" || job.id === "job_revops") {
    return `営業だけでなく、KPI設計や業務改善・仕組み化に関心をお持ちであれば、${jobTitle}との親和性が高いと感じ、ご連絡いたしました。`;
  }

  return `ご経歴を拝見し、${jobTitle}との親和性が高いと感じ、ご連絡いたしました。`;
}

function buildScoutMessage(candidate = {}, job = {}, evaluation = {}) {
  const name = candidate.name || candidate.candidate_name || "候補者様";
  const jobTitle =
    job.title || job.job_title || job.job_id || job.id || "ポジション";
  const companyName = process.env.SCOUT_COMPANY_NAME || "弊社";
  const senderName = process.env.SCOUT_SENDER_NAME || "採用担当";

  const strengths = normalizeArrayJson(candidate.strengths);
  const experience = normalizeArrayJson(candidate.experience);
  const whySend = normalizeArrayJson(evaluation.why_send);
  const appealPoints = normalizeArrayJson(evaluation.appeal_points);
  
　const personalizedReason = buildPersonalizedReason(candidate, job);
  
  const strengthsText = strengths.length
    ? `特に ${strengths.slice(0, 2).join("、")} のご経験に魅力を感じました。`
    : "";

  const expText = experience.length
    ? `これまでのご経験（${experience.slice(0, 2).join("、")}）は、今回の募集と親和性が高いと感じています。`
    : "";

  const whyText = whySend.length
    ? `今回ご連絡した理由は、${whySend.slice(0, 2).join("、")}ためです。`
    : "";

  const appealText = appealPoints.length
    ? `本ポジションでは、${appealPoints.slice(0, 2).join("、")}といった点をご提供できると考えています。`
    : "";

  return `${name}

突然のご連絡失礼いたします。
${companyName}の${senderName}と申します。

${personalizedReason}
${strengthsText}
${expText}
${whyText}
${appealText}

まずはカジュアルに情報交換のお時間をいただければ幸いです。
ご関心がございましたら、お気軽にご返信ください。

何卒よろしくお願いいたします。

${companyName}
${senderName}`;
}

function cleanResult(result = {}, candidate = {}, job = {}) {
  const normalized = {
    match_score: Number(result.match_score ?? 0),
    must_fit: result.must_fit || "中",
    want_fit: result.want_fit || "中",
    send_recommendation: Boolean(result.send_recommendation),
    why_send: normalizeArrayJson(result.why_send),
    appeal_points: normalizeArrayJson(result.appeal_points),
    scout_message: result.scout_message || "",
    scout_subject: result.scout_subject || "",
  };

  if (!normalized.scout_subject) {
    normalized.scout_subject = buildScoutSubject(candidate, job);
  }

  if (!normalized.scout_message) {
    normalized.scout_message = buildScoutMessage(candidate, job, normalized);
  }

  return normalized;
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
- scout_subject は候補者ごとに自然な件名にする
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
  "scout_subject": "候補者向け件名",
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

  return cleanResult(
    JSON.parse(response.choices[0].message.content),
    candidate,
    job
  );
}

async function saveScoutResult(result, candidate, job) {
  const candidateId = candidate.id || candidate.candidate_id || null;
  const jobId = job.id || job.job_id || null;

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

  const scoutSubject =
    result.scout_subject || buildScoutSubject(candidate, job);
  const scoutMessage =
    result.scout_message || buildScoutMessage(candidate, job, result);

 const payload = {
  candidate_id: candidateId,
  candidate_name: candidate.name || candidate.candidate_name || null,
  candidate_email: getCandidateEmail(candidate) || null,
  candidate_profile: candidate || {},
  job_id: jobId,
  match_score: result.match_score ?? null,
  must_fit: result.must_fit || null,
  want_fit: result.want_fit || null,
  send_recommendation: result.send_recommendation ?? false,
  why_send: result.why_send || [],
  appeal_points: result.appeal_points || [],
  scout_subject: scoutSubject,
  scout_message: scoutMessage,
  sent_job_title: job.title || job.job_title || job.job_id || job.id || null,
  sent_reason: JSON.stringify(result.why_send || []),
  sent_appeal_points: JSON.stringify(result.appeal_points || []),
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
  candidate_id: candidate.id || candidate.candidate_id || null,
  candidate_name: candidate.name || candidate.candidate_name || null,
  sent_status: candidate.sent_status || "未送信",
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

      items.sort(
        (a, b) => (b.result.match_score || 0) - (a.result.match_score || 0)
      );

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

    const items = (data || []).map((item) => ({
      ...item,
      candidate_email:
        item.candidate_email ||
        item.email ||
        item.candidate_profile?.candidate_email ||
        item.candidate_profile?.email ||
        item.candidate_profile?.mail ||
        item.candidate_profile?.email_address ||
        "",
      scout_subject:
        item.scout_subject ||
        buildScoutSubject(item.candidate_profile || item, {
          id: item.job_id,
          job_id: item.job_id,
        }),
      scout_message:
        item.scout_message ||
        buildScoutMessage(
          item.candidate_profile || item,
          { id: item.job_id, job_id: item.job_id },
          item
        ),
    }));

    return res.status(200).json({
      ok: true,
      items,
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

app.post("/match-jobs", async (req, res) => {
  try {
    const candidate = req.body;

    const jobsPath = path.join(__dirname, "jobs_database.json");
    const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf-8"));

    const prompt = `
あなたは人材紹介会社の求人提案アドバイザーです。
候補者情報をもとに、コンサルティングファーム求人DBからマッチする求人を選んでください。

候補者:
${JSON.stringify(candidate, null, 2)}

求人DB:
${JSON.stringify(jobs, null, 2)}

以下の形式で日本語で出力してください。

## 求人マッチング結果

### ◎ 最有力マッチ
1. ポジション名（会社名）
- マッチ理由
- 活かせる経験
- 懸念点

### ○ 有力マッチ
2〜3件

### △ 可能性あり
1〜2件

### 推薦時のポイント
候補者を推薦する際の打ち出し方をまとめてください。
`;

const msg = await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 2500,
  temperature: 0.3,
  messages: [
    {
      role: "user",
      content: prompt
    }
  ]
});

res.json({
  ok: true,
  result: msg.content[0].text
});
  } catch (e) {
    console.error("match-jobs error:", e);
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

app.post("/handle-reply", async (req, res) => {
  try {
    const { candidate_name, reply_text } = req.body;

    const meetingLink =
      process.env.SCOUT_MEETING_LINK || "https://example.com/calendar";

    const prompt = `
あなたは人材紹介会社のキャリア面談担当です。
候補者からの返信内容を読み取り、面談化につながる自然な返信文を作成してください。

【候補者名】
${candidate_name || "候補者様"}

【候補者からの返信】
${reply_text}

【分類】
以下のどれかに分類してください。
- 興味あり
- 検討中
- 日程希望
- 断り
- その他

【出力形式】
以下のJSONだけで返してください。

{
  "intent": "興味あり",
  "should_send_schedule": true,
  "sms_message": "候補者に送るSMS文面",
  "follow_up_message": "未対応時に送るフォロー文面"
}

【ルール】
- 興味あり、検討中、日程希望の場合は should_send_schedule を true
- 断りの場合は should_send_schedule を false
- SMS文面には必ず以下の日程調整リンクを自然に入れる
${meetingLink}
- SMSは短く、丁寧で、営業感を出しすぎない
- 日本語で返す
`;

    const msg = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1200,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = msg.content[0].text;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = {
        intent: "その他",
        should_send_schedule: false,
        sms_message: text,
        follow_up_message: "",
      };
    }

    res.json({
      ok: true,
      result: parsed,
    });
  } catch (e) {
    console.error("handle-reply error:", e);
    res.status(500).json({
      ok: false,
      error: e.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
