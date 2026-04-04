const express = require("express");

/**
 * 使い方:
 * const { registerAutoScoutRoutes } = require("./autoScoutRoutes");
 * registerAutoScoutRoutes({ app, supabase });
 */

function registerAutoScoutRoutes({ app, supabase }) {
  if (!app) throw new Error("registerAutoScoutRoutes: app is required");
  if (!supabase) throw new Error("registerAutoScoutRoutes: supabase is required");

  const router = express.Router();

  function nowIso() {
    return new Date().toISOString();
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeCandidateId(candidate) {
    return (
      candidate.id ||
      candidate.candidate_id ||
      candidate.email ||
      `candidate_${Math.random().toString(36).slice(2)}`
    );
  }

  function normalizeJobId(candidate) {
    return candidate.job_id || candidate.jobId || candidate.job || "unknown_job";
  }

  function normalizeRecommend(candidate) {
    if (candidate.recommend === true) return true;
    if (candidate.recommend === "true") return true;
    if (candidate.recommend === "1") return true;
    if (candidate.send_recommended === true) return true;
    if (candidate.send_recommended === "true") return true;
    if (candidate.send_recommended === "1") return true;
    return false;
  }

  function normalizeScore(candidate) {
    const raw = candidate.score ?? candidate.total_score ?? candidate.match_score ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function buildDefaultSubject(candidate) {
    const name = candidate.name || candidate.candidate_name || "";
    if (name) {
      return `${name}様のご経歴を拝見し、ご連絡いたしました`;
    }
    return "ご経歴を拝見し、ご連絡いたしました";
  }

  function buildDefaultBody(candidate) {
    const name = candidate.name || candidate.candidate_name || "候補者様";
    const companyName = process.env.SCOUT_COMPANY_NAME || "弊社";
    const senderName = process.env.SCOUT_SENDER_NAME || "採用担当";
    const senderCompany = process.env.SCOUT_SENDER_COMPANY || companyName;
    const meetingLink = process.env.SCOUT_MEETING_LINK || "";
    const jobTitle =
      candidate.job_title || candidate.job_name || candidate.job_id || "ポジション";

    return `${name}

突然のご連絡失礼いたします。
${senderCompany}の${senderName}と申します。

ご経歴を拝見し、${jobTitle}ポジションにてぜひ一度お話したいと思いご連絡いたしました。

これまでのご経験が、今回のポジションと非常に親和性が高いと感じております。
もし少しでもご関心があれば、まずはカジュアルに情報交換のお時間をいただけますと幸いです。

${meetingLink ? `以下よりご都合の良い日時をご選択いただけます。\n${meetingLink}\n\n` : ""}ご興味がございましたら、その旨ご返信いただけますと幸いです。
何卒よろしくお願いいたします。

${senderCompany}
${senderName}`;
  }

  async function ensureNoDuplicateRecentSend(candidateEmail, jobId) {
    if (!candidateEmail) return false;

    const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString();

    const { data, error } = await supabase
      .from("scout_send_logs")
      .select("id, candidate_email, job_id, send_status, sent_at")
      .eq("candidate_email", candidateEmail)
      .eq("job_id", jobId)
      .gte("created_at", since)
      .in("send_status", ["sent", "pending"])
      .limit(1);

    if (error) {
      console.error("ensureNoDuplicateRecentSend error:", error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }

  async function insertSendLog(payload) {
    const insertPayload = {
      candidate_id: payload.candidate_id,
      candidate_name: payload.candidate_name || null,
      candidate_email: payload.candidate_email || null,
      job_id: payload.job_id,
      subject: payload.subject || null,
      body: payload.body || null,
      send_status: payload.send_status || "pending",
      sent_at: payload.sent_at || null,
      reply_status: payload.reply_status || "none",
      reply_text: payload.reply_text || null,
      reply_received_at: payload.reply_received_at || null,
      created_at: payload.created_at || nowIso(),
      updated_at: payload.updated_at || nowIso(),
    };

    const { data, error } = await supabase
      .from("scout_send_logs")
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async function updateSendLog(id, patch) {
    const payload = {
      ...patch,
      updated_at: nowIso(),
    };

    const { data, error } = await supabase
      .from("scout_send_logs")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async function sendScoutEmail({ to, subject, body }) {
    const resendApiKey = process.env.RESEND_API_KEY;
    const from = process.env.SCOUT_FROM_EMAIL;

    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not set");
    }

    if (!from) {
      throw new Error("SCOUT_FROM_EMAIL is not set");
    }

    if (!to) {
      throw new Error("recipient email is empty");
    }

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.8; white-space: pre-wrap;">
        ${escapeHtml(body)}
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(`sendScoutEmail failed: ${res.status} ${JSON.stringify(json)}`);
    }

    return json;
  }

  async function autoSendRecommendedScouts(candidates = [], options = {}) {
    const scoreThreshold = Number(options.scoreThreshold ?? 80);
    const dryRun = !!options.dryRun;
    const skipDuplicate = options.skipDuplicate !== false;

    const results = [];

    for (const candidate of candidates) {
      const candidateId = normalizeCandidateId(candidate);
      const candidateName = candidate.name || candidate.candidate_name || "";
      const candidateEmail = candidate.email || candidate.candidate_email || "";
      const jobId = normalizeJobId(candidate);
      const score = normalizeScore(candidate);
      const recommend = normalizeRecommend(candidate);

      if (!recommend) {
        results.push({
          candidate_id: candidateId,
          candidate_name: candidateName,
          candidate_email: candidateEmail,
          job_id: jobId,
          status: "skipped",
          reason: "not_recommended",
        });
        continue;
      }

      if (!candidateEmail) {
        results.push({
          candidate_id: candidateId,
          candidate_name: candidateName,
          candidate_email: candidateEmail,
          job_id: jobId,
          status: "skipped",
          reason: "no_email",
        });
        continue;
      }

      if (score < scoreThreshold) {
        results.push({
          candidate_id: candidateId,
          candidate_name: candidateName,
          candidate_email: candidateEmail,
          job_id: jobId,
          status: "skipped",
          reason: `score_below_threshold:${score}`,
        });
        continue;
      }

      if (skipDuplicate) {
        const duplicated = await ensureNoDuplicateRecentSend(candidateEmail, jobId);
        if (duplicated) {
          results.push({
            candidate_id: candidateId,
            candidate_name: candidateName,
            candidate_email: candidateEmail,
            job_id: jobId,
            status: "skipped",
            reason: "duplicate_recent_send",
          });
          continue;
        }
      }

      const subject = candidate.scout_subject || buildDefaultSubject(candidate);
      const body = candidate.scout_body || buildDefaultBody(candidate);

      let logRow = null;

      try {
        logRow = await insertSendLog({
          candidate_id: candidateId,
          candidate_name: candidateName,
          candidate_email: candidateEmail,
          job_id: jobId,
          subject,
          body,
          send_status: dryRun ? "dry_run" : "pending",
        });

        if (!dryRun) {
         const sendResult = await sendScoutEmail({
  to: candidateEmail,
  subject,
  body,
});

await updateSendLog(logRow.id, {
  send_status: "sent",
  sent_at: nowIso(),
});

await supabase
  .from("scout_candidates")
  .update({
    sent_status: "送信済み",
    sent_at: new Date().toISOString(),
    scout_subject: subject,
    scout_body: body
  })
  .eq("id", candidateId);

results.push({
  candidate_id: candidateId,
  candidate_name: candidateName,
  candidate_email: candidateEmail,
  job_id: jobId,
  status: "sent",
  resend_id: sendResult.id || null,
});
        } else {
          results.push({
            candidate_id: candidateId,
            candidate_name: candidateName,
            candidate_email: candidateEmail,
            job_id: jobId,
            status: "dry_run",
          });
        }
      } catch (error) {
        console.error("autoSendRecommendedScouts send error:", error);

        try {
          if (logRow?.id) {
            await updateSendLog(logRow.id, {
              send_status: "failed",
            });
          } else {
            await insertSendLog({
              candidate_id: candidateId,
              candidate_name: candidateName,
              candidate_email: candidateEmail,
              job_id: jobId,
              subject,
              body,
              send_status: "failed",
            });
          }
        } catch (logError) {
          console.error("failed to write failed log:", logError);
        }

        results.push({
          candidate_id: candidateId,
          candidate_name: candidateName,
          candidate_email: candidateEmail,
          job_id: jobId,
          status: "failed",
          error: error.message,
        });
      }
    }

    return results;
  }

  function summarizeAutoSendResults(result = []) {
    return {
      total: result.length,
      sent_count: result.filter((r) => r.status === "sent").length,
      dry_run_count: result.filter((r) => r.status === "dry_run").length,
      failed_count: result.filter((r) => r.status === "failed").length,
      skipped_count: result.filter((r) => r.status === "skipped").length,
    };
  }

  router.post("/auto-send-scouts", async (req, res) => {
    try {
      const { candidates, scoreThreshold, dryRun, skipDuplicate } = req.body || {};

      if (!Array.isArray(candidates)) {
        return res.status(400).json({
          ok: false,
          error: "candidates must be an array",
        });
      }

      const result = await autoSendRecommendedScouts(candidates, {
        scoreThreshold,
        dryRun,
        skipDuplicate,
      });

      return res.json({
        ok: true,
        summary: summarizeAutoSendResults(result),
        result,
      });
    } catch (error) {
      console.error("/api/auto-send-scouts error:", error);
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  router.get("/scout-send-logs", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 100), 500);

      const { data, error } = await supabase
        .from("scout_send_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw error;

      return res.json({
        ok: true,
        count: data.length,
        logs: data,
      });
    } catch (error) {
      console.error("/api/scout-send-logs error:", error);
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  router.get("/scout-summary", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("scout_send_logs")
        .select("job_id, send_status, reply_status");

      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      const byJob = {};

      for (const row of rows) {
        const jobId = row.job_id || "unknown_job";
        if (!byJob[jobId]) {
          byJob[jobId] = {
            job_id: jobId,
            total: 0,
            sent: 0,
            failed: 0,
            pending: 0,
            dry_run: 0,
            reply: 0,
            interview: 0,
            decline: 0,
          };
        }

        byJob[jobId].total += 1;

        if (row.send_status === "sent") byJob[jobId].sent += 1;
        if (row.send_status === "failed") byJob[jobId].failed += 1;
        if (row.send_status === "pending") byJob[jobId].pending += 1;
        if (row.send_status === "dry_run") byJob[jobId].dry_run += 1;

        if (row.reply_status === "reply") byJob[jobId].reply += 1;
        if (row.reply_status === "interview") byJob[jobId].interview += 1;
        if (row.reply_status === "decline") byJob[jobId].decline += 1;
      }

      const list = Object.values(byJob).map((x) => ({
        ...x,
        reply_rate: x.sent > 0 ? Number(((x.reply / x.sent) * 100).toFixed(1)) : 0,
        interview_rate: x.sent > 0 ? Number(((x.interview / x.sent) * 100).toFixed(1)) : 0,
      }));

      return res.json({
        ok: true,
        jobs: list,
      });
    } catch (error) {
      console.error("/api/scout-summary error:", error);
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  router.post("/update-reply-status", async (req, res) => {
    try {
      const { logId, reply_status, reply_text } = req.body || {};

      if (!logId) {
        return res.status(400).json({
          ok: false,
          error: "logId is required",
        });
      }

      const allowed = ["none", "reply", "interview", "decline"];
      if (!allowed.includes(reply_status)) {
        return res.status(400).json({
          ok: false,
          error: "reply_status must be one of none/reply/interview/decline",
        });
      }

      const updated = await updateSendLog(logId, {
        reply_status,
        reply_text: reply_text || null,
        reply_received_at: reply_status === "none" ? null : nowIso(),
      });

      return res.json({
        ok: true,
        log: updated,
      });
    } catch (error) {
      console.error("/api/update-reply-status error:", error);
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  app.use("/api", router);
}

module.exports = {
  registerAutoScoutRoutes,
};
