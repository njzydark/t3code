import CryptoKit
import ExpoModulesCore
import Foundation
import Network

private func relayFailure(_ message: String) -> NSError {
  NSError(domain: "T3RelayBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private final class RelayLocalConnection {
  let id = UUID().uuidString
  let socket: NWConnection
  let route: String
  var buffer = Data()
  var remaining = 0
  var chunkRemaining = 0
  var chunked = false
  var headOnly = false
  var responseChunked = false
  var websocketKey: String?
  var closed = false

  init(_ socket: NWConnection, route: String) { self.socket = socket; self.route = route }

  func receive() async throws {
    let bytes: Data = try await withCheckedThrowingContinuation { continuation in
      socket.receive(minimumIncompleteLength: 1, maximumLength: 60 * 1024) { data, _, complete, error in
        if let data, !data.isEmpty { continuation.resume(returning: data) }
        else { continuation.resume(throwing: error ?? relayFailure(complete ? "Connection closed." : "Read failed.")) }
      }
    }
    buffer.append(bytes)
  }

  func take(_ length: Int) async throws -> Data {
    while buffer.count < length { try await receive() }
    let data = Data(buffer.prefix(length))
    buffer = Data(buffer.dropFirst(length))
    return data
  }

  func until(_ delimiter: Data, limit: Int) async throws -> Data {
    while true {
      if let range = buffer.range(of: delimiter) {
        guard range.lowerBound <= limit else { throw relayFailure("Request headers are too large.") }
        let data = Data(buffer[..<range.lowerBound])
        buffer = Data(buffer[range.upperBound...])
        return data
      }
      guard buffer.count <= limit else { throw relayFailure("Request headers are too large.") }
      try await receive()
    }
  }

  func send(_ bytes: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      socket.send(content: bytes, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      })
    }
  }

  func readBody() async throws -> String? {
    if chunked {
      if chunkRemaining == 0 {
        let line = try await until(Data("\r\n".utf8), limit: 128)
        let size = String(decoding: line, as: UTF8.self).components(separatedBy: ";")[0]
        guard let count = Int(size, radix: 16), count >= 0 else { throw relayFailure("Invalid chunk size.") }
        chunkRemaining = count
        if count == 0 { return nil }
      }
      let length = min(chunkRemaining, 60 * 1024)
      let data = try await take(length)
      chunkRemaining -= length
      if chunkRemaining == 0 {
        guard try await take(2) == Data("\r\n".utf8) else { throw relayFailure("Invalid HTTP chunk.") }
      }
      return data.base64EncodedString()
    }
    if remaining == 0 { return nil }
    let length = min(remaining, 60 * 1024)
    let bytes = try await take(length)
    remaining -= length
    return bytes.base64EncodedString()
  }

  func sendFrame(_ data: Data, opcode: UInt8) async throws {
    guard data.count <= 16 * 1024 * 1024 else { throw relayFailure("WebSocket message is too large.") }
    var frame = Data([0x80 | opcode])
    if data.count < 126 { frame.append(UInt8(data.count)) }
    else if data.count <= 65535 {
      frame.append(126)
      frame.append(UInt8((data.count >> 8) & 255))
      frame.append(UInt8(data.count & 255))
    } else {
      frame.append(127)
      for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8((UInt64(data.count) >> shift) & 255)) }
    }
    frame.append(data)
    try await send(frame)
  }

  func readFrame() async throws -> [String: Any]? {
    var message = Data()
    var messageType: UInt8?
    while true {
      let header = [UInt8](try await take(2))
      let final = header[0] & 0x80 != 0
      let opcode = header[0] & 0x0f
      guard header[0] & 0x70 == 0, header[1] & 0x80 != 0 else { throw relayFailure("Invalid WebSocket frame.") }
      var size = UInt64(header[1] & 0x7f)
      if size == 126 { size = (try await take(2)).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } }
      else if size == 127 { size = (try await take(8)).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) } }
      guard size <= 16 * 1024 * 1024, message.count + Int(size) <= 16 * 1024 * 1024 else {
        throw relayFailure("WebSocket message is too large.")
      }
      let mask = [UInt8](try await take(4))
      var data = [UInt8](try await take(Int(size)))
      for index in data.indices { data[index] ^= mask[index % 4] }
      if opcode >= 8 {
        guard final, size <= 125 else { throw relayFailure("Invalid WebSocket control frame.") }
        if opcode == 8 { try await sendFrame(Data(data), opcode: 8); return nil }
        if opcode == 9 { try await sendFrame(Data(data), opcode: 10); continue }
        if opcode == 10 { continue }
        throw relayFailure("Unsupported WebSocket frame.")
      }
      if opcode == 1 || opcode == 2 {
        guard messageType == nil else { throw relayFailure("Invalid WebSocket fragment.") }
        messageType = opcode
      } else if opcode != 0 || messageType == nil { throw relayFailure("Invalid WebSocket fragment.") }
      message.append(contentsOf: data)
      if final { return ["data": message.base64EncodedString(), "binary": messageType == 2] }
    }
  }
}

