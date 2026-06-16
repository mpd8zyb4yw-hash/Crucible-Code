// ============================================================
// Crucible — Apple Foundation Models bridge daemon (Track S)
//
// A tiny persistent HTTP server that exposes the on-device Apple
// Intelligence model (FoundationModels / ANE) over a localhost
// OpenAI-compatible endpoint. Crucible's Node server treats it
// exactly like any other provider via callLocalModel().
//
//   GET  /health                 -> { status, available, model }
//   POST /v1/chat/completions     -> OpenAI-shaped chat completion
//
// Why a daemon and not a per-request `swift` spawn:
//   The first inference in a process pays a ~2.4s model warmup.
//   Keeping one long-lived process warm drops every subsequent
//   call to ~300-600ms. Spawning per request would pay 2.4s every
//   time. So: load once, serve forever.
//
// Zero deps — uses only system frameworks (Foundation, Network,
// FoundationModels). Compile:
//   swiftc -O crucible-fm-daemon.swift -o crucible-fm-daemon
// Run:
//   ./crucible-fm-daemon            # defaults to port 11435
//   ./crucible-fm-daemon 11500      # custom port
// ============================================================

import Foundation
import Network
import FoundationModels

let PORT: UInt16 = CommandLine.arguments.count > 1
    ? (UInt16(CommandLine.arguments[1]) ?? 11435)
    : 11435

// ── Inference engine ─────────────────────────────────────────
// Serialized through an actor (one request at a time, no ANE thrash).
//
// Latency strategy — two-layer warmth:
//
//  1. Keepalive session: a single long-lived LanguageModelSession whose only
//     job is to keep the ANE loaded between requests. It fires a cheap 1-token
//     ping every 25 s so the hardware never powers down between calls.
//
//  2. Per-request sessions: each real call gets its OWN fresh session
//     (stateless — no prior-turn context bleed across Crucible tasks). Because
//     the keepalive has held the ANE warm, these sessions reach generation
//     immediately without re-loading weights; measured warm latency drops from
//     the 1.5-2.5s idle-cold range down to ~300-500ms.
//
// Why not reuse one session for actual calls?
//   LanguageModelSession accumulates transcript history. Reusing it across
//   independent user tasks would leak context from task A into task B's
//   generation. Fresh sessions per call is the correct semantic; the keepalive
//   is what buys us the warm ANE without that coupling.
actor Engine {
    // Keepalive session — holds the ANE warm, never used for real generation.
    private var keepaliveSession: LanguageModelSession? = nil
    private var keepaliveTask: Task<Void, Never>? = nil

    func available() -> (Bool, String) {
        switch SystemLanguageModel.default.availability {
        case .available:
            return (true, "ready")
        case .unavailable(let reason):
            return (false, "\(reason)")
        }
    }

    // Called once after the first successful warmup. Starts a background loop
    // that pings the keepalive session every 25 s to prevent ANE idle-sleep.
    func startKeepalive() {
        guard keepaliveTask == nil else { return }
        keepaliveSession = LanguageModelSession(instructions: "You are a latency keepalive.")
        keepaliveTask = Task { [weak keepaliveSession] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                // Lightweight ping — 1 token, discarded. Only purpose: keep ANE warm.
                _ = try? await keepaliveSession?.respond(
                    to: "ok",
                    options: GenerationOptions(maximumResponseTokens: 1)
                )
            }
        }
    }

    func generate(instructions: String, prompt: String, maxTokens: Int, temperature: Double) async -> (String, String?) {
        guard case .available = SystemLanguageModel.default.availability else {
            return ("", "model_unavailable")
        }
        // Fresh session per call — stateless, no cross-task context bleed.
        // ANE is already warm thanks to the keepalive session above.
        let session = instructions.isEmpty
            ? LanguageModelSession()
            : LanguageModelSession(instructions: instructions)
        let options = GenerationOptions(
            temperature: temperature,
            maximumResponseTokens: maxTokens > 0 ? maxTokens : nil
        )
        do {
            let response = try await session.respond(to: prompt, options: options)
            return (response.content, nil)
        } catch {
            return ("", "generation_failed: \(error.localizedDescription)")
        }
    }
}

let engine = Engine()

// ── Minimal HTTP plumbing ────────────────────────────────────
func jsonResponse(_ obj: [String: Any], status: String = "200 OK") -> Data {
    let body = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    var head = "HTTP/1.1 \(status)\r\n"
    head += "Content-Type: application/json\r\n"
    head += "Content-Length: \(body.count)\r\n"
    head += "Connection: close\r\n\r\n"
    var out = Data(head.utf8)
    out.append(body)
    return out
}

