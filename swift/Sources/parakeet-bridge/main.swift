import Foundation
import FluidAudio

// MARK: - JSON request/response types

struct Request: Codable {
    let id: String?
    let wav_path: String?
    let shutdown: Bool?
}

struct Response: Codable {
    let id: String?
    let ok: Bool
    let text: String?
    let elapsed_ms: Int?
    let samples: Int?
    let error: String?
}

// MARK: - stderr helpers

let stderrHandle = FileHandle.standardError

func logStderr(_ message: String) {
    if let data = (message + "\n").data(using: .utf8) {
        stderrHandle.write(data)
    }
}

func writeResponse(_ response: Response) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []
    do {
        let data = try encoder.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        // Force flush so the host (Electron main process) sees the response
        // immediately. Default stdout is line-buffered when attached to a
        // terminal but block-buffered on pipes — without this, multi-byte
        // payloads can stall in the pipe buffer.
        try? FileHandle.standardOutput.synchronize()
    } catch {
        logStderr("ERROR encoding response: \(error)")
    }
}

// MARK: - Main

@main
struct ParakeetBridge {
    static func main() async {
        logStderr("LOADING_MODEL")
        let loadStart = Date()

        let asrManager: AsrManager
        do {
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            asrManager = AsrManager(config: .default)
            try await asrManager.loadModels(models)
        } catch {
            logStderr("FATAL load error: \(error)")
            exit(1)
        }
        logStderr("MODEL_LOADED in \(String(format: "%.2f", Date().timeIntervalSince(loadStart)))s")

        // Warmup: 1 s of silence so the first user request is on a hot model.
        let warmStart = Date()
        do {
            let silence = [Float](repeating: 0, count: 16000)
            var warmupState = try TdtDecoderState()
            _ = try await asrManager.transcribe(silence, decoderState: &warmupState)
        } catch {
            logStderr("WARMUP error: \(error)")
        }
        logStderr("WARMUP_DONE in \(String(format: "%.2f", Date().timeIntervalSince(warmStart)))s")
        logStderr("READY")

        let decoder = JSONDecoder()

        // Line-delimited JSON protocol on stdin via the async byte stream.
        var buffer = [UInt8]()
        var lineCount = 0
        logStderr("stdin loop started")
        do {
            for try await byte in FileHandle.standardInput.bytes {
                if byte == 0x0a {
                    let lineData = Data(buffer)
                    buffer.removeAll(keepingCapacity: true)
                    if lineData.isEmpty { continue }
                    lineCount += 1
                    let preview = String(data: lineData.prefix(200), encoding: .utf8) ?? "<non-utf8>"
                    logStderr("recv line #\(lineCount) (\(lineData.count)B): \(preview)")
                    await handleLine(lineData, decoder: decoder, asrManager: asrManager, lineNum: lineCount)
                } else {
                    buffer.append(byte)
                }
            }
            logStderr("stdin EOF after \(lineCount) lines (buffer=\(buffer.count) leftover bytes)")
        } catch {
            logStderr("stdin read error after \(lineCount) lines: \(error)")
        }
    }

    static func handleLine(
        _ lineData: Data,
        decoder: JSONDecoder,
        asrManager: AsrManager,
        lineNum: Int
    ) async {
        let request: Request
        do {
            request = try decoder.decode(Request.self, from: lineData)
        } catch {
            logStderr("line #\(lineNum): JSON decode failed: \(error)")
            writeResponse(Response(
                id: nil, ok: false, text: nil, elapsed_ms: nil,
                samples: nil, error: "bad JSON: \(error)"
            ))
            return
        }

        if request.shutdown == true {
            logStderr("line #\(lineNum): shutdown id=\(request.id ?? "?")")
            writeResponse(Response(
                id: request.id, ok: true, text: nil, elapsed_ms: nil,
                samples: nil, error: nil
            ))
            exit(0)
        }

        guard let wavPath = request.wav_path else {
            logStderr("line #\(lineNum): missing wav_path id=\(request.id ?? "?")")
            writeResponse(Response(
                id: request.id, ok: false, text: nil, elapsed_ms: nil,
                samples: nil, error: "missing wav_path"
            ))
            return
        }

        // Verify file exists + size before invoking the model — useful when
        // the temp file write race-conditions with the IPC roundtrip.
        let fileExists = FileManager.default.fileExists(atPath: wavPath)
        let fileSize = (try? FileManager.default.attributesOfItem(atPath: wavPath)[.size] as? Int64) ?? -1
        logStderr("line #\(lineNum): id=\(request.id ?? "?") wav=\(wavPath) exists=\(fileExists) size=\(fileSize)B")

        let url = URL(fileURLWithPath: wavPath)
        let inferStart = Date()
        do {
            logStderr("line #\(lineNum): calling asrManager.transcribe…")
            var decoderState = try TdtDecoderState()
            let result = try await asrManager.transcribe(url, decoderState: &decoderState)
            let elapsed = Int(Date().timeIntervalSince(inferStart) * 1000)
            logStderr("line #\(lineNum): transcribe ok in \(elapsed)ms, text=\(result.text.count)ch, conf=\(result.confidence)")
            writeResponse(Response(
                id: request.id, ok: true, text: result.text,
                elapsed_ms: elapsed, samples: nil, error: nil
            ))
        } catch {
            let elapsed = Int(Date().timeIntervalSince(inferStart) * 1000)
            logStderr("line #\(lineNum): transcribe FAILED in \(elapsed)ms: \(error)")
            writeResponse(Response(
                id: request.id, ok: false, text: nil, elapsed_ms: nil,
                samples: nil, error: "\(error)"
            ))
        }
    }
}