@ExpoModule("T3RelayBridge")
public final class T3RelayBridgeModule: Module {
  private let queue = DispatchQueue(label: "t3.relay.loopback")
  private let lock = NSLock()
  private var listeners: [String: NWListener] = [:]
  private var connections: [String: RelayLocalConnection] = [:]

  private func connection(_ id: String) throws -> RelayLocalConnection {
    guard let value = lock.withLock({ connections[id] }) else { throw relayFailure("Local relay connection closed.") }
    return value
  }

  private func close(_ id: String) {
    let value = lock.withLock { connections.removeValue(forKey: id) }
    value?.socket.cancel()
    if value != nil { sendEvent("closed", ["id": id]) }
  }

  private func accept(_ socket: NWConnection, route: String) {
    let connection = RelayLocalConnection(socket, route: route)
    let accepted = lock.withLock {
      if connections.count >= 64 { return false }
      connections[connection.id] = connection
      return true
    }
    guard accepted else { socket.cancel(); return }
    socket.stateUpdateHandler = { [weak self] state in
      if case .failed = state { self?.close(connection.id) }
      if case .cancelled = state { self?.close(connection.id) }
    }
    socket.start(queue: queue)
    Task {
      do {
        let header = try await connection.until(Data("\r\n\r\n".utf8), limit: 64 * 1024)
        let lines = String(decoding: header, as: UTF8.self).components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[2] == "HTTP/1.1", first[1].hasPrefix("/"),
              !first[1].hasPrefix("//"), !first[1].contains("\\") else { throw relayFailure("Invalid HTTP request.") }
        var headers: [[String]] = []
        var names: [String: String] = [:]
        for line in lines.dropFirst() {
          guard let colon = line.firstIndex(of: ":") else { throw relayFailure("Invalid HTTP header.") }
          let name = line[..<colon].lowercased()
          let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
          guard names[name] == nil else { throw relayFailure("Duplicate HTTP header.") }
          names[name] = value
          headers.append([name, value])
        }
        connection.headOnly = first[0] == "HEAD"
        if let length = names["content-length"] {
          guard let count = Int(length), count >= 0 else { throw relayFailure("Invalid HTTP body length.") }
          connection.remaining = count
        }
        if let encoding = names["transfer-encoding"] {
          guard names["content-length"] == nil, encoding.lowercased() == "chunked" else { throw relayFailure("Invalid HTTP body encoding.") }
          connection.chunked = true
        }
        let websocket = names["upgrade"]?.lowercased() == "websocket"
        if websocket {
          guard first[0] == "GET", names["sec-websocket-version"] == "13",
                let key = names["sec-websocket-key"], Data(base64Encoded: key)?.count == 16 else { throw relayFailure("Invalid WebSocket upgrade.") }
          connection.websocketKey = key
        }
        if names["expect"]?.lowercased() == "100-continue" { try await connection.send(Data("HTTP/1.1 100 Continue\r\n\r\n".utf8)) }
        sendEvent("request", ["id": connection.id, "route": route, "method": String(first[0]),
                              "path": String(first[1]), "headers": headers, "websocket": websocket])
      } catch { close(connection.id) }
    }
  }

