/**
 * 手机遥控桥：一轮干完把结果推到 iPhone，人在手机上回一句就能让 pi 接着干。
 *
 * 为什么是这个形态：SSH + tmux 也能在手机上接管，但小屏敲 TUI 太累；这里只做
 * 「收结果 + 回一句」，覆盖离座场景的绝大多数。出站走 Bark（苹果 APNs，免注册、
 * 国内直连），入站走本机 HTTP。
 *
 * 安全边界只有两道：Tailscale 网内可达 + token。所以 server **只绑 Tailscale 地址**，
 * 拿不到就退回 127.0.0.1——绝不能绑 0.0.0.0，那等于把本机代码执行入口挂到公共 WiFi 上。
 * 没设 token 就干脆不起 server（fail-closed），宁可不能遥控也不裸奔。
 *
 * 纪律照 notify.ts：任何失败都静默跳过，绝不拖慢或打断主流程。
 */
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * 凭据放文件，不放环境变量。
 *
 * 环境变量是从父进程继承来的：tmux server 一旦早于配置文件启动，它底下所有窗口
 * 就都拿不到——而且没有任何报错，只表现为「手机收不到消息」，排查成本极高（实测踩过）。
 * 文件每次启动现读，跟 shell 多老、从哪个窗口起的都无关。
 * 环境变量仍然优先，留给临时覆盖和测试。
 */
type Config = { token?: string; barkKey?: string; barkServer?: string; port?: number };

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "mobile-bridge.json");

function loadConfig(): Config {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
	} catch {
		// 没配置就是没开启这个功能，静默。
		return {};
	}
}

const CONFIG = loadConfig();
const PORT = Number.parseInt(process.env.PI_REMOTE_PORT ?? String(CONFIG.port ?? 8317), 10);
const TOKEN = process.env.PI_REMOTE_TOKEN ?? CONFIG.token ?? "";
const BARK_KEY = process.env.PI_BARK_KEY ?? CONFIG.barkKey ?? "";
const BARK_SERVER = (process.env.PI_BARK_SERVER ?? CONFIG.barkServer ?? "https://api.day.app").replace(/\/+$/, "");

/** 手机页面能往回翻的条数，够看清上下文就行，多了白占内存。 */
const HISTORY_MAX = 30;
/** 推送正文截断长度——通知栏再长也展不开。 */
const BODY_MAX = 300;
/** 请求体上限，防止有人往这个口灌大包。 */
const REQUEST_MAX_BYTES = 16 * 1024;
const BARK_TIMEOUT_MS = 5000;
const TAILSCALE_PROBE_TIMEOUT_MS = 2000;
/** 秒回的任务不值得推——人还没来得及走开。 */
const MIN_DURATION_MS = 3000;

type Entry = { i: number; role: "user" | "assistant"; text: string };
type Outcome = { kind: "error"; message: string } | { kind: "aborted" };

let server: Server | undefined;
/** HTTP 请求到来时要用 ctx 注入消息，所以在 session_start 存一份。 */
let context: ExtensionContext | undefined;
let history: Entry[] = [];
let seq = 0;
let sessionName: string | undefined;
let runStartedAt: number | undefined;
let lastOutcome: Outcome | undefined;
let lastAssistantText = "";
/** 推送里那个「点一下打开」的地址，绑定成功后才知道，失败时就不带 url。 */
let pageUrl: string | undefined;

/** assistant 的 content 是块数组（text/thinking/toolCall），只取 text 拼起来。 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			const b = block as { type?: unknown; text?: unknown };
			return b?.type === "text" && typeof b.text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function clip(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 绑定地址：优先 Tailscale 的 100.x，拿不到就只听本机回环。 */
function tailscaleIp(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("tailscale", ["ip", "-4"], { timeout: TAILSCALE_PROBE_TIMEOUT_MS }, (error, stdout) => {
			if (error) return resolve(undefined);
			const ip = stdout.split("\n")[0]?.trim();
			resolve(ip && /^100\./.test(ip) ? ip : undefined);
		});
	});
}

