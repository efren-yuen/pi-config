/** LSP 协议层回归：分帧、握手、服务器请求应答、文档同步、诊断、按符号定位。 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const lsp = require("/home/efren/.pi/agent/bin/lsp");
const HERE = __dirname;

let passed = 0;
function check(label, condition, detail) {
	if (condition) { passed++; console.log(`  ✓ ${label}`); }
	else { console.log(`  ✗ ${label}${detail ? `  → ${detail}` : ""}`); process.exitCode = 1; }
}

async function main() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lsp-test-"));
	const recordFile = path.join(workdir, "record.json");
	const sample = path.join(workdir, "sample.fake");
	// 正文含中文：验证分帧按字节数而不是字符数截取。
	fs.writeFileSync(sample, ["第一行 中文内容", "second", "  BOOM 这里应当报错", "def 目标方法():", "  pass", "  调用点"].join("\n"));

	const entry = {
		command: [process.execPath, path.join(HERE, "fake-server.js")],
		extensions: [".fake"],
		languageId: "fake",
		env: { FAKE_RECORD: recordFile },
		settings: { fake: { deep: { value: 42 } } },
		readySignal: { method: "fake/status", match: { type: "Ready" } },
		readyTimeoutMs: 5000,
	};

	const logs = [];
	const client = new lsp.LspClient({ id: "fake", entry, root: workdir, log: (line) => logs.push(line) });
	await client.start();

	console.log("握手与就绪信号");
	const ready = await client.waitReady(5000);
	check("readySignal 命中后进入就绪", ready === true);
	check("initialize 返回的 capabilities 已保存", client.capabilities.definitionProvider === true);

	console.log("服务器→客户端请求必须全部被应答");
	await new Promise((r) => setTimeout(r, 250));
	const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
	check("client/registerCapability 已应答", record.responses["100"] !== undefined, JSON.stringify(record.responses["100"]));
	check("workspace/configuration 已应答", Array.isArray(record.responses["101"]?.result), JSON.stringify(record.responses["101"]));
	check("workspace/configuration 按 section 取到嵌套值", record.responses["101"]?.result?.[0]?.value === 42, JSON.stringify(record.responses["101"]));
	check("workspace/configuration 取不到的 section 回 null", record.responses["101"]?.result?.[1] === null);
	check("window/workDoneProgress/create 已应答", record.responses["102"] !== undefined);
	check("workspace/applyEdit 回 applied:false", record.responses["103"]?.result?.applied === false, JSON.stringify(record.responses["103"]));
	check("未知方法回 MethodNotFound 而不是静默丢弃", record.responses["104"]?.error?.code === -32601, JSON.stringify(record.responses["104"]));

	console.log("文档同步与诊断");
	let diag = await lsp.OPERATIONS.diag(client, { file: sample, timeoutMs: 3000 });
	check("推送式诊断收到 1 条", diag.diagnostics.length === 1, JSON.stringify(diag));
	check("诊断内容正确（含中文消息）", diag.diagnostics[0]?.message === "爆炸了");
	check("诊断模式是 push", diag.mode === "push");

	const formatted = lsp.formatDiagnostics(diag, { minSeverity: 2, max: 50 });
	check("格式化输出行列为 1-based", formatted.includes(":3:5 error: 爆炸了 [E42]"), formatted);

	console.log("改文件后重新打开并刷新诊断");
	fs.writeFileSync(sample, ["第一行 中文内容", "second", "  一切正常", "def 目标方法():", "  pass", "  调用点"].join("\n"));
	diag = await lsp.OPERATIONS.diag(client, { file: sample, timeoutMs: 3000 });
	check("内容变更后诊断清空", diag.diagnostics.length === 0, JSON.stringify(diag));
	const record2 = JSON.parse(fs.readFileSync(recordFile, "utf8"));
	check("内容变更触发了第二次 didOpen", record2.received.filter((m) => m === "textDocument/didOpen").length === 2, JSON.stringify(record2.received));
	check("重开前先发了 didClose", record2.received.includes("textDocument/didClose"), JSON.stringify(record2.received));

	console.log("内容未变时不重复重开");
	const before = JSON.parse(fs.readFileSync(recordFile, "utf8")).received.filter((m) => m === "textDocument/didOpen").length;
	client.syncDocument(sample);
	const after = JSON.parse(fs.readFileSync(recordFile, "utf8")).received.filter((m) => m === "textDocument/didOpen").length;
	check("内容一致时跳过重开", before === after, `${before} -> ${after}`);

	console.log("按符号名定位");
	const def = await lsp.OPERATIONS.def(client, { file: sample, symbol: "目标方法" });
	check("--symbol 能解析出位置并拿到定义", def.locations.length === 1, JSON.stringify(def));
	const locText = lsp.formatLocations(def.locations, "定义");
	check("定义输出为 1-based 行列", locText.includes(":6:3"), locText);

	console.log("错误路径");
	await assert.rejects(() => lsp.OPERATIONS.def(client, { file: sample, symbol: "根本不存在" }), /找不到符号/);
	check("符号不存在时报明确错误", true);

	await client.shutdown();
	fs.rmSync(workdir, { recursive: true, force: true });
	console.log(`\n通过 ${passed} 项断言${process.exitCode ? "，有失败" : "，全部通过"}`);
}

main().catch((err) => { console.error("测试崩溃:", err); process.exit(1); });
