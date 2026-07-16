import "dotenv/config";
import express from "express";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const pageDir = path.join(projectRoot, "01_页面文件");
const scriptDir = path.join(projectRoot, "02_前端脚本", "scripts");
const styleDir = path.join(projectRoot, "03_样式文件", "styles");
const assetDir = path.join(projectRoot, "05_代表性素材");
const live2dDir = path.join(projectRoot, "07_数字人组件", "live2d-widget-master");
const embeddedDashScopeApiKey = ""; // public version: set DASHSCOPE_API_KEY in environment
const embeddedDashScopeBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const app = express();
const port = Number(process.env.PORT || 3000);
const resolvedModel = String(process.env.QWEN_MODEL_ID || "qwen-max").trim() || "qwen-max";
const resolvedTtsModel = String(process.env.DASHSCOPE_TTS_MODEL || "qwen-tts-realtime").trim() || "qwen-tts-realtime";
const resolvedTtsVoiceId = String(process.env.DASHSCOPE_TTS_VOICE_ID || "Cherry").trim() || "Cherry";
const resolvedTtsRealtimeWebSocketUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const resolvedTtsInferenceWebSocketUrl = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const TTS_PCM_SAMPLE_RATE = 24000;
const TTS_PCM_CHANNELS = 1;
const TTS_PCM_BITS_PER_SAMPLE = 16;
const sessionHistoryStore = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const HISTORY_PAIR_LIMIT = 6;

function getConfigValue(name, fallbackValue = "") {
    const value = String(process.env[name] || "").trim();
    return value || fallbackValue;
}

const resolvedApiKey = readEnv("DASHSCOPE_API_KEY") || embeddedDashScopeApiKey;
const resolvedBaseUrl = getConfigValue("DASHSCOPE_BASE_URL", embeddedDashScopeBaseUrl);

const model = new ChatOpenAI({
    model: resolvedModel,
    temperature: 0.3,
    timeout: 60000,
    maxRetries: 0,
    apiKey: resolvedApiKey,
    configuration: {
        baseURL: resolvedBaseUrl
    }
});

const systemPrompt = [
    "你是数字电路仿真实验平台里的实验助手小芯。",
    "请始终使用中文回答，回答简洁、清楚、带一点教学引导。",
    "如果给了实验上下文，请优先结合上下文。",
    "如果用户是在追问，请结合之前的对话继续解释，不要把问题当成全新上下文。"
].join("");

function normalizeSessionId(rawValue) {
    const sessionId = String(rawValue || "").trim();
    return sessionId ? sessionId.slice(0, 120) : "";
}

function cleanupSessionHistory(now = Date.now()) {
    for (const [sessionId, record] of sessionHistoryStore.entries()) {
        if (!record || now - record.updatedAt > SESSION_TTL_MS) {
            sessionHistoryStore.delete(sessionId);
        }
    }
}

function getSessionRecord(sessionId) {
    if (!sessionId) {
        return null;
    }

    cleanupSessionHistory();

    const existing = sessionHistoryStore.get(sessionId);
    if (existing) {
        existing.updatedAt = Date.now();
        return existing;
    }

    const created = {
        updatedAt: Date.now(),
        messages: []
    };
    sessionHistoryStore.set(sessionId, created);
    return created;
}

function getHistoryEntries(sessionId) {
    const record = getSessionRecord(sessionId);
    return record ? record.messages.slice() : [];
}

function saveHistoryTurn(sessionId, userContent, assistantContent) {
    const record = getSessionRecord(sessionId);
    if (!record) {
        return;
    }

    record.messages.push(
        { role: "user", content: userContent },
        { role: "assistant", content: assistantContent }
    );

    const maxEntries = HISTORY_PAIR_LIMIT * 2;
    if (record.messages.length > maxEntries) {
        record.messages = record.messages.slice(-maxEntries);
    }

    record.updatedAt = Date.now();
}