/** 定长比较，避免用 === 比 token 时泄露前缀信息。 */
function tokenMatches(candidate: string): boolean {
	const a = Buffer.from(candidate);
	const b = Buffer.from(TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, url: URL): boolean {
	const header = req.headers.authorization;
	if (typeof header === "string" && header.startsWith("Bearer ")) {
		return tokenMatches(header.slice(7));
	}
	const query = url.searchParams.get("t");
	return typeof query === "string" && tokenMatches(query);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > REQUEST_MAX_BYTES) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, data: unknown): void {
	const payload = JSON.stringify(data);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

function remember(role: Entry["role"], text: string): void {
	if (!text) return;
	history.push({ i: ++seq, role, text });
	if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
}

function title(ctx: ExtensionContext): string {
	return `pi · ${sessionName || path.basename(ctx.cwd) || "pi"}`;
}

async function pushBark(titleText: string, body: string, isError: boolean): Promise<void> {
	if (!BARK_KEY) return;
	try {
		await fetch(`${BARK_SERVER}/push`, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				device_key: BARK_KEY,
				title: titleText,
				body,
				group: "pi",
				isArchive: "1",
				...(pageUrl ? { url: pageUrl } : {}),
				...(isError ? { level: "timeSensitive" } : {}),
			}),
			signal: AbortSignal.timeout(BARK_TIMEOUT_MS),
		});
	} catch {
		// 推送失败就算了，不能影响手上的活。
	}
}

/**
 * 只有 stopReason === "error" 才值得响；"aborted" 是人自己按 Esc 停的，
 * 人就在电脑前，不该再推一条到手机上。
 */
function outcomeOf(messages: readonly unknown[]): Outcome | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return { kind: "error", message: message.errorMessage ?? "provider error" };
		if (message.stopReason === "aborted") return { kind: "aborted" };
		return undefined;
	}
	return undefined;
}

/** 手机页面：一个输入框 + 一列消息，3 秒轮询。不引框架、不引 CDN。 */
function page(): string {
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>pi</title>
<style>
:root{color-scheme:dark;--bg:#1d2021;--fg:#ebdbb2;--dim:#928374;--me:#3c3836;--card:#282828;--line:#504945;--ok:#b8bb26;--busy:#fabd2f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;
     display:flex;flex-direction:column;height:100dvh;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;font-size:13px}
#dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:none}
#name{font-weight:600}
#stat{color:var(--dim);margin-left:auto}
main{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.m{padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;max-width:88%}
.user{background:var(--me);align-self:flex-end;border-bottom-right-radius:3px}
.assistant{background:var(--card);align-self:flex-start;border-bottom-left-radius:3px}
form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line)}
textarea{flex:1;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:10px;
         padding:9px 12px;font:inherit;resize:none;max-height:120px}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:0 16px;font:inherit}
button:active{background:var(--me)}
#stop{color:#fb4934}
</style>
<header><span id="dot"></span><span id="name">pi</span><span id="stat">连接中…</span></header>
<main id="log"></main>
<form id="f"><textarea id="t" rows="1" placeholder="说点什么…"></textarea><button id="stop" type="button">停</button><button type="submit">发</button></form>
<script>
var url = new URL(location.href);
var token = url.searchParams.get('t');
if (token) { try { localStorage.setItem('pi_token', token); } catch (e) {} }
else { try { token = localStorage.getItem('pi_token') || ''; } catch (e) { token = ''; } }

var log = document.getElementById('log');
var stat = document.getElementById('stat');
var dot = document.getElementById('dot');
var nameEl = document.getElementById('name');
var input = document.getElementById('t');
var seen = 0;

function api(path, body) {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

function render(entries) {
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.i <= seen) continue;
    seen = e.i;
    var div = document.createElement('div');
    div.className = 'm ' + e.role;
    div.textContent = e.text;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

function poll() {
  api('/state?since=' + seen).then(function (r) {
    if (r.status === 401) { stat.textContent = 'token 无效'; return; }
    return r.json().then(function (s) {
      nameEl.textContent = s.session || 'pi';
      stat.textContent = s.idle ? '空闲' : '忙碌中…';
      dot.style.background = s.idle ? 'var(--ok)' : 'var(--busy)';
      render(s.entries || []);
    });
  }).catch(function () { stat.textContent = '连不上'; });
}

document.getElementById('f').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  api('/say', { text: text }).then(function (r) { return r.json(); }).then(function (res) {
    if (res && res.queued) stat.textContent = '已排队，等它干完';
    poll();
  }).catch(function () { stat.textContent = '发送失败'; });
});

document.getElementById('stop').addEventListener('click', function () {
  api('/abort', {}).then(poll).catch(function () {});
});

