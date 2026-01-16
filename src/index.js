export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");
    const u = await req.json();

    if (u.message) {
      const chat = u.message.chat.id;
      const uid = u.message.from.id;

      if (u.message.text === "/start") {
        if (!(await sub(env, uid))) {
          return send(env, chat, {
            text: `Please subscribe to ${env.REQUIRED_CHANNEL}`,
            reply_markup: {
              inline_keyboard: [
                [{ text: "Subscribe", url: `https://t.me/${env.REQUIRED_CHANNEL.replace("@","")}` }],
                [{ text: "Check Subscription", callback_data: "check" }]
              ]
            }
          });
        }
        return mainMenu(env, chat);
      }

      const state = await get(env, uid);

      if (u.message.document && state?.mode === "multi_uid") {
        const file = await tgFile(env, u.message.document.file_id);
        const accounts = extract(JSON.parse(file));
        const job = `job:${chat}:${Date.now()}`;

        await env.KV.put(job, JSON.stringify({
          chat,
          total: accounts.length,
          done: 0,
          failed: 0,
          bio: state.bio,
          data: []
        }));

        for (const a of accounts) {
          await env.BIO_QUEUE.send({ job, ...a });
        }

        return send(env, chat, { text: `Processing started\nTotal: ${accounts.length}` });
      }

      if (state?.step === "single_uid") {
        state.uid = u.message.text;
        state.step = "single_pass";
        await set(env, uid, state);
        return send(env, chat, { text: "Send Password" });
      }

      if (state?.step === "single_pass") {
        state.password = u.message.text;
        state.step = "single_bio";
        await set(env, uid, state);
        return send(env, chat, { text: "Send Bio Text" });
      }

      if (state?.step === "single_bio") {
        const r = await fetch(`${env.API_BASE}/bio_upload?uid=${state.uid}&pass=${state.password}&bio=${encodeURIComponent(u.message.text)}`);
        await clear(env, uid);
        return send(env, chat, { text: JSON.stringify(await r.json(), null, 2) });
      }
    }

    if (u.callback_query) {
      const c = u.callback_query;
      const chat = c.message.chat.id;
      const uid = c.from_user.id;

      if (c.data === "check") {
        return (await sub(env, uid)) ? mainMenu(env, chat) : answer(env, c.id, "Not subscribed");
      }

      if (c.data === "uidpass") {
        return send(env, chat, {
          text: "Choose account type",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Single Account", callback_data: "single_uid" }],
              [{ text: "Multiple Accounts", callback_data: "multi_uid" }]
            ]
          }
        });
      }

      if (c.data === "single_uid") {
        await set(env, uid, { step: "single_uid" });
        return send(env, chat, { text: "Send UID" });
      }

      if (c.data === "multi_uid") {
        await set(env, uid, { mode: "multi_uid" });
        return send(env, chat, { text: "Send Bio Text" });
      }
    }

    return new Response("OK");
  },

  async queue(batch, env) {
    for (const m of batch.messages) {
      const { job, uid, password } = m.body;
      const d = JSON.parse(await env.KV.get(job));
      if (!d) { await m.ack(); continue; }

      try {
        const r = await fetch(`${env.API_BASE}/bio_upload?uid=${uid}&pass=${password}&bio=${encodeURIComponent(d.bio)}`);
        if (r.ok) d.data.push({ uid, password, bio: d.bio }), d.done++;
        else d.failed++;
      } catch { d.failed++; }

      await env.KV.put(job, JSON.stringify(d));

      if ((d.done + d.failed) % 100 === 0 || d.done + d.failed === d.total) {
        await send(env, d.chat, {
          text: `Progress\n${bar(d.done, d.total)}\nDone: ${d.done}\nFailed: ${d.failed}`
        });
      }

      if (d.done + d.failed === d.total) {
        await send(env, d.chat, {
          text: "Completed",
        });
        await send(env, env.LOG_CHANNEL, {
          text: `Multi bio completed\nTotal: ${d.total}\nSuccess: ${d.done}`
        });
      }

      await m.ack();
    }
  }
};

function extract(j) {
  const r = [];
  (function w(o){
    if (!o || typeof o !== "object") return;
    let u, p;
    for (const k in o) {
      const l = k.toLowerCase();
      if (l === "uid" || l === "user_id") u = o[k];
      if (l === "password" || l === "pass") p = o[k];
    }
    if (u && p) r.push({ uid: u, password: p });
    for (const k in o) w(o[k]);
  })(j);
  return r;
}

const bar = (d,t)=>"🟩".repeat(Math.floor(d/t*10))+"⬜".repeat(10-Math.floor(d/t*10));

const send = (e,c,b)=>fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:c,...b})});
const answer=(e,i,t)=>fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/answerCallbackQuery`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({callback_query_id:i,text:t})});
const sub=async(e,u)=>(await fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/getChatMember`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:e.REQUIRED_CHANNEL,user_id:u})}).then(r=>r.json())).result?.status?.includes("member");
const mainMenu=(e,c)=>send(e,c,{text:"Main Menu",reply_markup:{inline_keyboard:[[{"text":"Using UID / Password","callback_data":"uidpass"}],[{"text":"Developer","url":"https://t.me/DevZeron"}]]}});
const tgFile=async(e,id)=>fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/getFile`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file_id:id})}).then(r=>r.json()).then(f=>fetch(`https://api.telegram.org/file/bot${e.BOT_TOKEN}/${f.result.file_path}`).then(r=>r.text()));
const get=(e,u)=>e.KV.get(`state:${u}`).then(s=>s?JSON.parse(s):null);
const set=(e,u,v)=>e.KV.put(`state:${u}`,JSON.stringify(v));
const clear=(e,u)=>e.KV.delete(`state:${u}`);