function stringifyExperimentState(rawState) {
    if (typeof rawState === "string") {
        const trimmed = rawState.trim();
        if (!trimmed) {
            return "{}";
        }

        try {
            return JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch (_error) {
            return trimmed;
        }
    }

    try {
        return JSON.stringify(rawState || {}, null, 2);
    } catch (_error) {
        return "{}";
    }
}

// AI辅助参考：阿里通义千问（Qwen3.5），网页版访问，2026-04-04 18:40-19:20
// 用途：为提示词组织方式、接口调用说明和测试问答样例提供开发参考，最终结构由团队自行实现。
function buildUserPrompt(question, experimentName, experimentStateText) {
    return [
        `当前实验：${experimentName}`,
        `当前实验状态：${experimentStateText}`,
        `用户问题：${question}`
    ].join("\n");
}

// AI辅助生成：阿里通义千问（Qwen3.5），网页版访问，2026-04-02 20:10-21:00
// 用途：为数字人“小芯”的教学化回答提供语言生成参考，使问答更贴近当前实验状态与教学场景。
function buildConversationMessages({ question, experimentName, experimentState, sessionId }) {
    const experimentStateText = stringifyExperimentState(experimentState);
    const userPrompt = buildUserPrompt(question, experimentName, experimentStateText);
    const historyEntries = getHistoryEntries(sessionId);
    const messages = [new SystemMessage(systemPrompt)];

    historyEntries.forEach((entry) => {
        if (entry.role === "assistant") {
            messages.push(new AIMessage(entry.content));
            return;
        }

        messages.push(new HumanMessage(entry.content));
    });

    messages.push(new HumanMessage(userPrompt));

    return {
        messages,
        userPrompt
    };
}

function readMessageText(content) {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((part) => {
            if (typeof part === "string") {
                return part;
            }

            if (part && typeof part.text === "string") {
                return part.text;
            }

            return "";
        })
        .join("");
}

function readChunkText(chunk) {
    if (!chunk) {
        return "";
    }

    if (typeof chunk === "string") {
        return chunk;
    }

    return readMessageText(chunk.content);
}

function parseJsonSafely(text) {
    try {
        return JSON.parse(text);
    } catch (_error) {
        return null;
    }
}

function normalizeTtsNumber(value, fallbackValue, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallbackValue;
    }

    return Math.max(minimum, Math.min(maximum, parsed));
}

function maskSecret(secret) {
    const value = String(secret || "").trim();
    if (!value) {
        return "(empty)";
    }

    if (value.length <= 10) {
        return `${value.slice(0, 2)}***${value.slice(-2)}`;
    }

    return `${value.slice(0, 6)}***${value.slice(-4)}`;
}

function buildTtsInputText(text, modelId) {
    const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
    return normalizedText;
}