input.addEventListener('input', function () {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

poll();
setInterval(poll, 3000);
</script>`;
}

async function handle(pi: ExtensionAPI, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (!authorized(req, url)) {
		json(res, 401, { error: "unauthorized" });
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page());
		return;
	}

	const ctx = context;
	if (!ctx) {
		json(res, 503, { error: "session not ready" });
		return;
	}

	if (req.method === "GET" && url.pathname === "/state") {
		const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
		json(res, 200, {
			idle: ctx.isIdle(),
			session: sessionName || path.basename(ctx.cwd),
			cwd: ctx.cwd,
			entries: history.filter((entry) => entry.i > since),
		});
		return;
	}

	if (req.method === "POST" && url.pathname === "/say") {
		let text = "";
		let mode = "";
		try {
			const parsed = JSON.parse(await readBody(req)) as { text?: unknown; mode?: unknown };
			text = typeof parsed.text === "string" ? parsed.text.trim() : "";
			mode = typeof parsed.mode === "string" ? parsed.mode : "";
		} catch {
			json(res, 400, { error: "bad request" });
			return;
		}
		if (!text) {
			json(res, 400, { error: "empty text" });
			return;
		}
		// 闲着就立刻起一轮；忙着必须指定投递方式，否则 sendUserMessage 会抛。
		const busy = !ctx.isIdle();
		try {
			if (!busy) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: mode === "steer" ? "steer" : "followUp" });
		} catch {
			json(res, 503, { error: "agent busy" });
			return;
		}
		json(res, 200, { accepted: true, queued: busy });
		return;
	}

	if (req.method === "POST" && url.pathname === "/abort") {
		ctx.abort();
		json(res, 200, { aborted: true });
		return;
	}

	json(res, 404, { error: "not found" });
}

export default function mobileBridge(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		history = [];
		seq = 0;
		sessionName = undefined;
		runStartedAt = undefined;
		lastOutcome = undefined;
		lastAssistantText = "";

		// 没配 token 就不开门。
		if (!TOKEN) return;
		if (server) return;

		const host = (await tailscaleIp()) ?? "127.0.0.1";
		const instance = createServer((req, res) => {
			handle(pi, req, res).catch(() => {
				try {
					json(res, 500, { error: "internal" });
				} catch {
					// 响应已经写出去了，忽略。
				}
			});
		});

		instance.on("error", (error: NodeJS.ErrnoException) => {
			server = undefined;
			if (!ctx.hasUI) return;
			// 多开 pi 很常见，第一个抢到端口的才是遥控目标，其余让位。
			if (error.code === "EADDRINUSE") {
				ctx.ui.notify(`手机遥控端口 ${PORT} 已被另一个 pi 会话占用，本会话只推送不接管`, "warning");
			} else {
				// 最常见的是 tailscale0 还没起来导致的 EADDRNOTAVAIL，说清楚免得白等。
				ctx.ui.notify(`手机遥控未启动（${error.code ?? error.message}），推送不受影响`, "warning");
			}
		});

		instance.listen(PORT, host, () => {
			server = instance;
			pageUrl = `http://${host}:${PORT}/?t=${encodeURIComponent(TOKEN)}`;
			if (ctx.hasUI) ctx.ui.notify(`手机遥控已挂载：http://${host}:${PORT}`, "info");
		});
	});

	pi.on("session_info_changed", async (event) => {
		sessionName = event.name;
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; content?: unknown };
		if (message?.role === "user") remember("user", clip(textOf(message.content), 500));
		else if (message?.role === "assistant") {
			const text = textOf(message.content);
			if (text) {
				lastAssistantText = text;
				remember("assistant", clip(text, 2000));
			}
		}
	});

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
		lastOutcome = undefined;
	});

	// agent_end 每跑完一轮底层循环就触发，自动重试还会再来一轮，以最后一次为准。
	pi.on("agent_end", async (event) => {
		lastOutcome = outcomeOf(event.messages);
	});

	// agent_settled 才是「确定不会再自动重试/续跑」，在这里推才不会推一半。
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.hasPendingMessages()) return;
		const elapsed = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
		const outcome = lastOutcome;
		runStartedAt = undefined;
		lastOutcome = undefined;
		// 人自己按 Esc 停的，人就在电脑前。
		if (outcome?.kind === "aborted") return;
		// 出错要立刻知道，不受耗时门槛限制。
		if (outcome === undefined && elapsed < MIN_DURATION_MS) return;
		const body =
			outcome !== undefined ? `❌ ${clip(outcome.message, BODY_MAX)}` : clip(lastAssistantText || "（无输出）", BODY_MAX);
		await pushBark(title(ctx), body, outcome !== undefined);
	});

	pi.on("session_shutdown", async () => {
		context = undefined;
		const instance = server;
		server = undefined;
		pageUrl = undefined;
		instance?.close();
	});
}
