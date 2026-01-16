export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");
    const u = await req.json();

    if (u.message) {
      const chat = u.message.chat.id;
      const user = u.message.from.id;

      if (u.message.text === "/start") {
        if (!(await subscribed(env, user))) {
          return send(env, chat, {
            text: `Please subscribe to ${env.REQUIRED_CHANNEL}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: "Subscribe", url: `https://t.me/${env.REQUIRED_CHANNEL.replace("@","")}` }],
                [{ text: "Check Subscription", callback_data: "check_sub" }]
              ]
            }
          });
        }
        return mainMenu(env, chat);
      }

      const state = await getState(env, user);

      if (state?.step === "single_uid") {
        state.uid = u.message.text;
        state.step = "single_pass";
        await setState(env, user, state);
        return send(env, chat, { text: "Send Password" });
      }

      if (state?.step === "single_pass") {
        state.pass = u.message.text;
        state.step = "single_bio";
        await setState(env, user, state);
        return send(env, chat, { text: "Send Bio Text" });
      }

      if (state?.step === "single_bio") {
        const url = `${env.API_BASE}/bio_upload?uid=${state.uid}&pass=${state.pass}&bio=${encodeURIComponent(u.message.text)}`;
        const r = await fetch(url).then(r => r.json());
        await clearState(env, user);
        await log(env, `Single UID bio updated\nUser: ${user}`);
        return send(env, chat, { text: JSON.stringify(r, null, 2) });
      }

      if (state?.step === "multi_bio") {
        state.bio = u.message.text;
        state.step = "multi_file";
        await setState(env, user, state);
        return send(env, chat, { text: "Send JSON file" });
      }

      if (u.message.document && state?.step === "multi_file") {
        const raw = await downloadFile(env, u.message.document.file_id);
        const json = JSON.parse(raw);
        const accounts = extractAccounts(json);

        const job = {
          total: accounts.length,
          done: 0,
          failed: 0,
          results: [],
          bio: state.bio
        };

        await clearState(env, user);
        await processBatch(env, chat, job, accounts);
        return;
      }
    }

    if (u.callback_query) {
      const c = u.callback_query;
      const chat = c.message.chat.id;
      const user = c.from_user.id;

      if (c.data === "check_sub") {
        return (await subscribed(env, user))
          ? mainMenu(env, chat)
          : answer(env, c.id, "Not subscribed");
      }

      if (c.data === "uidpass") {
        return send(env, chat, {
          text: "Choose account type",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Single Account", callback_data: "single" }],
              [{ text: "Multiple Accounts", callback_data: "multi" }]
            ]
          }
        });
      }

      if (c.data === "single") {
        await setState(env, user, { step: "single_uid" });
        return send(env, chat, { text: "Send UID" });
      }

      if (c.data === "multi") {
        await setState(env, user, { step: "multi_bio" });
        return send(env, chat, { text: "Send Bio Text" });
      }
    }

    return new Response("OK");
  }
};

async function processBatch(env, chat, job, list) {
  const chunk = 25;
  for (let i = 0; i < list.length; i += chunk) {
    const slice = list.slice(i, i + chunk);
    await Promise.allSettled(slice.map(async a => {
      try {
        const url = `${env.API_BASE}/bio_upload?uid=${a.uid}&pass=${a.password}&bio=${encodeURIComponent(job.bio)}`;
        await fetch(url);
        job.done++;
        job.results.push({ ...a, bio: job.bio });
      } catch {
        job.failed++;
      }
    }));

    await send(env, chat, {
      text: `Processing\n${progress(job.done, job.total)}\nDone: ${job.done}\nFailed: ${job.failed}`
    });
  }

  const file = JSON.stringify(job.results, null, 2);
  await send(env, chat, { text: "Completed" });
  await send(env, chat, { text: file.slice(0, 4000) });
  await log(env, `Multi UID completed\nTotal: ${job.total}\nDone: ${job.done}`);
}

function extractAccounts(input) {
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    let u, p;
    for (const k in o) {
      const n = k.toLowerCase();
      if (n === "uid" || n === "user_id") u = o[k];
      if (n === "password" || n === "pass") p = o[k];
    }
    if (u && p) out.push({ uid: String(u), password: String(p) });
    for (const k in o) walk(o[k]);
  })(input);
  return out;
}

const progress = (d, t) => "█".repeat(Math.floor(d / t * 10)) + "░".repeat(10 - Math.floor(d / t * 10));

const send = (e, c, b) => fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: c, ...b })
});

const answer = (e, i, t) => fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/answerCallbackQuery`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ callback_query_id: i, text: t })
});

const subscribed = async (e, u) =>
  (await fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/getChatMember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: e.REQUIRED_CHANNEL, user_id: u })
  }).then(r => r.json())).result?.status?.includes("member");

const mainMenu = (e, c) => send(e, c, {
  text: "Main Menu",
  reply_markup: {
    inline_keyboard: [
      [{ text: "Using UID / Password", callback_data: "uidpass" }],
      [{ text: "Developer", url: "https://t.me/DevZeron" }]
    ]
  }
});

const downloadFile = async (e, id) =>
  fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: id })
  }).then(r => r.json())
    .then(f => fetch(`https://api.telegram.org/file/bot${e.BOT_TOKEN}/${f.result.file_path}`).then(r => r.text()));

const log = (e, t) => send(e, e.LOG_CHANNEL, { text: t });

const getState = (e, u) => e.KV.get(`state:${u}`).then(s => s ? JSON.parse(s) : null);
const setState = (e, u, v) => e.KV.put(`state:${u}`, JSON.stringify(v));
const clearState = (e, u) => e.KV.delete(`state:${u}`);