  public func definition() -> ModuleDefinition {
    Events("request", "closed")

    AsyncFunction("start") { (route: String) async throws -> Int in
      guard route.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { throw relayFailure("Invalid relay route.") }
      if let port = self.lock.withLock({ self.listeners[route]?.port }) { return Int(port.rawValue) }
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
      let listener = try NWListener(using: parameters)
      return try await withCheckedThrowingContinuation { continuation in
        var started = false
        listener.stateUpdateHandler = { state in
          if case .ready = state, !started, let port = listener.port {
            started = true
            self.lock.withLock { self.listeners[route] = listener }
            listener.stateUpdateHandler = nil
            continuation.resume(returning: Int(port.rawValue))
          } else if case .failed(let error) = state, !started {
            started = true
            listener.stateUpdateHandler = nil
            listener.cancel()
            continuation.resume(throwing: error)
          }
        }
        listener.newConnectionHandler = { [weak self] socket in self?.accept(socket, route: route) }
        listener.start(queue: self.queue)
      }
    }

    AsyncFunction("stop") { (route: String) in
      let state = self.lock.withLock { () -> (NWListener?, [String]) in
        (self.listeners.removeValue(forKey: route), self.connections.values.filter { $0.route == route }.map { $0.id })
      }
      state.0?.cancel()
      state.1.forEach { self.close($0) }
    }

    AsyncFunction("read") { (id: String) async throws -> String? in try await self.connection(id).readBody() }
    AsyncFunction("respond") { (id: String, status: Int, headers: [[String]]) async throws in
      let connection = try self.connection(id)
      guard (200...599).contains(status) else { throw relayFailure("Invalid HTTP status.") }
      connection.headOnly = connection.headOnly || [204, 205, 304].contains(status)
      connection.responseChunked = !connection.headOnly && !headers.contains { $0.count == 2 && $0[0].lowercased() == "content-length" }
      var head = "HTTP/1.1 \(status) Relay\r\nConnection: close\r\n"
      if connection.responseChunked { head += "Transfer-Encoding: chunked\r\n" }
      for header in headers {
        guard header.count == 2, !header[0].contains("\r"), !header[0].contains("\n"),
              !header[1].contains("\r"), !header[1].contains("\n") else { throw relayFailure("Invalid response header.") }
        if !["connection", "transfer-encoding"].contains(header[0].lowercased()) { head += "\(header[0]): \(header[1])\r\n" }
      }
      try await connection.send(Data((head + "\r\n").utf8))
    }
    AsyncFunction("write") { (id: String, base64: String) async throws in
      guard let bytes = Data(base64Encoded: base64), bytes.count <= 60 * 1024 else { throw relayFailure("Invalid response chunk.") }
      if bytes.isEmpty { return }
      let connection = try self.connection(id)
      if !connection.responseChunked { try await connection.send(bytes); return }
      var data = Data("\(String(bytes.count, radix: 16))\r\n".utf8)
      data.append(bytes)
      data.append(Data("\r\n".utf8))
      try await connection.send(data)
    }
    AsyncFunction("finish") { (id: String) async throws in
      let connection = try self.connection(id)
      if connection.responseChunked { try await connection.send(Data("0\r\n\r\n".utf8)) }
    }
    Function("close") { (id: String) in self.close(id) }
    AsyncFunction("upgrade") { (id: String, protocolName: String) async throws in
      let connection = try self.connection(id)
      guard let key = connection.websocketKey, !protocolName.contains("\r"), !protocolName.contains("\n") else { throw relayFailure("Invalid WebSocket upgrade.") }
      let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
      var head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(Data(digest).base64EncodedString())\r\n"
      if !protocolName.isEmpty { head += "Sec-WebSocket-Protocol: \(protocolName)\r\n" }
      try await connection.send(Data((head + "\r\n").utf8))
    }
    AsyncFunction("readSocket") { (id: String) async throws -> [String: Any]? in try await self.connection(id).readFrame() }
    AsyncFunction("writeSocket") { (id: String, base64: String, binary: Bool) async throws in
      guard let bytes = Data(base64Encoded: base64) else { throw relayFailure("Invalid WebSocket bytes.") }
      try await self.connection(id).sendFrame(bytes, opcode: binary ? 2 : 1)
    }
    OnDestroy {
      let state = self.lock.withLock { () -> ([NWListener], [RelayLocalConnection]) in
        let value = (Array(self.listeners.values), Array(self.connections.values))
        self.listeners.removeAll()
        self.connections.removeAll()
        return value
      }
      state.0.forEach { $0.cancel() }
      state.1.forEach { $0.socket.cancel() }
    }
  }
}