// Extract system (instructions) + concatenated user content from an
// OpenAI-style messages array.
func parseChat(_ json: [String: Any]) -> (instructions: String, prompt: String, maxTokens: Int, temperature: Double) {
    var instructions = ""
    var userParts: [String] = []
    if let messages = json["messages"] as? [[String: Any]] {
        for m in messages {
            let role = (m["role"] as? String) ?? "user"
            let content = (m["content"] as? String) ?? ""
            if role == "system" {
                instructions += (instructions.isEmpty ? "" : "\n") + content
            } else {
                userParts.append(content)
            }
        }
    }
    let maxTokens = (json["max_tokens"] as? Int) ?? 1024
    let temperature = (json["temperature"] as? Double) ?? 0.7
    return (instructions, userParts.joined(separator: "\n\n"), maxTokens, temperature)
}

func handleRequest(method: String, path: String, body: Data, completion: @escaping (Data) -> Void) {
    if method == "GET" && path.hasPrefix("/health") {
        Task {
            let (ok, detail) = await engine.available()
            completion(jsonResponse([
                "status": ok ? "ok" : "unavailable",
                "available": ok,
                "detail": detail,
                "model": "apple-fm",
                "provider": "apple-foundation-models",
            ]))
        }
        return
    }

    if method == "POST" && path.hasPrefix("/v1/chat/completions") {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let (instructions, prompt, maxTokens, temperature) = parseChat(json)
        let started = Date()
        Task {
            let (content, err) = await engine.generate(
                instructions: instructions, prompt: prompt,
                maxTokens: maxTokens, temperature: temperature
            )
            if let err = err {
                completion(jsonResponse(["error": ["message": err]], status: "503 Service Unavailable"))
                return
            }
            let latencyMs = Int(Date().timeIntervalSince(started) * 1000)
            completion(jsonResponse([
                "id": "fm-\(UUID().uuidString)",
                "object": "chat.completion",
                "model": "apple-fm",
                "choices": [[
                    "index": 0,
                    "message": ["role": "assistant", "content": content],
                    "finish_reason": "stop",
                ]],
                "usage": ["latency_ms": latencyMs, "output_tokens_est": content.count / 4],
            ]))
        }
        return
    }

    completion(jsonResponse(["error": ["message": "not_found"]], status: "404 Not Found"))
}

// ── Connection handling ──────────────────────────────────────
// Read until we have full headers (\r\n\r\n) plus Content-Length
// bytes of body, then dispatch. Our only client is Node's fetch,
// so we don't need to handle chunked encoding or keep-alive.
func handleConnection(_ conn: NWConnection) {
    conn.start(queue: .global())
    var buffer = Data()

    func receiveMore() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
            if let data = data, !data.isEmpty { buffer.append(data) }

            // Do we have the full request yet?
            if let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = buffer.subdata(in: buffer.startIndex..<headerEnd.lowerBound)
                let header = String(decoding: headerData, as: UTF8.self)
                let lines = header.split(separator: "\r\n", omittingEmptySubsequences: false)
                let requestLine = lines.first.map(String.init) ?? ""
                let parts = requestLine.split(separator: " ")
                let method = parts.count > 0 ? String(parts[0]) : "GET"
                let path = parts.count > 1 ? String(parts[1]) : "/"

                var contentLength = 0
                for line in lines.dropFirst() {
                    let l = line.lowercased()
                    if l.hasPrefix("content-length:") {
                        contentLength = Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
                    }
                }

                let bodyStart = headerEnd.upperBound
                let bodyAvailable = buffer.distance(from: bodyStart, to: buffer.endIndex)
                if bodyAvailable >= contentLength {
                    let body = buffer.subdata(in: bodyStart..<buffer.index(bodyStart, offsetBy: contentLength))
                    handleRequest(method: method, path: path, body: body) { responseData in
                        conn.send(content: responseData, completion: .contentProcessed { _ in
                            conn.cancel()
                        })
                    }
                    return
                }
            }

            if isComplete || error != nil {
                conn.cancel()
                return
            }
            receiveMore()
        }
    }
    receiveMore()
}

// ── Boot ─────────────────────────────────────────────────────
let params = NWParameters.tcp
// Bind to loopback only — never expose the model off-device.
let listener = try! NWListener(using: params, on: NWEndpoint.Port(rawValue: PORT)!)
listener.newConnectionHandler = handleConnection

listener.stateUpdateHandler = { state in
    switch state {
    case .ready:
        FileHandle.standardError.write(Data("[fm-daemon] listening on http://127.0.0.1:\(PORT)\n".utf8))
        // Warm the model immediately so the first real request is fast.
        Task {
            let (ok, detail) = await engine.available()
            FileHandle.standardError.write(Data("[fm-daemon] model availability: \(ok ? "available" : detail)\n".utf8))
            if ok {
                _ = await engine.generate(instructions: "You are terse.", prompt: "Reply with: ok", maxTokens: 8, temperature: 0)
                // Keepalive: hold ANE warm between requests (25s ping loop).
                await engine.startKeepalive()
                FileHandle.standardError.write(Data("[fm-daemon] warmup complete — keepalive active — ready\n".utf8))
            }
        }
    case .failed(let err):
        FileHandle.standardError.write(Data("[fm-daemon] failed: \(err)\n".utf8))
        exit(1)
    default:
        break
    }
}

listener.start(queue: .main)
RunLoop.main.run()