async function requestDashScopeTts({
    text,
    voiceId,
    modelId,
    format
}) {
    const taskId = randomUUID();
    const audioChunks = [];
    const normalizedFormat = String(format || "mp3").trim() || "mp3";

    return new Promise((resolve, reject) => {
        let settled = false;
        let taskStarted = false;
        let activeTaskId = taskId;
        let requestId = "";
        let billedCharacters = 0;

        const socket = new WebSocket(resolvedTtsInferenceWebSocketUrl, {
            headers: {
                "Authorization": `bearer ${resolvedApiKey}`,
                "X-DashScope-DataInspection": "enable",
                "user-agent": "digital-circuit-mentor/1.0"
            }
        });

        function cleanup() {
            socket.removeAllListeners();
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }
        }

        function finishWithError(error) {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            reject(error);
        }

        socket.on("open", () => {
            const parameters = {
                format: normalizedFormat,
                sample_rate: String(modelId || "").toLowerCase().includes("sambert") ? 48000 : 22050
            };

            if (voiceId) {
                parameters.voice = voiceId;
            }

            if (String(modelId || "").toLowerCase().includes("cosyvoice")) {
                parameters.text_type = "PlainText";
                parameters.volume = 50;
                parameters.rate = 0.65;
                parameters.pitch = 1;
                parameters.enable_ssml = false;
            }

            socket.send(JSON.stringify({
                header: {
                    action: "run-task",
                    task_id: taskId,
                    streaming: "duplex"
                },
                payload: {
                    task_group: "audio",
                    task: "tts",
                    function: "SpeechSynthesizer",
                    model: modelId,
                    parameters,
                    input: {}
                }
            }));
        });

        socket.on("message", (data, isBinary) => {
            if (settled) {
                return;
            }

            if (isBinary) {
                audioChunks.push(Buffer.from(data));
                return;
            }

            const rawText = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
            const payload = parseJsonSafely(rawText);

            if (!payload?.header) {
                return;
            }

            const eventName = String(payload.header.event || "").trim();
            activeTaskId = String(payload.header.task_id || activeTaskId).trim() || activeTaskId;
            requestId = String(payload.header?.attributes?.request_uuid || requestId).trim();
            billedCharacters = Number(payload.payload?.usage?.characters || billedCharacters) || billedCharacters;

            if (eventName === "task-started" && !taskStarted) {
                taskStarted = true;

                socket.send(JSON.stringify({
                    header: {
                        action: "continue-task",
                        task_id: activeTaskId,
                        streaming: "duplex"
                    },
                    payload: {
                        input: {
                            text
                        }
                    }
                }));

                setTimeout(() => {
                    if (settled || socket.readyState !== WebSocket.OPEN) {
                        return;
                    }

                        socket.send(JSON.stringify({
                            header: {
                                action: "finish-task",
                                task_id: activeTaskId,
                                streaming: "duplex"
                            },
                            payload: {
                                input: {}
                        }
                    }));
                }, 120);
                return;
            }

            if (eventName === "result-generated") {
                const audioBase64 = String(payload.payload?.output?.audio?.data || "").trim();
                if (audioBase64) {
                    audioChunks.push(Buffer.from(audioBase64, "base64"));
                }
                return;
            }

            if (eventName === "task-failed") {
                finishWithError(new Error(payload.header?.error_message || payload.header?.error_code || "TTS 任务失败"));
                return;
            }

            if (eventName === "task-finished") {
                settled = true;
                cleanup();

                const audioBuffer = Buffer.concat(audioChunks);
                if (!audioBuffer.length) {
                    reject(new Error("TTS 未返回可用音频数据"));
                    return;
                }

                resolve({
                    audioBuffer,
                    audioLength: 0,
                    requestId,
                    format: normalizedFormat,
                    billedCharacters
                });
            }
        });

        socket.on("error", (error) => {
            finishWithError(error instanceof Error ? error : new Error(String(error)));
        });

        socket.on("close", (_code, reasonBuffer) => {
            if (settled) {
                return;
            }

            const reasonText = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString("utf8") : String(reasonBuffer || "");
            finishWithError(new Error(reasonText || "TTS WebSocket 连接已关闭"));
        });
    });
}

function wrapPcmAsWav(pcmBuffer, sampleRate, channelCount, bitsPerSample) {
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channelCount * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const wavHeader = Buffer.alloc(44);

    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(channelCount, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(byteRate, 28);
    wavHeader.writeUInt16LE(blockAlign, 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([wavHeader, pcmBuffer]);
}

async function requestRealtimeTts({
    text,
    voiceId,
    modelId,
    format
}) {
    const normalizedFormat = String(format || "wav").trim().toLowerCase() || "wav";

    return new Promise((resolve, reject) => {
        let settled = false;
        let requestId = "";
        let responseDone = false;
        const pcmChunks = [];
        const socket = new WebSocket(`${resolvedTtsRealtimeWebSocketUrl}?model=${encodeURIComponent(modelId)}`, {
            headers: {
                "Authorization": `Bearer ${resolvedApiKey}`,
                "X-DashScope-DataInspection": "enable",
                "user-agent": "digital-circuit-mentor/1.0"
            }
        });

        function cleanup() {
            socket.removeAllListeners();
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }
        }

        function finishWithSuccess() {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();

            const pcmBuffer = Buffer.concat(pcmChunks);
            if (!pcmBuffer.length) {
                reject(new Error("TTS 未返回可用音频数据"));
                return;
            }

            const audioBuffer = wrapPcmAsWav(
                pcmBuffer,
                TTS_PCM_SAMPLE_RATE,
                TTS_PCM_CHANNELS,
                TTS_PCM_BITS_PER_SAMPLE
            );
            const bytesPerSample = TTS_PCM_BITS_PER_SAMPLE / 8;
            const audioLength = Math.round(
                (pcmBuffer.length / (TTS_PCM_SAMPLE_RATE * TTS_PCM_CHANNELS * bytesPerSample)) * 1000
            );

            resolve({
                audioBuffer,
                audioLength,
                requestId,
                format: normalizedFormat,
                billedCharacters: text.length
            });
        }

        function finishWithError(error) {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            reject(error);
        }

        socket.on("open", () => {
            socket.send(JSON.stringify({
                type: "session.update",
                session: {
                    voice: voiceId,
                    language_type: "Auto",
                    response_format: "pcm",
                    sample_rate: TTS_PCM_SAMPLE_RATE
                }
            }));

            setTimeout(() => {
                if (settled || socket.readyState !== WebSocket.OPEN) {
                    return;
                }

                socket.send(JSON.stringify({
                    type: "input_text_buffer.append",
                    text
                }));
                socket.send(JSON.stringify({
                    type: "input_text_buffer.commit"
                }));
            }, 120);
        });

        socket.on("message", (data, isBinary) => {
            if (settled) {
                return;
            }

            if (isBinary) {
                pcmChunks.push(Buffer.from(data));
                return;
            }

            const rawText = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
            const payload = parseJsonSafely(rawText);
            if (!payload) {
                return;
            }

            requestId = String(payload.event_id || requestId).trim() || requestId;

            if (payload.type === "response.audio.delta") {
                const audioBase64 = String(payload.delta || "").trim();
                if (audioBase64) {
                    pcmChunks.push(Buffer.from(audioBase64, "base64"));
                }
                return;
            }

            if (payload.type === "response.done") {
                responseDone = true;
                finishWithSuccess();
                return;
            }

            if (payload.type === "error") {
                finishWithError(new Error(payload.error?.message || payload.error?.code || "TTS 请求失败"));
            }
        });

        socket.on("error", (error) => {
            finishWithError(error instanceof Error ? error : new Error(String(error)));
        });

        socket.on("close", (_code, reasonBuffer) => {
            if (settled) {
                return;
            }

            const reasonText = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString("utf8") : String(reasonBuffer || "");
            if (responseDone && pcmChunks.length) {
                finishWithSuccess();
                return;
            }

            finishWithError(new Error(reasonText || "TTS WebSocket 连接已关闭"));
        });
    });
}

process.on("unhandledRejection", (error) => {
    console.error("unhandledRejection:", error);
});

process.on("uncaughtException", (error) => {
    console.error("uncaughtException:", error);
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(pageDir));
app.use(express.static(assetDir));
app.use("/scripts", express.static(scriptDir));
app.use("/styles", express.static(styleDir));
app.use("/live2d-widget-master", express.static(live2dDir));

app.get("/api/health", (_req, res) => {
    res.json({
        ok: true,
        model: resolvedModel,
        baseUrl: resolvedBaseUrl
    });
});

app.post("/api/chat", async (req, res) => {
    try {
        const question = String(req.body?.question || "").trim();
        const experimentName = String(req.body?.experimentName || "首页").trim() || "首页";
        const experimentState = req.body?.experimentState || {};
        const sessionId = normalizeSessionId(req.body?.sessionId);

        if (!question) {
            res.status(400).json({ error: "问题不能为空" });
            return;
        }

        const { messages, userPrompt } = buildConversationMessages({
            question,
            experimentName,
            experimentState,
            sessionId
        });

        const response = await model.invoke(messages);
        const answer = readMessageText(response.content).trim();

        if (answer) {
            saveHistoryTurn(sessionId, userPrompt, answer);
        }

        res.json({ answer });
    } catch (error) {
        console.error("chat error:", error);
        res.status(500).json({
            error: "调用模型失败",
            detail: error instanceof Error ? error.message : "未知错误"
        });
    }
});

app.post("/api/tts", async (req, res) => {
    const startedAt = Date.now();

    try {
        const text = String(req.body?.text || "").trim();
        const voiceId = String(req.body?.voiceId || resolvedTtsVoiceId).trim() || resolvedTtsVoiceId;
        const modelId = String(req.body?.modelId || resolvedTtsModel).trim() || resolvedTtsModel;
        const useInferenceTts = !modelId.toLowerCase().includes("qwen-tts-realtime");
        const format = useInferenceTts ? "mp3" : "wav";

        if (!text) {
            res.status(400).json({ error: "文本不能为空" });
            return;
        }

        const limitedText = text.slice(0, 1800);
        const ttsInputText = buildTtsInputText(limitedText, modelId);
        const result = useInferenceTts
            ? await requestDashScopeTts({
                text: limitedText,
                voiceId,
                modelId,
                format
            })
            : await requestRealtimeTts({
                text: ttsInputText,
                voiceId,
                modelId,
                format
            });

        res.setHeader("Content-Type", useInferenceTts ? "audio/mpeg" : "audio/wav");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", String(result.audioBuffer.length));
        res.setHeader("X-TTS-Voice-Id", voiceId);
        res.setHeader("X-TTS-Model", modelId);
        res.setHeader("X-TTS-Format", format);
        res.setHeader("X-TTS-Audio-Length", String(result.audioLength));
        if (result.requestId) {
            res.setHeader("X-DashScope-Request-Id", result.requestId);
        }

        console.log(
            `[tts] ok model=${modelId} voice=${voiceId} chars=${limitedText.length} ttsChars=${ttsInputText.length} audioMs=${result.audioLength || 0} bytes=${result.audioBuffer.length} costMs=${Date.now() - startedAt} requestId=${result.requestId || "-"}`
        );
        res.end(result.audioBuffer);
    } catch (error) {
        console.error(
            `[tts] fail model=${String(req.body?.modelId || resolvedTtsModel).trim() || resolvedTtsModel} voice=${String(req.body?.voiceId || resolvedTtsVoiceId).trim() || resolvedTtsVoiceId} costMs=${Date.now() - startedAt} detail=${error instanceof Error ? error.message : "未知错误"}`
        );
        res.status(500).json({
            error: "语音合成失败",
            detail: error instanceof Error ? error.message : "未知错误"
        });
    }
});

app.get("/api/chat/stream", async (req, res) => {
    const question = String(req.query.question || "").trim();
    const experimentName = String(req.query.experimentName || "首页").trim() || "首页";
    const experimentState = req.query.experimentState || "{}";
    const sessionId = normalizeSessionId(req.query.sessionId);

    if (!question) {
        res.status(400).json({ error: "问题不能为空" });
        return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
        const { messages, userPrompt } = buildConversationMessages({
            question,
            experimentName,
            experimentState,
            sessionId
        });

        const stream = await model.stream(messages);
        let finalText = "";

        for await (const chunk of stream) {
            const token = readChunkText(chunk);
            if (!token) {
                continue;
            }

            finalText += token;
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }

        if (finalText.trim()) {
            saveHistoryTurn(sessionId, userPrompt, finalText.trim());
        }

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (error) {
        console.error("stream error:", error);
        res.write(
            `data: ${JSON.stringify({
                error: error instanceof Error ? error.message : "流式调用失败"
            })}\n\n`
        );
        res.end();
    }
});

app.get("/", (_req, res) => {
    res.sendFile(path.join(pageDir, "index.html"));
});

app.listen(port, () => {
    console.log(`LangChain server running at http://127.0.0.1:${port}`);
    console.log(`[boot] chat model=${resolvedModel} baseUrl=${resolvedBaseUrl}`);
    console.log(`[boot] tts model=${resolvedTtsModel} voice=${resolvedTtsVoiceId} baseUrl=${resolvedBaseUrl}`);
    console.log(`[boot] apiKey=${maskSecret(resolvedApiKey)}`);
});
